'use strict';
/**
 * services/safetyCopilotCron.js
 *
 * SAFETY COPILOT — Cron di calcolo e alert predittivi.
 *
 * Gira ogni ora (07:00–20:00 Europe/Rome) nei giorni feriali.
 * Per ogni cantiere attivo:
 *   1. Calcola il Risk Score attuale
 *   2. Salva lo storico in DB (site_risk_scores)
 *   3. Se il rischio è salito → invia alert Telegram predittivo
 *   4. Se il rischio è sceso da rosso/giallo a verde → invia "tutto ok"
 *
 * Gira anche un "morning brief" alle 06:30 con il riepilogo della giornata.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const tg       = require('./telegram');
const { computeAllRiskScores, riskIcon } = require('./safetyCopilot');
const { getCompanyTelegramUsers }        = require('./telegramNotifications');
const { sendPushToCompany }              = require('./pushNotifications');

// ── Cache ultimo livello per cantiere (in-memory) ───────────────────────────
// Usato per rilevare transizioni (es. giallo → rosso)
const lastLevelCache = new Map(); // key: siteId → 'verde'|'giallo'|'rosso'
let cacheSeeded = false;

// ── Cooldown alert: max 1 escalation alert per cantiere per giorno ──────────
const alertSentToday = new Map(); // key: siteId → dateString 'YYYY-MM-DD'

function _canSendAlert(siteId) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  return alertSentToday.get(siteId) !== today;
}

function _markAlertSent(siteId) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  alertSentToday.set(siteId, today);
}

async function _seedCacheFromDb() {
  if (cacheSeeded) return;
  try {
    const { data } = await supabase.from('site_risk_scores')
      .select('site_id, level, computed_at')
      .order('computed_at', { ascending: false })
      .limit(500);
    const seen = new Set();
    for (const r of data || []) {
      if (seen.has(r.site_id)) continue;
      seen.add(r.site_id);
      lastLevelCache.set(r.site_id, r.level);
    }
    cacheSeeded = true;
    console.log(`[safetyCopilot] cache seedata con ${seen.size} cantieri dal DB`);
  } catch (e) {
    console.error('[safetyCopilot] errore seed cache:', e.message);
  }
}

// ── Pulizia record vecchi (>90 giorni) ──────────────────────────────────────

async function _cleanupOldScores() {
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { error, count } = await supabase.from('site_risk_scores')
    .delete({ count: 'exact' })
    .lt('computed_at', cutoff);
  if (error) console.error('[safetyCopilot] cleanup errore:', error.message);
  else if (count > 0) console.log(`[safetyCopilot] cleanup: rimossi ${count} record >90gg`);
}

// ── Strip items dalle dimensions per il salvataggio DB ──────────────────────

function _stripDimensionsForDb(dimensions) {
  const stripped = {};
  for (const [key, dim] of Object.entries(dimensions)) {
    const { items, forecast, ...rest } = dim;
    stripped[key] = rest;
  }
  return stripped;
}

// ── Job principale ──────────────────────────────────────────────────────────

async function runSafetyCopilotCheck() {
  console.log('[safetyCopilot] avvio calcolo risk scores...');
  await _seedCacheFromDb();

  const results = await computeAllRiskScores();
  if (!results.length) {
    console.log('[safetyCopilot] nessun cantiere attivo — skip');
    return;
  }

  let alertsSent = 0;
  let scoresStored = 0;

  // Raggruppa per company per invio batch
  const byCompany = new Map();
  for (const r of results) {
    if (!byCompany.has(r.companyId)) byCompany.set(r.companyId, []);
    byCompany.get(r.companyId).push(r);
  }

  for (const [companyId, siteResults] of byCompany) {
    // Salva tutti gli score in DB (dimensions strippate per risparmiare spazio)
    const records = siteResults.map(r => ({
      site_id:    r.siteId,
      company_id: r.companyId,
      score:      r.score,
      level:      r.level,
      dimensions: _stripDimensionsForDb(r.dimensions),
      computed_at: r.computedAt,
    }));

    const { error: insertErr } = await supabase
      .from('site_risk_scores')
      .insert(records);

    if (insertErr) {
      console.error(`[safetyCopilot] errore salvataggio scores company ${companyId}:`, insertErr.message);
    } else {
      scoresStored += records.length;
    }

    // Controlla transizioni e manda alert
    for (const r of siteResults) {
      const prevLevel = lastLevelCache.get(r.siteId) || 'verde';
      lastLevelCache.set(r.siteId, r.level);

      const escalated = _isEscalation(prevLevel, r.level);
      const deescalated = _isDeescalation(prevLevel, r.level);

      if (escalated && _canSendAlert(r.siteId)) {
        await _sendRiskAlert(companyId, r);
        _markAlertSent(r.siteId);
        alertsSent++;
      } else if (deescalated && r.level === 'verde' && _canSendAlert(r.siteId)) {
        await _sendRiskResolved(companyId, r);
        _markAlertSent(r.siteId);
        alertsSent++;
      }
    }
  }

  console.log(`[safetyCopilot] completato — ${scoresStored} scores salvati, ${alertsSent} alert inviati`);
}

// ── Morning Brief — 06:30 ───────────────────────────────────────────────────

async function runMorningBrief() {
  console.log('[safetyCopilot] morning brief...');
  await _seedCacheFromDb();

  const results = await computeAllRiskScores();
  if (!results.length) return;

  // Salva score in DB (così la dashboard è aggiornata dalle 06:30)
  const byCompany = new Map();
  for (const r of results) {
    if (!byCompany.has(r.companyId)) byCompany.set(r.companyId, []);
    byCompany.get(r.companyId).push(r);
    lastLevelCache.set(r.siteId, r.level);
  }

  for (const [, siteResults] of byCompany) {
    const records = siteResults.map(r => ({
      site_id: r.siteId, company_id: r.companyId, score: r.score,
      level: r.level, dimensions: _stripDimensionsForDb(r.dimensions), computed_at: r.computedAt,
    }));
    await supabase.from('site_risk_scores').insert(records).catch(() => {});
  }

  const todayIt = new Date().toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long',
  });
  const dayLabel = todayIt.charAt(0).toUpperCase() + todayIt.slice(1);

  for (const [companyId, siteResults] of byCompany) {
    try {
      const tgUsers = await getCompanyTelegramUsers(companyId);
      if (!tgUsers.length) continue;

      // Ordina: rosso prima, poi giallo, poi verde
      const sorted = [...siteResults].sort((a, b) => b.score - a.score);

      const redCount    = sorted.filter(s => s.level === 'rosso').length;
      const yellowCount = sorted.filter(s => s.level === 'giallo').length;

      // Tutto verde → silenzio. Non disturbare se va tutto bene.
      if (redCount === 0 && yellowCount === 0) continue;

      let msg = `🛡️ <b>Safety Copilot — ${dayLabel}</b>\n\n`;

      // Headline
      if (redCount > 0) {
        msg += `⚠️ <b>${redCount} cantier${redCount > 1 ? 'i' : 'e'} a rischio alto</b>\n\n`;
      } else {
        msg += `🟡 <b>${yellowCount} cantier${yellowCount > 1 ? 'i richiedono' : 'e richiede'} attenzione</b>\n\n`;
      }

      // Dettaglio solo per cantieri con problemi (non mostrare i verdi)
      const withIssues = sorted.filter(s => s.level !== 'verde');
      for (const r of withIssues) {
        msg += `${r.icon} <b>${_esc(r.siteName)}</b> — ${r.score}/100\n`;

        const problems = Object.entries(r.dimensions)
          .filter(([, dim]) => dim.severity > 20)
          .sort((a, b) => b[1].severity - a[1].severity);

        if (problems.length) {
          for (const [, dim] of problems.slice(0, 3)) {
            msg += `   └ ${dim.detail}\n`;
          }
        }
        msg += '\n';
      }

      // Footer
      msg += `<i>Prossimo aggiornamento tra 1 ora. Dettagli su palladia.net</i>`;

      // Invia a ogni utente (filtrato per cantiere)
      for (const { chatId, allowedSiteIds } of tgUsers) {
        let userMsg = msg;
        if (allowedSiteIds) {
          const allowed = new Set(allowedSiteIds);
          const userSites = sorted.filter(s => allowed.has(s.siteId));
          if (!userSites.length) continue;
          userMsg = _buildBriefForSites(userSites, dayLabel);
        }

        await tg.sendMessage(chatId, userMsg).catch(e =>
          console.error(`[safetyCopilot] morning brief errore invio a ${chatId}:`, e.message)
        );
      }

      // Push notification se ci sono rischi
      if (redCount > 0) {
        sendPushToCompany(companyId, {
          title: `🔴 ${redCount} cantier${redCount > 1 ? 'i' : 'e'} a rischio alto`,
          body:  sorted.filter(s => s.level === 'rosso').map(s => s.siteName).join(', '),
          tag:   'safety-copilot',
          url:   '/safety',
          requireInteraction: true,
        }).catch(() => {});
      }
    } catch (e) {
      console.error(`[safetyCopilot] morning brief errore company ${companyId}:`, e.message);
    }
  }

  console.log('[safetyCopilot] morning brief completato');
}

// ── Helper: costruisci brief per sottoinsieme di cantieri ───────────────────

function _buildBriefForSites(sites, dayLabel) {
  const withIssues = [...sites].filter(s => s.level !== 'verde').sort((a, b) => b.score - a.score);
  if (!withIssues.length) return null; // tutto verde → silenzio

  let msg = `🛡️ <b>Safety Copilot — ${dayLabel}</b>\n\n`;

  for (const r of withIssues) {
    msg += `${r.icon} <b>${_esc(r.siteName)}</b> — ${r.score}/100\n`;
    const problems = Object.entries(r.dimensions)
      .filter(([, dim]) => dim.severity > 20)
      .sort((a, b) => b[1].severity - a[1].severity);

    for (const [, dim] of problems.slice(0, 3)) {
      msg += `   └ ${dim.detail}\n`;
    }
    msg += '\n';
  }

  msg += `<i>Prossimo aggiornamento tra 1 ora.</i>`;
  return msg;
}

// ── Alert rischio salito ────────────────────────────────────────────────────

async function _sendRiskAlert(companyId, report) {
  const { siteId, siteName, score, level, icon, dimensions } = report;

  let msg = `${icon} <b>RISCHIO ${level.toUpperCase()} — ${_esc(siteName)}</b>\n`;
  msg += `Score: <b>${score}/100</b>\n\n`;

  msg += `<b>Cosa sta succedendo:</b>\n`;

  const problems = Object.entries(dimensions)
    .filter(([, dim]) => dim.severity > 20)
    .sort((a, b) => b[1].severity - a[1].severity);

  const dimLabels = {
    compliance:     '📋 Documenti',
    weather:        '🌧️ Meteo',
    fatigue:        '⏰ Fatica',
    attendance:     '👥 Presenze',
    nonConformity:  '⚠️ NC aperte',
    subcontractors: '🏗️ Subappaltatori',
  };

  for (const [key, dim] of problems) {
    msg += `${dimLabels[key] || key}: ${dim.detail}\n`;
  }

  msg += `\n<b>Cosa fare:</b>\n`;

  // Suggerimenti specifici basati sulle dimensioni attive
  for (const [key, dim] of problems.slice(0, 2)) {
    const suggestion = _getSuggestion(key, dim);
    if (suggestion) msg += `→ ${suggestion}\n`;
  }

  msg += `\n<i>Dettagli completi su palladia.net/cantieri/${siteId}</i>`;

  const tgUsers = await getCompanyTelegramUsers(companyId);
  for (const { chatId, allowedSiteIds } of tgUsers) {
    if (allowedSiteIds && !allowedSiteIds.includes(siteId)) continue;
    await tg.sendMessage(chatId, msg).catch(e =>
      console.error(`[safetyCopilot] alert errore invio a ${chatId}:`, e.message)
    );
  }

  sendPushToCompany(companyId, {
    title: `${icon} Rischio ${level} — ${siteName}`,
    body:  problems.map(([, d]) => d.detail).join(' · ').slice(0, 120),
    tag:   `risk-${siteId}`,
    url:   `/cantieri/${siteId}`,
    requireInteraction: level === 'rosso',
  }).catch(() => {});
}

// ── Alert rischio sceso ─────────────────────────────────────────────────────

async function _sendRiskResolved(companyId, report) {
  const msg =
    `✅ <b>${_esc(report.siteName)} — Rischio rientrato</b>\n\n` +
    `Score attuale: <b>${report.score}/100</b> 🟢\n` +
    `Tutti i parametri sono nella norma.`;

  const tgUsers = await getCompanyTelegramUsers(companyId);
  for (const { chatId, allowedSiteIds } of tgUsers) {
    if (allowedSiteIds && !allowedSiteIds.includes(report.siteId)) continue;
    await tg.sendMessage(chatId, msg).catch(() => {});
  }
}

// ── Suggerimenti predittivi ─────────────────────────────────────────────────

function _getSuggestion(dimKey, dim) {
  switch (dimKey) {
    case 'compliance':
      if (dim.expiredCount > 0) return `Aggiorna ${dim.expiredCount} document${dim.expiredCount > 1 ? 'i scaduti' : 'o scaduto'} prima di riprendere i lavori`;
      if (dim.expiringCount > 0) return `Rinnova ${dim.expiringCount} document${dim.expiringCount > 1 ? 'i' : 'o'} entro la settimana`;
      if (dim.missingCount > 0) return `Carica i documenti mancanti per ${dim.missingCount} lavorator${dim.missingCount > 1 ? 'i' : 'e'}`;
      return null;

    case 'weather':
      if (dim.alerts?.length) return `Valuta la sospensione delle attività in quota o all'aperto`;
      return null;

    case 'fatigue':
      if (dim.maxHours >= FATIGUE_HOURS_CRITICAL) return `Organizza il ricambio turni — lavoratori oltre le ${FATIGUE_HOURS_CRITICAL}h`;
      return `Monitora i lavoratori con orario prolungato`;

    case 'attendance':
      return `Verifica le assenze impreviste e redistribuisci i carichi`;

    case 'nonConformity':
      if (dim.critica > 0) return `Risolvi le NC critiche immediatamente — rischio contestazione ASL`;
      if (dim.alta > 0) return `Chiudi le NC alte entro 48h`;
      return null;

    case 'subcontractors':
      if (dim.expiredCount > 0) return `Blocca i subappaltatori con documenti scaduti`;
      return `Sollecita il rinnovo dei documenti in scadenza`;

    default:
      return null;
  }
}

const FATIGUE_HOURS_CRITICAL = 12;

// ── Transizioni ─────────────────────────────────────────────────────────────

const LEVEL_RANK = { verde: 0, giallo: 1, rosso: 2 };

function _isEscalation(prev, curr) {
  return (LEVEL_RANK[curr] ?? 0) > (LEVEL_RANK[prev] ?? 0);
}

function _isDeescalation(prev, curr) {
  return (LEVEL_RANK[curr] ?? 0) < (LEVEL_RANK[prev] ?? 0);
}

// ── Escape HTML ─────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Registra i cron ─────────────────────────────────────────────────────────

function startSafetyCopilotCron() {
  // Morning brief — 06:30 lun-ven
  cron.schedule('30 6 * * 1-5', async () => {
    try { await runMorningBrief(); }
    catch (e) { console.error('[safetyCopilot] morning brief errore:', e.message); }
  }, { timezone: 'Europe/Rome' });

  // Check orario — ogni ora dalle 08 alle 19, lun-sab
  cron.schedule('0 8-19 * * 1-6', async () => {
    try { await runSafetyCopilotCheck(); }
    catch (e) { console.error('[safetyCopilot] check errore:', e.message); }
  }, { timezone: 'Europe/Rome' });

  // Cleanup record >90gg — ogni domenica alle 03:00
  cron.schedule('0 3 * * 0', async () => {
    try { await _cleanupOldScores(); }
    catch (e) { console.error('[safetyCopilot] cleanup errore:', e.message); }
  }, { timezone: 'Europe/Rome' });

  console.log('[cron] safety-copilot attivo — morning brief 06:30 lun-ven, check orario 08-19 lun-sab, cleanup dom 03:00');
}

module.exports = {
  startSafetyCopilotCron,
  runSafetyCopilotCheck,
  runMorningBrief,
};
