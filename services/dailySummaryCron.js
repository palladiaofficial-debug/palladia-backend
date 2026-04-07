'use strict';
/**
 * services/dailySummaryCron.js
 *
 * Briefing mattutino: ogni giorno alle 07:30 (Europe/Rome).
 * Invia via Telegram solo le cose che richiedono attenzione reale oggi:
 *
 *   ☀️/🌧️ Meteo dei cantieri attivi (se GPS disponibile)
 *   🚨 NC critiche aperte (azione immediata)
 *   ⚠️  NC alte aperte (da gestire)
 *   🔴  Documenti lavoratori scaduti o in scadenza ≤14gg
 *   📊  Cantieri con budget a rischio sforamento (costi > SAL + 10%)
 *
 * Se non c'è nulla da segnalare → messaggio breve "tutto ok".
 * Nei fine settimana → inviato solo se ci sono criticità.
 *
 * Avvio: startDailySummaryCron() da server.js al boot.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { notifyCompany } = require('./telegramNotifications');
const { getForecast }   = require('./weatherService');

// ── Helpers ───────────────────────────────────────────────────

/** Differenza in giorni interi tra oggi (Europe/Rome) e una data ISO */
function daysUntil(isoDate) {
  if (!isoDate) return null;
  const today = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }));
  const exp   = new Date(isoDate);
  return Math.round((exp - today) / 86_400_000);
}

/** True se oggi è sabato o domenica (Europe/Rome) */
function isWeekend() {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'Europe/Rome', weekday: 'short' });
  return day === 'Sat' || day === 'Sun';
}

// ── Logica per company ────────────────────────────────────────

// Mappa azione → testo sintetico (mattino — passato prossimo, terza persona)
const ACTION_LABELS_MORNING = {
  reg_exits:     (p) => `registrat${(p.count ?? 0) > 1 ? 'e' : 'a'} ${p.count ?? '?'} uscit${(p.count ?? 0) > 1 ? 'e' : 'a'} mancant${(p.count ?? 0) > 1 ? 'i' : 'e'}`,
  close_nc:      ()  => 'NC segnata come risolta',
  rain_notify:   (p) => `alert pioggia inviato (${p.sent ?? '?'} dest.)`,
  heat_notify:   (p) => `allerta caldo inviata (${p.sent ?? '?'} dest.)`,
  expiry_remind: ()  => 'promemoria scadenza inviato',
};

