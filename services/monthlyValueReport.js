'use strict';
/**
 * services/monthlyValueReport.js
 *
 * Layer "proof of value" — report mensile "Il tuo mese con Palladia" (impresa).
 * Il "mese" riportato è sempre l'ultimo mese solare completato (se lanciato
 * il 1° agosto, riporta luglio) — così il numero non cambia se il report
 * viene rigenerato più tardi nello stesso mese (email vs PDF on-demand).
 *
 * Riusa deliberatamente:
 *   - computeScadenzeESanzioni (services/valueMetrics.js) per "scadenze gestite"
 *     e "sanzioni evitate" nel mese — stessa logica di ri-verifica, solo filtrata
 *     per data di risoluzione nel mese.
 *   - lib/presencePairing.js per le ore di presenza (stesso algoritmo usato
 *     ovunque in piattaforma).
 *   - getCompanyAdminEmails (services/expiryHelper.js) per i destinatari.
 */

const supabase = require('../lib/supabase');
const { pairLogsByDay } = require('../lib/presencePairing');
const { computeScadenzeESanzioni } = require('./valueMetrics');
const { getCompanyAdminEmails } = require('./expiryHelper');
const { sendMonthlyValueReport } = require('./email');

const SEMAFORO_RANK = { verde: 0, giallo: 1, rosso: 2 };

// ── Semaforo attuale di una company ─────────────────────────────────────────
// Stessa logica di alert usata in routes/v1/studio.js (/studio/dashboard) e
// services/studioDigestCron.js, qui per UNA sola company invece che in loop
// su tutti i clienti di uno studio — non è stato estratto un helper condiviso
// per non toccare codice funzionante già in produzione.
async function computeCompanySemaforo(companyId) {
  const now        = new Date();
  const in30       = new Date(now.getTime() + 30 * 86_400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);
  const todayStr    = now.toISOString().slice(0, 10);
  const in30Str     = in30.toISOString().slice(0, 10);

  const [
    { data: workers }, { data: dvrs }, { data: certExpired }, { data: certSoon },
    { data: subDocs }, { data: ssorvExpired }, { data: ssorvSoon },
    { data: company }, { data: safetyRoles },
  ] = await Promise.all([
    supabase.from('workers').select('id').eq('company_id', companyId).eq('is_active', true),
    supabase.from('dvr_documents').select('id, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(1),
    supabase.from('worker_certificates').select('id').eq('company_id', companyId).is('deleted_at', null).lt('expiry_date', todayStr),
    supabase.from('worker_certificates').select('id').eq('company_id', companyId).is('deleted_at', null).gte('expiry_date', todayStr).lt('expiry_date', in30Str),
    supabase.from('subcontractor_documents').select('id, valid_until').eq('company_id', companyId),
    supabase.from('workers').select('id').eq('company_id', companyId).eq('is_active', true).not('health_fitness_expiry', 'is', null).lt('health_fitness_expiry', todayStr),
    supabase.from('workers').select('id').eq('company_id', companyId).eq('is_active', true).not('health_fitness_expiry', 'is', null).gte('health_fitness_expiry', todayStr).lt('health_fitness_expiry', in30Str),
    supabase.from('companies').select('durc_expiry, last_safety_meeting_at').eq('id', companyId).maybeSingle(),
    supabase.from('company_safety_roles').select('role_type').eq('company_id', companyId),
  ]);

  const workerCount = (workers || []).length;
  const dvr = (dvrs || [])[0];
  let critical = 0, warning = 0;

  if (!dvr && workerCount > 0) critical++;
  else if (dvr && new Date(dvr.created_at) < oneYearAgo) warning++;

  critical += (certExpired || []).length;
  warning  += (certSoon || []).length;

  for (const d of subDocs || []) {
    if (!d.valid_until) continue;
    const v = new Date(d.valid_until);
    if (v < now) critical++;
    else if (v < in30) warning++;
  }

  critical += (ssorvExpired || []).length;
  warning  += (ssorvSoon || []).length;

  if (company?.durc_expiry) {
    if (company.durc_expiry < todayStr) critical++;
    else if (company.durc_expiry < in30Str) warning++;
  }
  if (company?.last_safety_meeting_at) {
    const nextDue = new Date(new Date(company.last_safety_meeting_at).getTime() + 365 * 86_400_000);
    if (nextDue < now) warning++;
  }

  const roles = new Set((safetyRoles || []).map(r => r.role_type));
  if (workerCount > 0 && !roles.has('rspp')) warning++;

  const semaforo = critical > 0 ? 'rosso' : warning > 0 ? 'giallo' : 'verde';
  return { semaforo, criticalCount: critical, warningCount: warning };
}

// ── Snapshot mensile + delta rispetto al mese precedente ─────────────────────
async function saveSnapshotAndGetDelta(companyId, current) {
  const now = new Date();
  const thisMonthStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const prevMonthStr = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);

  await supabase.from('company_semaforo_snapshots').upsert({
    company_id: companyId, snapshot_month: thisMonthStr,
    semaforo: current.semaforo, critical_count: current.criticalCount, warning_count: current.warningCount,
  }, { onConflict: 'company_id,snapshot_month' });

  const { data: prev } = await supabase
    .from('company_semaforo_snapshots')
    .select('semaforo')
    .eq('company_id', companyId).eq('snapshot_month', prevMonthStr)
    .maybeSingle();

  if (!prev) return { available: false };

  const diff = SEMAFORO_RANK[current.semaforo] - SEMAFORO_RANK[prev.semaforo];
  return {
    available: true,
    previous:  prev.semaforo,
    trend:     diff < 0 ? 'migliorato' : diff > 0 ? 'peggiorato' : 'invariato',
  };
}

