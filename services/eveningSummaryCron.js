'use strict';
/**
 * services/eveningSummaryCron.js
 *
 * Resoconto serale — ogni giorno alle 20:30 (Europe/Rome).
 * Gira DOPO il cron uscite mancanti (20:00), così le azioni auto-eseguite
 * di Ladia sono già nel ladia_action_log e vengono incluse nel resoconto.
 *
 * SCOPO: rendere visibile tutto il lavoro fatto da Ladia oggi.
 * Non è un alert. È una conversazione: "Ecco cosa ho fatto per te oggi."
 *
 * Struttura messaggio:
 *   - Presenze di oggi per cantiere (quante persone, ore stimate)
 *   - Azioni auto-eseguite da Ladia oggi (linguaggio in prima persona)
 *   - Nuove segnalazioni aggiunte oggi (note, NC)
 *   - Anteprima di domani (meteo se disponibile)
 *
 * Se non ci sono presenze né azioni → nessun messaggio (silenzio = rispetto).
 * Nei weekend → inviato solo se ci sono state azioni o presenze.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const tg       = require('./telegram');
const { getCompanyTelegramUsers } = require('./telegramNotifications');
const { getForecast }    = require('./weatherService');

// ── Mappa azione → testo umano (prima persona) ──────────────

const ACTION_LABELS = {
  reg_exits:     (p) => `uscit${p.count > 1 ? 'e' : 'a'} mancant${p.count > 1 ? 'i' : 'e'} registrat${p.count > 1 ? 'e' : 'a'} automaticamente`,
  close_nc:      ()  => 'NC segnata come risolta',
  rain_notify:   (p) => `alert meteo inviato (${p.sent ?? '?'} membro${(p.sent ?? 0) > 1 ? 'i' : ''})`,
  expiry_remind: ()  => 'promemoria scadenza inviato al team',
  heat_notify:   (p) => `allerta caldo inviata (${p.sent ?? '?'} membro${(p.sent ?? 0) > 1 ? 'i' : ''})`,
};

// ── Resoconto per una company ────────────────────────────────

async function buildEveningSummary(companyId) {
  const date      = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const dayStart  = `${date}T00:00:00.000Z`;
  const dayEnd    = `${date}T23:59:59.999Z`;

  // Query parallele
  const [presRes, actRes, notesRes, sitesRes] = await Promise.all([
    // Presenze ENTRY di oggi per cantiere
    supabase.from('presence_logs')
      .select('site_id, worker_id')
      .eq('company_id', companyId)
      .eq('event_type', 'ENTRY')
      .gte('timestamp_server', dayStart)
      .lte('timestamp_server', dayEnd)
      .limit(2000),

    // Azioni Ladia eseguite oggi (auto + confermate)
    supabase.from('ladia_action_log')
      .select('action_type, action_params, site_id, result')
      .eq('company_id', companyId)
      .eq('result', 'ok')
      .gte('executed_at', dayStart)
      .lte('executed_at', dayEnd)
      .limit(200),

    // Note/NC aggiunte oggi
    supabase.from('site_notes')
      .select('site_id, category')
      .eq('company_id', companyId)
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd)
      .limit(500),

    // Cantieri attivi (per nome e meteo)
    supabase.from('sites')
      .select('id, name, address, latitude, longitude')
      .eq('company_id', companyId)
      .neq('status', 'chiuso')
      .limit(30),
  ]);

  const presences = presRes.data  || [];
  const actions   = actRes.data   || [];
  const notes     = notesRes.data || [];
  const sites     = sitesRes.data || [];

  // Niente da raccontare → silenzio
  if (!presences.length && !actions.length) return null;

  const siteMap = new Map(sites.map(s => [s.id, s.name || s.address || 'Cantiere']));

  // ── Presenze per cantiere ──
  const presCountBySite = {};
  for (const p of presences) {
    presCountBySite[p.site_id] = (presCountBySite[p.site_id] || new Set()).add(p.worker_id);
  }

  // ── Azioni Ladia per cantiere ──
  const actionsBySite = {};
  const globalActions = []; // azioni senza site_id
  for (const a of actions) {
    const label = ACTION_LABELS[a.action_type]?.(a.action_params || {});
    if (!label) continue;
    const key = a.site_id || '_global';
    if (!actionsBySite[key]) actionsBySite[key] = [];
    actionsBySite[key].push(label);
  }

  // ── Note per cantiere ──
  const ncCountBySite = {};
  const noteCountBySite = {};
  for (const n of notes) {
    if (n.category === 'non_conformita') {
      ncCountBySite[n.site_id] = (ncCountBySite[n.site_id] || 0) + 1;
    } else {
      noteCountBySite[n.site_id] = (noteCountBySite[n.site_id] || 0) + 1;
    }
  }

  // ── Meteo domani per cantieri con GPS ──
  const weatherTomorrow = {};
  await Promise.all(
    sites.filter(s => s.latitude && s.longitude).map(async s => {
      try {
        const fc = await getForecast(s.latitude, s.longitude);
        if (fc?.[1]) weatherTomorrow[s.id] = fc[1];
      } catch { /* meteo non disponibile */ }
    })
  );

  // ── Costruisci sezioni messaggio ──────────────────────────

  const siteLines      = [];
  const ladiaLines     = [];
  const tomorrowLines  = [];

  // Per ogni cantiere con attività
  const allSiteIds = new Set([
    ...Object.keys(presCountBySite),
    ...Object.keys(actionsBySite).filter(k => k !== '_global'),
    ...Object.keys(ncCountBySite),
    ...Object.keys(noteCountBySite),
  ]);

  for (const siteId of allSiteIds) {
    const name      = siteMap.get(siteId) || 'Cantiere';
    const workerSet = presCountBySite[siteId];
    const count     = workerSet?.size || 0;
    const ncCount   = ncCountBySite[siteId] || 0;
    const ntCount   = noteCountBySite[siteId] || 0;
    const siteActs  = actionsBySite[siteId] || [];

    const parts = [];
    if (count > 0) parts.push(`${count} presence${count > 1 ? ' · ' + count * 8 + 'h stimate' : ''}`);
    if (ncCount > 0) parts.push(`${ncCount} NC${ncCount > 1 ? ' nuove' : ' nuova'}`);
    if (ntCount > 0) parts.push(`${ntCount} nota${ntCount > 1 ? 'e' : ''}`);

    if (parts.length > 0) {
      siteLines.push({ siteId, text: `<b>${name}</b>: ${parts.join(' · ')}` });
    }

    for (const a of siteActs) {
      ladiaLines.push({ siteId, text: `• Ho ${a} — <b>${name}</b>` });
    }

    // Meteo domani
    const fcTom = weatherTomorrow[siteId];
    if (fcTom) {
      tomorrowLines.push({ siteId, text: `<b>${name}</b>: ${fcTom.description}${fcTom.tempMax ? ` (${fcTom.tempMin}–${fcTom.tempMax}°C)` : ''}` });
    }
  }

  // Azioni globali (senza site_id) — sempre incluse
  for (const a of actionsBySite['_global'] || []) {
    ladiaLines.push({ siteId: '_global', text: `• Ho ${a}` });
  }

  return { siteLines, ladiaLines, tomorrowLines, presCountBySite };
}