async function buildCompanyBriefing(companyId) {
  // Data limite per scadenze (oggi + 14 giorni)
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() + 14);
  const limitStr = limitDate.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

  // Ieri (per recap azioni Ladia)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yDate     = yesterday.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const yStart    = `${yDate}T00:00:00.000Z`;
  const yEnd      = `${yDate}T23:59:59.999Z`;

  // Query parallele
  const [sitesRes, ncsRes, vociRes, expiringRes, worksiteRes, actRes, presBySiteRes] = await Promise.all([
    // Cantieri attivi (incluse coordinate per meteo)
    supabase.from('sites')
      .select('id, name, address, budget_totale, sal_percentuale, latitude, longitude')
      .eq('company_id', companyId)
      .neq('status', 'chiuso')
      .limit(30),

    // NC aperte
    supabase.from('site_notes')
      .select('site_id, urgency')
      .eq('company_id', companyId)
      .eq('category', 'non_conformita')
      .limit(500),

    // Voci economiche per check budget
    supabase.from('site_economia_voci')
      .select('site_id, tipo, importo')
      .eq('company_id', companyId)
      .limit(2000),

    // Lavoratori con scadenze imminenti o già scadute
    supabase.from('workers')
      .select('id, full_name, safety_training_expiry, health_fitness_expiry')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .or(`safety_training_expiry.lte.${limitStr},health_fitness_expiry.lte.${limitStr}`)
      .limit(200),

    // Assegnazioni attive ai cantieri
    supabase.from('worksite_workers')
      .select('site_id, worker_id')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .limit(1000),

    // Azioni Ladia di ieri
    supabase.from('ladia_action_log')
      .select('action_type, action_params, site_id')
      .eq('company_id', companyId)
      .eq('result', 'ok')
      .gte('executed_at', yStart)
      .lte('executed_at', yEnd)
      .limit(200),

    // Presenze di ieri per cantiere (per recap worker)
    supabase.from('presence_logs')
      .select('site_id, worker_id')
      .eq('company_id', companyId)
      .eq('event_type', 'ENTRY')
      .gte('timestamp_server', yStart)
      .lte('timestamp_server', yEnd)
      .limit(2000),
  ]);

  const sites    = sitesRes.data    || [];
  const ncs      = ncsRes.data      || [];
  const voci     = vociRes.data     || [];
  const expiring = expiringRes.data || [];
  const assigned = worksiteRes.data || [];
  const ystActs  = actRes.data      || [];
  const ystPres  = presBySiteRes.data || [];

  if (!sites.length) return null;

  // ── Mappe per cantiere ──
  const siteIds = new Set(sites.map(s => s.id));

  // NC per cantiere
  const ncCritBySite = {};
  const ncAlteBySite = {};
  for (const nc of ncs) {
    if (!siteIds.has(nc.site_id)) continue;
    if (nc.urgency === 'critica') ncCritBySite[nc.site_id] = (ncCritBySite[nc.site_id] || 0) + 1;
    else                          ncAlteBySite[nc.site_id] = (ncAlteBySite[nc.site_id] || 0) + 1;
  }

  // Costi per cantiere
  const costiSite = {};
  for (const v of voci) {
    if (v.tipo === 'costo') costiSite[v.site_id] = (costiSite[v.site_id] || 0) + Number(v.importo);
  }

  // Lavoratori con scadenze → mappa workerid → worker
  const expiringMap = new Map(expiring.map(w => [w.id, w]));

  // Worker scadenze per cantiere
  const expiringBySite = {};
  for (const ww of assigned) {
    if (!siteIds.has(ww.site_id)) continue;
    if (!expiringMap.has(ww.worker_id)) continue;
    if (!expiringBySite[ww.site_id]) expiringBySite[ww.site_id] = [];
    expiringBySite[ww.site_id].push(expiringMap.get(ww.worker_id));
  }

  // ── Meteo per cantieri con GPS (in parallelo) ──
  const weatherBySite = {};
  await Promise.all(
    sites
      .filter(s => s.latitude && s.longitude)
      .map(async s => {
        try {
          const forecast = await getForecast(s.latitude, s.longitude);
          weatherBySite[s.id] = forecast;
        } catch {
          // meteo non disponibile per questo cantiere — continua senza
        }
      })
  );

  // ── Costruisce le sezioni del messaggio ──
  const critical = []; // 🚨 cose urgenti oggi
  const warnings = []; // ⚠️ attenzione nelle prossime ore
  const meteoLines = []; // 🌤️ meteo cantieri

  for (const site of sites) {
    const name     = site.name || site.address || 'Cantiere';
    const ncCrit   = ncCritBySite[site.id] || 0;
    const ncAlte   = ncAlteBySite[site.id] || 0;
    const costi    = costiSite[site.id] || 0;
    const sal      = Number(site.sal_percentuale || 0);
    const budget   = Number(site.budget_totale || 0);
    const workers  = expiringBySite[site.id] || [];
    const forecast = weatherBySite[site.id];

    const siteCrit = [];
    const siteWarn = [];

    // NC
    if (ncCrit > 0) siteCrit.push(`🚨 ${ncCrit} NC critica${ncCrit > 1 ? 'he' : ''} ancora aperta${ncCrit > 1 ? 'e' : ''}`);
    if (ncAlte > 0) siteWarn.push(`⚠️ ${ncAlte} NC alta${ncAlte > 1 ? 'e' : ''} da gestire`);

    // Budget
    if (budget > 0 && costi > 0) {
      const spendPct = Math.round((costi / budget) * 100);
      if (spendPct > sal + 10) {
        siteWarn.push(`Budget consumato ${spendPct}% · SAL ${sal}% — rischio sforamento`);
      }
    }

    // Scadenze lavoratori
    for (const w of workers.slice(0, 4)) {
      const trainDays = daysUntil(w.safety_training_expiry);
      const fitDays   = daysUntil(w.health_fitness_expiry);

      if (trainDays !== null) {
        if (trainDays <= 0)
          siteCrit.push(`${w.full_name}: formazione sicurezza SCADUTA (${Math.abs(trainDays)}gg fa)`);
        else if (trainDays <= 7)
          siteWarn.push(`${w.full_name}: formazione scade tra ${trainDays}gg`);
        else if (trainDays <= 14)
          siteWarn.push(`${w.full_name}: formazione scade tra ${trainDays}gg`);
      }

      if (fitDays !== null) {
        if (fitDays <= 0)
          siteCrit.push(`${w.full_name}: idoneità sanitaria SCADUTA (${Math.abs(fitDays)}gg fa)`);
        else if (fitDays <= 14)
          siteWarn.push(`${w.full_name}: visita medica tra ${fitDays}gg`);
      }
    }

    // Meteo oggi + domani (solo se GPS disponibile)
    if (forecast?.length >= 2) {
      const fToday    = forecast[0];
      const fTomorrow = forecast[1];
      const icons     = [];
      if (fToday.isRainy || fToday.precipProb >= 40)       icons.push(`oggi ${fToday.description} (${fToday.precipProb}%)`);
      if (fTomorrow.isRainy || fTomorrow.precipProb >= 40) icons.push(`domani ${fTomorrow.description} (${fTomorrow.precipProb}%)`);
      if (icons.length) {
        meteoLines.push(`<b>${name}</b>: ${icons.join(', ')}`);
      } else if (fToday.tempMax !== null) {
        meteoLines.push(`<b>${name}</b>: ${fToday.description} (${fToday.tempMin}–${fToday.tempMax}°C)`);
      }
    }

    if (siteCrit.length) critical.push({ name, lines: siteCrit });
    if (siteWarn.length) warnings.push({ name, lines: siteWarn });
  }

  // ── Recap ieri (azioni Ladia + presenze) ──
  const siteMap = new Map(sites.map(s => [s.id, s.name || s.address || 'Cantiere']));

  // Presenze ieri per cantiere
  const ystPresCount = {};
  for (const p of ystPres) {
    if (!ystPresCount[p.site_id]) ystPresCount[p.site_id] = new Set();
    ystPresCount[p.site_id].add(p.worker_id);
  }

  // Azioni ieri per cantiere
  const ystActsBySite = {};
  for (const a of ystActs) {
    const label = ACTION_LABELS_MORNING[a.action_type]?.(a.action_params || {});
    if (!label) continue;
    const key = a.site_id || '_global';
    if (!ystActsBySite[key]) ystActsBySite[key] = [];
    ystActsBySite[key].push(label);
  }

  // Costruisci linee recap ieri
  const ystLines = [];
  const ystSiteIds = new Set([
    ...Object.keys(ystPresCount),
    ...Object.keys(ystActsBySite).filter(k => k !== '_global'),
  ]);
  for (const sid of ystSiteIds) {
    const name  = siteMap.get(sid) || 'Cantiere';
    const parts = [];
    const cnt   = ystPresCount[sid]?.size;
    if (cnt)                   parts.push(`${cnt} presence${cnt > 1 ? '' : 'a'}`);
    const acts = ystActsBySite[sid] || [];
    for (const a of acts)      parts.push(`Ladia ha ${a}`);
    if (parts.length) ystLines.push(`<b>${name}</b>: ${parts.join(' · ')}`);
  }
  // Azioni globali (senza site_id)
  for (const a of ystActsBySite['_global'] || []) {
    ystLines.push(`• Ladia ha ${a}`);
  }

  return { critical, warnings, meteoLines, ystLines };
}

