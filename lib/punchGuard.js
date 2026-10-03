'use strict';
// ── Conferma prima di una timbratura sospetta (F-266, AUDIT.md del frontend) ──
// Caso reale: Binozi Armand, 29/09/2026 — entrata 07:38, uscita 07:45 (secondo
// tocco sul badge), "entrata" alle 17:01 credendo di uscire. Il server
// accettava tutto.
//
// Regola del titolare (2026-10-03): all'operaio AL MASSIMO UNA domanda, solo
// nel momento raro e pericoloso, e il suo tasto grande non scrive mai niente.
// Quindi PRIMA di punch_atomic si chiede conferma in un solo caso:
//   SHORT_EXIT  la timbratura sarebbe un'uscita meno di 30 minuti dopo
//               l'entrata ("Vuoi davvero uscire?" — tasto grande "No, resto
//               al lavoro", che non scrive nulla).
// Tutto il resto lo rileva il sistema DOPO la timbratura (che resta quella di
// sempre) e lo trova il titolare in Da fare → Timbrature da sistemare:
//   - turno breve confermato (alertShortShift);
//   - primo tocco nel pomeriggio di chi di solito entra la mattina (alertLateFirstEntry).
// Le domande "stai iniziando a lavorare?" (dopo un turno breve, o nel
// pomeriggio) sono state TOLTE il 2026-10-03: il loro tasto grande poteva
// scrivere un'entrata sbagliata — esattamente l'errore di partenza.
//
// punch_atomic, il pairing e le ore non cambiano: questo modulo legge soltanto.
// Un reinvio dello stesso tentativo (stesso client_request_id, F-184) e le
// timbrature sotto i 60 secondi (PUNCH_TOO_SOON) passano oltre senza domande.
const supabase = require('./supabase');

const SHORT_SHIFT_MIN = 30;
const TOO_SOON_SECS = 60; // stesso valore di punch_atomic (migrazione 208)
const STALE_ENTRY_MS = 16 * 3600 * 1000; // stesso limite di punch_atomic: oltre, l'entrata si chiude da sola
const LATE_FROM_MIN = 12 * 60;           // primo tocco dopo le 12…
const MORNING_WORKER_MIN = 11 * 60;      // …di chi di solito entra prima delle 11

const romeDay = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const romeHm = (t) => new Date(t).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const romeMin = (t) => { const [h, m] = romeHm(t).split(':').map(Number); return h * 60 + m; };
const minutesBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 60000);

/**
 * Ritorna null se la timbratura può procedere, altrimenti il corpo della
 * risposta 409 da mandare al client (che mostra la domanda all'operaio e
 * rimanda la stessa richiesta con confirmed:true).
 * In caso di errore di lettura NON blocca mai: decide punch_atomic come sempre.
 */
async function checkPunchGuard({ workerId, companyId, clientRequestId = null, now = new Date() }) {
  if (clientRequestId) {
    const { data: replay } = await supabase.from('presence_logs').select('id')
      .eq('worker_id', workerId).eq('client_request_id', clientRequestId).maybeSingle();
    if (replay) return null;
  }

  const { data: l0, error } = await supabase.from('presence_logs')
    .select('event_type, timestamp_server')
    .eq('worker_id', workerId).eq('company_id', companyId)
    .order('timestamp_server', { ascending: false }).limit(1).maybeSingle();
  if (error || !l0 || l0.event_type !== 'ENTRY') return null;
  const ageMs = now - new Date(l0.timestamp_server);
  if (ageMs / 1000 < TOO_SOON_SECS || ageMs > STALE_ENTRY_MS) return null;

  const minutes = minutesBetween(l0.timestamp_server, now);
  if (minutes >= SHORT_SHIFT_MIN) return null;
  return {
    error: 'CONFIRM_REQUIRED', reason: 'SHORT_EXIT', minutes, entry_at: l0.timestamp_server,
    message: `Sei entrato alle ${romeHm(l0.timestamp_server)}, ${minutes} minuti fa. Vuoi davvero timbrare l'uscita?`,
  };
}