// ── Filtro per-utente ────────────────────────────────────────

function filterEveningForUser(data, allowedSiteIds) {
  if (!allowedSiteIds) return data; // owner/admin: tutto
  const allowed = new Set(allowedSiteIds);
  return {
    siteLines:    data.siteLines.filter(x => allowed.has(x.siteId)),
    ladiaLines:   data.ladiaLines.filter(x => x.siteId === '_global' || allowed.has(x.siteId)),
    tomorrowLines: data.tomorrowLines.filter(x => allowed.has(x.siteId)),
    presCountBySite: Object.fromEntries(
      Object.entries(data.presCountBySite).filter(([sid]) => allowed.has(sid))
    ),
  };
}

// ── Componi messaggio serale ─────────────────────────────────

function buildEveningMessage(data, dayLabel) {
  const { siteLines, ladiaLines, tomorrowLines, presCountBySite } = data;

  if (!siteLines.length && !ladiaLines.length) return null; // niente da dire

  let msg = `<b>Palladia — ${dayLabel}</b>\n`;

  if (siteLines.length) {
    msg += `\n<b>Cantieri oggi:</b>\n${siteLines.map(x => x.text).join('\n')}`;
  }

  if (ladiaLines.length) {
    msg += `\n\n<b>Azioni Ladia:</b>\n${ladiaLines.map(x => x.text).join('\n')}`;
  }

  if (tomorrowLines.length) {
    msg += `\n\n<b>Meteo domani:</b>\n${tomorrowLines.map(x => x.text).join('\n')}`;
  }

  const totalPresences = Object.values(presCountBySite).reduce((s, set) => s + (set.size || 0), 0);
  const totalActions   = ladiaLines.filter(x => x.siteId !== '_global').length;
  msg += `\n\n<i>${totalPresences} presenz${totalPresences !== 1 ? 'e' : 'a'} monitorate, ${totalActions} azione${totalActions !== 1 ? 'i' : 'e'} eseguite.</i>`;

  return msg;
}

// ── Job principale ────────────────────────────────────────────

async function runEveningSummary() {
  console.log('[eveningSummary] avvio resoconto serale');

  const { data: tuRows, error } = await supabase
    .from('telegram_users')
    .select('company_id')
    .limit(1000);

  if (error) {
    console.error('[eveningSummary] errore fetch telegram_users:', error.message);
    return;
  }

  const companyIds = [...new Set((tuRows || []).map(u => u.company_id))];
  if (!companyIds.length) {
    console.log('[eveningSummary] nessun utente Telegram — skip');
    return;
  }

  const todayIt = new Date().toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long',
  });
  const dayLabel = todayIt.charAt(0).toUpperCase() + todayIt.slice(1);

  let totalSent = 0;
  for (const companyId of companyIds) {
    try {
      const [rawData, tgUsers] = await Promise.all([
        buildEveningSummary(companyId),
        getCompanyTelegramUsers(companyId),
      ]);
      if (!rawData || !tgUsers.length) continue;

      for (const { chatId, allowedSiteIds } of tgUsers) {
        const filtered = filterEveningForUser(rawData, allowedSiteIds);
        const msg = buildEveningMessage(filtered, dayLabel);
        if (!msg) continue;

        await tg.sendMessage(chatId, msg).catch(e =>
          console.error(`[eveningSummary] errore invio a ${chatId}:`, e.message)
        );
        totalSent++;
      }

      console.log(`[eveningSummary] company ${companyId}: inviati a ${tgUsers.length} utenti`);
    } catch (e) {
      console.error(`[eveningSummary] errore company ${companyId}:`, e.message);
    }
  }

  console.log(`[eveningSummary] completato — ${totalSent} messaggi inviati`);
}

// ── Registra il cron ──────────────────────────────────────────

function startEveningSummaryCron() {
  // 20:30 — dopo il cron uscite mancanti (20:00)
  cron.schedule('30 20 * * *', runEveningSummary, { timezone: 'Europe/Rome' });
  console.log('[cron] evening-summary attivo — 20:30 Europe/Rome ogni giorno');
}

module.exports = { startEveningSummaryCron, runEveningSummary };