// ── Formattazione messaggio ────────────────────────────────────

function buildMessage(briefing) {
  const { critical, warnings, meteoLines, ystLines } = briefing;

  const todayIt = new Date().toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const dayLabel = todayIt.charAt(0).toUpperCase() + todayIt.slice(1);

  let msg = `<b>Buongiorno — ${dayLabel}</b>\n`;

  if (ystLines?.length) {
    msg += `\n<b>Ieri:</b>\n${ystLines.join('\n')}`;
  }

  if (meteoLines?.length) {
    msg += `\n\n<b>Meteo:</b>\n` + meteoLines.join('\n');
  }

  if (!critical.length && !warnings.length) {
    msg += `\n\n✅ Nessuna criticità aperta.`;
    return msg;
  }

  if (critical.length) {
    msg += `\n\n🚨 <b>Richiede attenzione oggi:</b>`;
    for (const { name, lines } of critical) {
      msg += `\n\n<b>${name}</b>\n` + lines.map(l => `  ${l}`).join('\n');
    }
  }

  if (warnings.length) {
    msg += `\n\n⚠️ <b>Da tenere d'occhio:</b>`;
    for (const { name, lines } of warnings) {
      msg += `\n\n<b>${name}</b>\n` + lines.map(l => `  ${l}`).join('\n');
    }
  }

  return msg;
}

// ── Job principale ────────────────────────────────────────────

async function runDailySummary() {
  const weekend = isWeekend();
  console.log(`[dailySummary] avvio briefing mattutino${weekend ? ' (weekend)' : ''}`);

  const { data: tuUsers, error } = await supabase
    .from('telegram_users')
    .select('company_id')
    .limit(1000);

  if (error) {
    console.error('[dailySummary] errore fetch telegram_users:', error.message);
    return;
  }

  const companyIds = [...new Set((tuUsers || []).map(u => u.company_id))];
  if (!companyIds.length) {
    console.log('[dailySummary] nessun utente Telegram — skip');
    return;
  }

  for (const companyId of companyIds) {
    try {
      const briefing = await buildCompanyBriefing(companyId);
      if (!briefing) continue;

      // Nel weekend invia solo se ci sono critici
      if (weekend && !briefing.critical.length) continue;

      const msg = buildMessage(briefing);
      await notifyCompany(companyId, msg);

      const tot = briefing.critical.length + briefing.warnings.length;
      console.log(`[dailySummary] company ${companyId}: ${tot} cantieri con segnalazioni`);
    } catch (e) {
      console.error(`[dailySummary] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[dailySummary] completato');
}

// ── Registra il cron ──────────────────────────────────────────

function startDailySummaryCron() {
  cron.schedule('30 7 * * *', runDailySummary, { timezone: 'Europe/Rome' });
  console.log('[cron] daily-summary attivo — 07:30 Europe/Rome ogni giorno');
}

module.exports = { startDailySummaryCron, runDailySummary };