// ── Statistiche del mese riportato (ore, documenti, scadenze, sanzioni) ──────
async function computeMonthlyStats(companyId, monthStart, monthEnd) {
  const { data: logs } = await supabase
    .from('presence_logs')
    .select('worker_id, event_type, timestamp_server')
    .eq('company_id', companyId)
    .gte('timestamp_server', monthStart.toISOString())
    .lt('timestamp_server', monthEnd.toISOString())
    .order('timestamp_server', { ascending: true })
    .limit(20000);

  // Nota: un turno a cavallo del confine mese (entry nell'ultimo giorno del
  // mese precedente, exit nel mese riportato, o viceversa) può non essere
  // conteggiato — accettabile per un riepilogo indicativo, non un dato fiscale.
  const byWorker = {};
  for (const l of logs || []) (byWorker[l.worker_id] ??= []).push(l);
  let totalMs = 0;
  for (const wLogs of Object.values(byWorker)) {
    const byDay = pairLogsByDay(wLogs);
    for (const [, bucket] of byDay) {
      for (const { entry, exit } of bucket.pairs) {
        const ms = new Date(exit.timestamp_server) - new Date(entry.timestamp_server);
        if (ms > 0 && ms < 16 * 60 * 60 * 1000) totalMs += ms;
      }
    }
  }

  const [{ data: pos }, { data: exp }] = await Promise.all([
    supabase.from('pos_documents').select('id')
      .eq('company_id', companyId).gte('created_at', monthStart.toISOString()).lt('created_at', monthEnd.toISOString()),
    supabase.from('document_exports').select('id')
      .eq('company_id', companyId).gte('created_at', monthStart.toISOString()).lt('created_at', monthEnd.toISOString()),
  ]);

  const { items } = await computeScadenzeESanzioni(companyId);
  const itemsInMonth = items.filter(i => {
    const d = new Date(i.resolved_at);
    return d >= monthStart && d < monthEnd;
  });

  return {
    oreNelMese:            Math.round(totalMs / 3_600_000 * 10) / 10,
    documentiNelMese:      (pos?.length || 0) + (exp?.length || 0),
    scadenzeNelMese:       itemsInMonth.length,
    sanzioniNelMeseCents:  itemsInMonth.reduce((s, i) => s + (i.amount_min_cents || 0), 0),
  };
}

