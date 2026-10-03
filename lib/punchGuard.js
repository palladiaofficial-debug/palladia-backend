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
// punch_atomic, il pairing e le ore non cambiano: questo modulo legge soltanto.
// Un reinvio dello stesso tentativo (stesso client_request_id, F-184) e le
// timbrature sotto i 60 secondi (PUNCH_TOO_SOON) passano oltre senza domande:
// li gestisce punch_atomic come prima.
const supabase = require('./supabase');

const SHORT_SHIFT_MIN = 30;
const TOO_SOON_SECS = 60; // stesso valore di punch_atomic (migrazione 208)
const SELF_METHODS = ['worker_self_punch', 'personal_phone'];

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
  if (error || !last?.length) return null;
  const [l0, l1] = last;
  if ((now - new Date(l0.timestamp_server)) / 1000 < TOO_SOON_SECS) return null;

  if (l0.event_type === 'ENTRY') {
    const minutes = minutesBetween(l0.timestamp_server, now);
    if (minutes < SHORT_SHIFT_MIN) {
      return {
        error: 'CONFIRM_REQUIRED', reason: 'SHORT_EXIT', minutes, entry_at: l0.timestamp_server,
        message: `Sei entrato alle ${romeHm(l0.timestamp_server)}, ${minutes} minuti fa. Vuoi davvero timbrare l'uscita?`,
      };
    }
    return null;
  }

  if (l0.event_type === 'EXIT' && l1?.event_type === 'ENTRY' && SELF_METHODS.includes(l0.method)
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
  return null;
}

/** Turno appena chiuso sotto i 30 minuti (dopo conferma): minuti, altrimenti null. */
async function shortShiftJustClosed({ workerId, companyId, exitAt }) {
  const { data } = await supabase.from('presence_logs').select('event_type, timestamp_server')
    .eq('worker_id', workerId).eq('company_id', companyId).lt('timestamp_server', exitAt)
    .order('timestamp_server', { ascending: false }).limit(1).maybeSingle();
  if (data?.event_type !== 'ENTRY') return null;
  const minutes = minutesBetween(data.timestamp_server, exitAt);
  return minutes < SHORT_SHIFT_MIN ? { minutes, entryAt: data.timestamp_server } : null;
}

/** Avviso al titolare (in app): turno di pochi minuti confermato dall'operaio. */
async function notifyShortShift({ companyId, workerName, siteName, entryAt, exitAt, minutes }) {
  const { error } = await supabase.from('notifications').insert({
    company_id: companyId,
    type: 'punch_short_shift',
    severity: 'warning',
    title: `${workerName}: turno di soli ${minutes} minuti`,
    body: `Cantiere: ${siteName}. Entrata ${romeHm(entryAt)}, uscita ${romeHm(exitAt)} (${minutes} minuti), confermata dall'operaio. Se è un errore correggi da Presenze & Report → Correzione manuale.`,
    entity_type: 'punch_short_shift',
    entity_id: require('crypto').randomUUID(),
  });
  if (error) console.error('[punchGuard] notifyShortShift error:', error.message);
}

/**
 * Dopo un'uscita riuscita: se ha chiuso un turno sotto i 30 minuti, avvisa il
 * titolare (in app + Telegram). Fire-and-forget: non deve mai ritardare né
 * far fallire la risposta della timbratura.
 */
function alertShortShift({ workerId, companyId, workerName, siteId, siteName, exitAt }) {
  shortShiftJustClosed({ workerId, companyId, exitAt })
    .then((s) => {
      if (!s) return;
      notifyShortShift({ companyId, workerName, siteName, entryAt: s.entryAt, exitAt, minutes: s.minutes });
      const { notifyAnomalousPunch } = require('../services/telegramNotifications');
      return notifyAnomalousPunch(companyId, siteId, siteName, workerName, 'EXIT', exitAt,
        { reason: 'short_shift', minutes: s.minutes, entry_hm: romeHm(s.entryAt) });
    })
    .catch((e) => console.error('[punchGuard] alertShortShift error:', e.message));
}

/** Testo dell'avviso quando l'operaio risponde "No, sto andando via" (ENTRY_NOT_EXIT). */
async function entryNotExitDetails({ workerId, companyId }) {
  const { data } = await supabase.from('presence_logs').select('event_type, timestamp_server')
    .eq('worker_id', workerId).eq('company_id', companyId)
    .order('timestamp_server', { ascending: false }).limit(2);
  const [l0, l1] = data || [];
  if (l0?.event_type === 'EXIT' && l1?.event_type === 'ENTRY') {
    return `Oggi risulta entrata ${romeHm(l1.timestamp_server)} e uscita ${romeHm(l0.timestamp_server)}, ma ora l'operaio dice che sta andando via (${romeHm(new Date())}): probabilmente l'uscita delle ${romeHm(l0.timestamp_server)} è sbagliata. Correggi da Presenze & Report → Correzione manuale.`;
  }
  return `L'operaio dice che sta andando via (${romeHm(new Date())}) ma risultava già uscito. Controlla le timbrature di oggi da Presenze & Report.`;
}

module.exports = { checkPunchGuard, alertShortShift, shortShiftJustClosed, notifyShortShift, entryNotExitDetails, SHORT_SHIFT_MIN };
