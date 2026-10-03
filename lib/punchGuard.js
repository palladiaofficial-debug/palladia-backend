'use strict';
// ── Conferma prima di una timbratura sospetta (F-266, AUDIT.md del frontend) ──
// Caso reale: Binozi Armand, 29/09/2026 — entrata 07:38, uscita 07:45 (secondo
// tocco sul badge), "entrata" alle 17:01 credendo di uscire. Il server
// accettava tutto. Qui, PRIMA di chiamare punch_atomic, si chiede conferma
// all'operaio in due casi:
//   SHORT_EXIT         la prossima timbratura sarebbe un'uscita meno di 30
//                      minuti dopo l'entrata;
//   ENTRY_AFTER_SHORT  oggi c'è già stato un turno di pochi minuti (entrata e
//                      uscita a meno di 30 minuti) e ora ritimbra: sta
//                      entrando davvero o pensa di uscire?
//   LATE_FIRST_ENTRY   primo tocco della giornata nel pomeriggio (dopo le 12)
//                      di un operaio che di solito entra la mattina: sta
//                      iniziando adesso o ha dimenticato l'entrata e sta
//                      andando via? (mockup approvato il 2026-10-03)
// punch_atomic, il pairing e le ore non cambiano: questo modulo legge soltanto.
// Un reinvio dello stesso tentativo (stesso client_request_id, F-184) e le
// timbrature sotto i 60 secondi (PUNCH_TOO_SOON) passano oltre senza domande:
// li gestisce punch_atomic come prima.
const supabase = require('./supabase');
const { usualTimesFor } = require('./usualTimes');

const SHORT_SHIFT_MIN = 30;
const TOO_SOON_SECS = 60; // stesso valore di punch_atomic (migrazione 208)
const SELF_METHODS = ['worker_self_punch', 'personal_phone'];
const STALE_ENTRY_MS = 16 * 3600 * 1000; // stesso limite di punch_atomic: oltre, l'entrata si chiude da sola e il tocco è un'ENTRATA
const LATE_FROM_MIN = 12 * 60;           // primo tocco dopo le 12…
const MORNING_WORKER_MIN = 11 * 60;      // …di chi di solito entra prima delle 11
const romeMin = (t) => { const [h, m] = new Date(t).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number); return h * 60 + m; };

const romeDay = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const romeHm = (t) => new Date(t).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const minutesBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 60000);

/**
 * Ritorna null se la timbratura può procedere, altrimenti il corpo della
 * risposta 409 da mandare al client (che mostra la domanda all'operaio e
 * rimanda la stessa richiesta con confirmed:true).
 */
async function checkPunchGuard({ workerId, companyId, clientRequestId = null, now = new Date() }) {
  if (clientRequestId) {
    const { data: replay } = await supabase.from('presence_logs').select('id')
      .eq('worker_id', workerId).eq('client_request_id', clientRequestId).maybeSingle();
    if (replay) return null;
  }

  const { data: last, error } = await supabase.from('presence_logs')
    .select('event_type, timestamp_server, method')
    .eq('worker_id', workerId).eq('company_id', companyId)
    .order('timestamp_server', { ascending: false }).limit(2);
  // In caso di errore di lettura non si blocca la timbratura: decide punch_atomic come sempre
  if (error) return null;
  const [l0, l1] = last || [];
  if (l0 && (now - new Date(l0.timestamp_server)) / 1000 < TOO_SOON_SECS) return null;
  const staleEntry = l0?.event_type === 'ENTRY' && (now - new Date(l0.timestamp_server)) > STALE_ENTRY_MS;

  if (l0?.event_type === 'ENTRY' && !staleEntry) {
    const minutes = minutesBetween(l0.timestamp_server, now);
    if (minutes < SHORT_SHIFT_MIN) {
      return {
        error: 'CONFIRM_REQUIRED', reason: 'SHORT_EXIT', minutes, entry_at: l0.timestamp_server,
        message: `Sei entrato alle ${romeHm(l0.timestamp_server)}, ${minutes} minuti fa. Vuoi davvero timbrare l'uscita?`,
      };
    }
    return null;
  }

  if (l0?.event_type === 'EXIT' && l1?.event_type === 'ENTRY' && SELF_METHODS.includes(l0.method)
      && romeDay(l0.timestamp_server) === romeDay(now)) {
    const shift = minutesBetween(l1.timestamp_server, l0.timestamp_server);
    if (shift < SHORT_SHIFT_MIN) {
      return {
        error: 'CONFIRM_REQUIRED', reason: 'ENTRY_AFTER_SHORT', minutes: shift,
        entry_at: l1.timestamp_server, exit_at: l0.timestamp_server,
        message: `Oggi sei entrato alle ${romeHm(l1.timestamp_server)} e uscito alle ${romeHm(l0.timestamp_server)}. Ora stai timbrando l'ENTRATA: stai iniziando a lavorare?`,
      };
    }
  }

  // Il tocco sarà un'ENTRATA (nessuna timbratura, ultima un'uscita, o entrata
  // vecchia che punch_atomic chiude da sola) ed è il primo di oggi, nel pomeriggio
  const today = romeDay(now);
  const firstToday = !l0 || romeDay(l0.timestamp_server) < today;
  if (firstToday && romeMin(now) >= LATE_FROM_MIN) {
    let usualEntry = null;
    try { usualEntry = (await usualTimesFor(companyId, [workerId], { today })).get(workerId)?.entryMin ?? null; } catch { /* errore di lettura: nessuna domanda */ }
    // Solo se i dati dicono che di solito entra la mattina (almeno 3 giorni):
    // un neoassunto o chi lavora di pomeriggio non riceve la domanda.
    if (usualEntry != null && usualEntry < MORNING_WORKER_MIN) {
      return {
        error: 'CONFIRM_REQUIRED', reason: 'LATE_FIRST_ENTRY', now_at: now.toISOString(),
        message: `Sono le ${romeHm(now)} e oggi non hai ancora timbrato. Stai iniziando a lavorare adesso?`,
      };
    }
  }
  return null;
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
 * Dopo un'uscita riuscita: se ha chiuso un turno sotto i 30 minuti, avvisa il
 * titolare (Da fare → Timbrature da sistemare + Telegram). Fire-and-forget: non deve mai ritardare né
 * far fallire la risposta della timbratura.
 */
function alertShortShift({ workerId, companyId, workerName, siteId, siteName, exitAt }) {
  shortShiftJustClosed({ workerId, companyId, exitAt })
    .then((s) => {
      if (!s) return;
      // In Da fare → "Timbrature da sistemare" (la nuova app non ha la campanella delle notifiche)
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

module.exports = { checkPunchGuard, alertShortShift, shortShiftJustClosed, SHORT_SHIFT_MIN };