// ── "Il mese prossimo" — scadenze in arrivo nei 30 giorni successivi ─────────
async function computeUpcomingExpiries(companyId) {
  const now     = new Date();
  const in30    = new Date(now.getTime() + 30 * 86_400_000);
  const todayStr = now.toISOString().slice(0, 10);
  const in30Str  = in30.toISOString().slice(0, 10);
  const items = [];

  const { data: certs } = await supabase.from('worker_certificates')
    .select('expiry_date, workers(full_name), course_types(name)')
    .eq('company_id', companyId).is('deleted_at', null)
    .gte('expiry_date', todayStr).lt('expiry_date', in30Str);
  for (const c of certs || []) {
    items.push({ label: `${c.course_types?.name || 'Formazione'} — ${c.workers?.full_name || 'lavoratore'}`, expiry_date: c.expiry_date });
  }

  const { data: docs } = await supabase.from('company_documents')
    .select('name, ai_expiry_date').eq('company_id', companyId)
    .not('ai_expiry_date', 'is', null).gte('ai_expiry_date', todayStr).lt('ai_expiry_date', in30Str);
  for (const d of docs || []) items.push({ label: d.name, expiry_date: d.ai_expiry_date });

  const { data: company } = await supabase.from('companies').select('durc_expiry').eq('id', companyId).maybeSingle();
  if (company?.durc_expiry && company.durc_expiry >= todayStr && company.durc_expiry < in30Str) {
    items.push({ label: 'DURC impresa', expiry_date: company.durc_expiry });
  }

  const { data: subs } = await supabase.from('subcontractors')
    .select('company_name, durc_expiry, insurance_expiry, soa_expiry').eq('company_id', companyId).eq('is_active', true);
  const FIELD_LABEL = { durc_expiry: 'DURC', insurance_expiry: 'Assicurazione', soa_expiry: 'SOA' };
  for (const s of subs || []) {
    for (const f of ['durc_expiry', 'insurance_expiry', 'soa_expiry']) {
      if (s[f] && s[f] >= todayStr && s[f] < in30Str) {
        items.push({ label: `${FIELD_LABEL[f]} — ${s.company_name}`, expiry_date: s[f] });
      }
    }
  }

  const { data: wds } = await supabase.from('worker_documents')
    .select('name, expiry_date, workers(full_name)').eq('company_id', companyId)
    .not('expiry_date', 'is', null).gte('expiry_date', todayStr).lt('expiry_date', in30Str);
  for (const w of wds || []) items.push({ label: `${w.name} — ${w.workers?.full_name || 'lavoratore'}`, expiry_date: w.expiry_date });

  const { data: eqs } = await supabase.from('equipment')
    .select('type, model, insurance_expiry').eq('company_id', companyId).eq('is_active', true)
    .not('insurance_expiry', 'is', null).gte('insurance_expiry', todayStr).lt('insurance_expiry', in30Str);
  for (const e of eqs || []) items.push({ label: `Assicurazione — ${e.type}${e.model ? ' ' + e.model : ''}`, expiry_date: e.insurance_expiry });

  items.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
  return items;
}

// ── Orchestratore: dati completi del report (usato sia dall'email che dal PDF) ──
async function buildMonthlyReportData(companyId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1); // ultimo mese completato
  const monthEnd   = new Date(now.getFullYear(), now.getMonth(), 1);

  const [{ data: company }, semaforo, stats, upcoming] = await Promise.all([
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    computeCompanySemaforo(companyId),
    computeMonthlyStats(companyId, monthStart, monthEnd),
    computeUpcomingExpiries(companyId),
  ]);

  const delta = await saveSnapshotAndGetDelta(companyId, semaforo);

  return {
    companyId,
    companyName: company?.name || 'La tua impresa',
    monthLabel:  monthStart.toLocaleDateString('it-IT', { month: 'long', year: 'numeric', timeZone: 'Europe/Rome' }),
    semaforo, delta, stats, upcoming,
  };
}

// ── Invio per una singola company (usato dal cron e da /studio/digest-style trigger manuale) ──
async function sendMonthlyReportForCompany(companyId) {
  const data = await buildMonthlyReportData(companyId);

  const { oreNelMese, documentiNelMese, scadenzeNelMese } = data.stats;
  const hasSomethingToReport = oreNelMese > 0 || documentiNelMese > 0 || scadenzeNelMese > 0 || data.upcoming.length > 0;
  if (!hasSomethingToReport) return { sent: false, reason: 'no_activity' };

  const emails = await getCompanyAdminEmails(companyId);
  if (!emails.length) return { sent: false, reason: 'no_recipients' };

  for (const to of emails) {
    await sendMonthlyValueReport({ to, ...data }).catch(err =>
      console.error(`[monthlyValueReport] invio fallito per ${companyId} → ${to}:`, err.message)
    );
  }
  return { sent: true, recipients: emails.length };
}

module.exports = {
  computeCompanySemaforo,
  computeMonthlyStats,
  computeUpcomingExpiries,
  buildMonthlyReportData,
  sendMonthlyReportForCompany,
};