/** Turno appena chiuso sotto i 30 minuti (dopo conferma): minuti e righe, altrimenti null. */
async function shortShiftJustClosed({ workerId, companyId, exitAt }) {
  const { data } = await supabase.from('presence_logs').select('id, event_type, timestamp_server')
    .eq('worker_id', workerId).eq('company_id', companyId).lte('timestamp_server', exitAt)
    .order('timestamp_server', { ascending: false }).limit(2);
  const [exit, entry] = data || [];
  if (exit?.event_type !== 'EXIT' || entry?.event_type !== 'ENTRY') return null;
  const minutes = minutesBetween(entry.timestamp_server, exitAt);
  return minutes < SHORT_SHIFT_MIN ? { minutes, entryAt: entry.timestamp_server, entryLogId: entry.id, exitLogId: exit.id } : null;
}

/**
 * Dopo un'uscita riuscita: se ha chiuso un turno sotto i 30 minuti, il titolare
 * lo trova in Da fare → Timbrature da sistemare (+ Telegram). Fire-and-forget:
 * non deve mai ritardare né far fallire la risposta della timbratura.
 */
function alertShortShift({ workerId, companyId, workerName, siteId, siteName, exitAt }) {
  shortShiftJustClosed({ workerId, companyId, exitAt })
    .then((s) => {
      if (!s) return;
      require('./presenceFix').createFixRequest({
        company_id: companyId, worker_id: workerId, site_id: siteId, kind: 'short_shift', day: romeDay(exitAt),
        entry_log_id: s.entryLogId, entry_at: s.entryAt, exit_log_id: s.exitLogId, exit_at: exitAt,
      });
      const { notifyAnomalousPunch } = require('../services/telegramNotifications');
      return notifyAnomalousPunch(companyId, siteId, siteName, workerName, 'EXIT', exitAt,
        { reason: 'short_shift', minutes: s.minutes, entry_hm: romeHm(s.entryAt) });
    })
    .catch((e) => console.error('[punchGuard] alertShortShift error:', e.message));
}

/**
 * Dopo un'ENTRATA riuscita: se è il primo tocco di oggi, dopo le 12, di un
 * operaio che di solito entra prima delle 11, forse ha dimenticato l'entrata
 * di stamattina e questo tocco era la sua uscita. All'operaio non si chiede
 * niente: il titolare trova il caso in Da fare ("È giusta" / "Correggi").
 * Fire-and-forget, sola lettura + un caso: la timbratura è già scritta.
 * @returns {Promise<boolean>} true se ha aperto il caso (per i test)
 */
async function noteLateFirstEntry({ workerId, companyId, siteId, entryAt }) {
  try {
    if (romeMin(entryAt) < LATE_FROM_MIN) return false;
    const day = romeDay(entryAt);
    const { data: todayLogs, error } = await supabase.from('presence_logs').select('id, timestamp_server')
      .eq('worker_id', workerId).eq('company_id', companyId)
      .gte('timestamp_server', new Date(Date.parse(entryAt) - 24 * 3600 * 1000).toISOString())
      .lte('timestamp_server', new Date(Date.parse(entryAt) + 1000).toISOString()).order('timestamp_server');
    if (error) return false;
    // Confronto per istanti (lo stesso orario può arrivare scritto in formati diversi)
    const at = Date.parse(entryAt);
    const earlierToday = (todayLogs || []).filter(l => romeDay(l.timestamp_server) === day && Date.parse(l.timestamp_server) < at - 1000);
    if (earlierToday.length) return false;
    const entryLog = (todayLogs || []).find(l => Math.abs(Date.parse(l.timestamp_server) - at) < 1000) || null;
    const { usualTimesFor, romeAt } = require('./usualTimes');
    const usualEntry = (await usualTimesFor(companyId, [workerId], { today: day })).get(workerId)?.entryMin ?? null;
    if (usualEntry == null || usualEntry >= MORNING_WORKER_MIN) return false;
    return await require('./presenceFix').createFixRequest({
      company_id: companyId, worker_id: workerId, site_id: siteId, kind: 'late_entry', day,
      entry_log_id: entryLog?.id || null, touch_at: entryAt, proposed_at: romeAt(day, usualEntry),
    });
  } catch (e) {
    console.error('[punchGuard] noteLateFirstEntry error:', e.message);
    return false;
  }
}

module.exports = { checkPunchGuard, alertShortShift, shortShiftJustClosed, noteLateFirstEntry, SHORT_SHIFT_MIN };
