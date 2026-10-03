'use strict';
/**
 * services/exitReminderCron.js — promemoria uscita (mockup "Timbrature senza
 * errori", approvato il 2026-10-03).
 *
 * Ogni 10 minuti, tra le 12 e le 22 (ora italiana):
 *   1. chi risulta ancora AL LAVORO 30 minuti dopo il SUO orario d'uscita
 *      abituale (lib/usualTimes.js) riceve una notifica sul telefono:
 *      "Hai finito? Tocca qui per timbrare l'uscita" (apre il suo badge);
 *   2. se dopo un'altra ora non ha ancora timbrato, il titolare trova il caso
 *      in Da fare → Timbrature da sistemare, con l'uscita già proposta.
 * Una volta sola per entrata (presence_reminders, migrazione 235). Nessuna
 * timbratura scritta qui: il cron delle 20 (missingExitCron) resta com'è.
 * Niente promemoria a chi lavora di notte (uscita abituale non dopo l'entrata)
 * o a chi è entrato dopo il suo orario d'uscita (straordinario serale).
 */
const cron = require('node-cron');
const supabase = require('../lib/supabase');
const { usualTimesFor, romeDay, romeMinutes, romeAt, hhmm } = require('../lib/usualTimes');
const { createFixRequest } = require('../lib/presenceFix');

const REMIND_AFTER_MIN = 30;
const OWNER_AFTER_MIN = 90;
const STALE_ENTRY_MS = 16 * 3600 * 1000;
const WINDOW_FROM_MIN = 12 * 60;
const WINDOW_TO_MIN = 22 * 60;

/**
 * Decisione pura (testabile): per ogni entrata aperta, cosa fare adesso.
 * open: [{ workerId, entryLogId, entryAt }]; usual: Map workerId → { exitMin }
 * sent: Set di `${entryLogId}|${kind}` già mandati.
 */
function decide({ open, usual, nowMin, sent }) {
  const out = [];
  for (const o of open) {
    const exitMin = usual.get(o.workerId)?.exitMin;
    if (exitMin == null) continue;                       // nessun orario abituale: nessun promemoria
    const entryMin = romeMinutes(o.entryAt);
    if (exitMin <= entryMin + 60) continue;               // notte / straordinario serale
    if (nowMin >= exitMin + REMIND_AFTER_MIN && !sent.has(`${o.entryLogId}|exit_reminder`)) out.push({ ...o, kind: 'exit_reminder', exitMin });
    if (nowMin >= exitMin + OWNER_AFTER_MIN && !sent.has(`${o.entryLogId}|exit_owner_alert`)) out.push({ ...o, kind: 'exit_owner_alert', exitMin });
  }
  return out;
}

/** Entrate aperte di oggi: ultimo evento del lavoratore = ENTRY di oggi (non vecchia). */
async function openEntriesToday(now = new Date()) {
  const today = romeDay(now);
  const since = romeAt(today, 0);
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from('presence_logs')
      .select('id, company_id, worker_id, site_id, event_type, timestamp_server')
      .gte('timestamp_server', since).order('timestamp_server').range(from, from + 999);
    if (error) throw new Error(`openEntriesToday: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  const last = new Map();
  for (const l of all) last.set(l.worker_id, l);
  return [...last.values()]
    .filter(l => l.event_type === 'ENTRY' && (now - new Date(l.timestamp_server)) < STALE_ENTRY_MS)
    .map(l => ({ companyId: l.company_id, workerId: l.worker_id, siteId: l.site_id, entryLogId: l.id, entryAt: l.timestamp_server }));
}

async function runExitReminders(now = new Date()) {
  const nowMin = romeMinutes(now);
  if (nowMin < WINDOW_FROM_MIN || nowMin > WINDOW_TO_MIN) return { skipped: 'fuori orario' };
  const open = await openEntriesToday(now);
  if (!open.length) return { reminders: 0, alerts: 0 };

  const { data: sentRows } = await supabase.from('presence_reminders').select('entry_log_id, kind').in('entry_log_id', open.map(o => o.entryLogId));
  const sent = new Set((sentRows || []).map(r => `${r.entry_log_id}|${r.kind}`));
  const today = romeDay(now);
  let reminders = 0, alerts = 0;

  const byCompany = new Map();
  for (const o of open) { if (!byCompany.has(o.companyId)) byCompany.set(o.companyId, []); byCompany.get(o.companyId).push(o); }
  for (const [companyId, list] of byCompany) {
    let usual;
    try { usual = await usualTimesFor(companyId, list.map(o => o.workerId), { today }); } catch (e) { console.error('[exit-reminder]', e.message); continue; }
    const todo = decide({ open: list, usual, nowMin, sent });
    if (!todo.length) continue;
    const { data: ws } = await supabase.from('workers').select('id, full_name, badge_code, is_active').in('id', [...new Set(todo.map(t => t.workerId))]);
    const workers = new Map((ws || []).map(w => [w.id, w]));
    const { data: ss } = await supabase.from('sites').select('id, name').in('id', [...new Set(todo.map(t => t.siteId).filter(Boolean))]);
    const sites = new Map((ss || []).map(s => [s.id, s.name]));

    for (const t of todo) {
      const w = workers.get(t.workerId);
      if (!w?.is_active) continue;
      // Prima si segna (UNIQUE entry_log_id+kind): due giri sovrapposti non mandano due volte
      const { error: insErr } = await supabase.from('presence_reminders').insert({ company_id: companyId, worker_id: t.workerId, entry_log_id: t.entryLogId, kind: t.kind });
      if (insErr) continue;
      if (t.kind === 'exit_reminder') {
        const { sendPushToWorker } = require('./pushNotifications');
        const site = sites.get(t.siteId);
        const pushed = await sendPushToWorker(t.workerId, {
          // Senza nome: in anagrafica l'ordine nome/cognome non è uniforme
          title: 'Hai finito di lavorare?',
          body: `Risulti ancora al lavoro dalle ${hhmm(romeMinutes(t.entryAt))}${site ? ` in ${site}` : ''}. Tocca qui per timbrare l'uscita.`,
          url: `/timbratura/${w.badge_code}`,
          tag: 'exit-reminder',
          requireInteraction: true,
        }).catch((e) => { console.error('[exit-reminder] push', e.message); return 0; });
        await supabase.from('presence_reminders').update({ pushed: pushed || 0 }).eq('entry_log_id', t.entryLogId).eq('kind', 'exit_reminder');
        reminders++;
      } else {
        const proposed = romeAt(today, t.exitMin);
        await createFixRequest({
          company_id: companyId, worker_id: t.workerId, site_id: t.siteId, kind: 'missing_exit', day: today,
          entry_log_id: t.entryLogId, entry_at: t.entryAt,
          proposed_at: new Date(proposed) > new Date(t.entryAt) && new Date(proposed) <= now ? proposed : null,
        });
        alerts++;
      }
    }
  }
  return { reminders, alerts };
}

function startExitReminderCron() {
  cron.schedule('*/10 * * * *', () => {
    runExitReminders().then((r) => { if (r.reminders || r.alerts) console.log('[exit-reminder]', JSON.stringify(r)); })
      .catch((e) => console.error('[exit-reminder] error:', e.message));
  }, { timezone: 'Europe/Rome' });
  console.log('[exit-reminder] cron avviato (ogni 10 min, 12–22)');
}

module.exports = { startExitReminderCron, runExitReminders, decide, openEntriesToday };
