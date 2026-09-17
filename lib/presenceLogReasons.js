'use strict';
/**
 * lib/presenceLogReasons.js
 *
 * Motivo di un'uscita (maltempo/malattia/permesso) — vedi migrations/217 per
 * il perché di una tabella nuova e separata da admin_audit_log.
 *
 * Regola non negoziabile di questo modulo: NIENTE qui viene mai passato a
 * lib/presencePairing.js. Queste sono etichette di sola lettura per i
 * report — leggerle non deve mai poter cambiare una coppia ENTRY/EXIT, un
 * totale ore o un'anomalia strutturale. Se un giorno qualcuno avesse
 * bisogno di farlo, è un problema di design diverso, non un'estensione di
 * questo modulo.
 */
const supabase = require('../lib/supabase');

const VALID_REASONS = ['maltempo', 'malattia', 'permesso'];
const REASON_LABEL = { maltempo: 'Uscita per maltempo', malattia: 'Uscita per malattia', permesso: 'Uscita per permesso' };

/**
 * Applica un motivo a una timbratura di uscita (append-only — un ri-tag
 * successivo è una nuova riga, non una modifica).
 * @param {{companyId, logId, reason, note, userId}} params
 * @returns {Promise<{ok:boolean, error?:string, code?:string}>}
 */
async function tagPresenceLogReason({ companyId, logId, reason, note, userId }) {
  if (!VALID_REASONS.includes(reason)) {
    return { ok: false, code: 'INVALID_REASON', error: `reason deve essere uno tra: ${VALID_REASONS.join(', ')}` };
  }

  // La timbratura deve appartenere davvero alla company e deve essere
  // un'uscita — un motivo su un'ENTRY non ha senso semantico (il "perché"
  // riguarda sempre il fatto di essersene andati).
  const { data: log, error: logErr } = await supabase
    .from('presence_logs')
    .select('id, event_type')
    .eq('id', logId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (logErr) return { ok: false, code: 'DB_ERROR', error: logErr.message };
  if (!log)   return { ok: false, code: 'PRESENCE_LOG_NOT_FOUND', error: 'Timbratura non trovata o non autorizzata.' };
  if (log.event_type !== 'EXIT') return { ok: false, code: 'NOT_AN_EXIT', error: 'Il motivo si applica solo a una timbratura di uscita.' };

  const { error: insErr } = await supabase.from('presence_log_reasons').insert({
    company_id:      companyId,
    presence_log_id: logId,
    reason,
    note:            note ? String(note).trim().slice(0, 500) : null,
    created_by:      userId || null,
  });
  if (insErr) return { ok: false, code: 'DB_ERROR', error: insErr.message };

  return { ok: true };
}

/**
 * Motivo più recente per ciascuna timbratura di un elenco — usata sia dalla
 * lettura del registro (GET /presence) sia dai generatori di report.
 * @param {string} companyId
 * @param {string[]} logIds
 * @returns {Promise<Map<string, {reason:string, label:string, note:string|null, tagged_at:string}>>}
 */
async function latestReasonsByLogId(companyId, logIds) {
  const out = new Map();
  if (!logIds?.length) return out;

  const { data } = await supabase
    .from('presence_log_reasons')
    .select('presence_log_id, reason, note, created_at')
    .eq('company_id', companyId)
    .in('presence_log_id', logIds)
    .order('created_at', { ascending: true }); // asc: l'ultima sovrascrive nella Map, senza bisogno di raggruppare a mano

  for (const row of (data || [])) {
    out.set(row.presence_log_id, {
      reason:    row.reason,
      label:     REASON_LABEL[row.reason] || row.reason,
      note:      row.note,
      tagged_at: row.created_at,
    });
  }
  return out;
}

module.exports = { tagPresenceLogReason, latestReasonsByLogId, VALID_REASONS, REASON_LABEL };
