'use strict';
const supabase = require('./supabase');
const { auditLog } = require('./audit');
const { getResource, computeSensitivity, sanitizePayload } = require('./ladiaSchemaRegistry');
const { buildSummary, logActionHistory } = require('./ladiaActionLog');

// Executor generico per i tool create_record/update_record/delete_record di
// Ladia. Nessuna dipendenza da Express/Anthropic — riusabile anche fuori dal
// loop agentico del chat web (es. Telegram, Fase 5 del piano).
//
// Ogni funzione: risolve la risorsa dal registro, sanitizza l'input con
// whitelist stretta, rifiuta strutturalmente le scritture non a basso rischio
// (RICHIEDE_CONFERMA — enforcement reale, non prompt), esegue con company_id
// iniettato server-side, e registra l'azione su admin_audit_log (trail legale
// immutabile) E su ladia_action_history (undo reale — Fase "Cursor per
// Palladia": ogni scrittura di Ladia è annullabile finché nessun altro ha
// toccato di nuovo lo stesso record).

const UNDO_WINDOW_MINUTES = 30;

async function createRecord(resourceName, rawPayload, companyId, userId, req, opts = {}) {
  const resource = getResource(resourceName);
  if (!resource) return { error: `Risorsa non gestita: ${resourceName}` };
  if (!resource.allow.create) {
    return { error: 'RISORSA_NON_GESTIBILE_GENERICAMENTE', bespoke_tools: resource.bespokeOnly?.create || [] };
  }

  const { clean, missing } = sanitizePayload(resource, rawPayload, 'create');
  if (missing.length > 0) return { error: `Campi obbligatori mancanti: ${missing.join(', ')}` };

  const sensitivity = computeSensitivity(resource, Object.keys(clean));
  if (sensitivity !== 'low' && !opts.confirmed) {
    return { error: 'RICHIEDE_CONFERMA', requires_confirmation: true, sensitivity };
  }

  if (resource.dedupeCheck) {
    const dc = resource.dedupeCheck;
    let query = supabase.from(resource.table).select(resource.pk);
    for (const field of dc.matchFields) query = query.eq(field, clean[field]);
    for (const [key, value] of Object.entries(dc.matchExtra || {})) query = query.eq(key, value);
    const { data: existing } = await query.maybeSingle();
    if (existing) return { success: true, already_exists: true, message: dc.alreadyMessage, record: existing };
  }

  const injected = resource.serverInjected ? resource.serverInjected(companyId, 'create', userId) : { company_id: companyId };
  const row = { ...clean, ...injected }; // injected sempre per ultimo: il modello non può mai sovrascriverlo

  const table = supabase.from(resource.table);
  const { data, error } = resource.conflictKey
    ? await table.upsert(row, { onConflict: resource.conflictKey }).select().single()
    : await table.insert(row).select().single();

  if (error) return { error: error.message };

  await auditLog({
    companyId, userId,
    action: opts.confirmed ? `record.create:${resourceName}:confirmed` : `record.create:${resourceName}`,
    targetType: resourceName,
    targetId: data[resource.pk],
    payload: clean,
    req,
  });

  const summary = buildSummary(resourceName, 'create', data);
  const actionHistoryId = await logActionHistory({
    companyId, userId, conversationId: opts.conversationId,
    resource, resourceName, action: 'create',
    recordId: data[resource.pk], summary,
  });

  return { success: true, record: data, actionHistoryId, undoSummary: summary, resource: resourceName, action: 'create' };
}

async function updateRecord(resourceName, recordId, rawPatch, companyId, userId, req, opts = {}) {
  const resource = getResource(resourceName);
  if (!resource) return { error: `Risorsa non gestita: ${resourceName}` };
  if (!resource.allow.update) {
    return { error: 'RISORSA_NON_GESTIBILE_GENERICAMENTE', bespoke_tools: resource.bespokeOnly?.update || [] };
  }
  if (!recordId) return { error: `${resource.pk} obbligatorio` };

  const { clean } = sanitizePayload(resource, rawPatch, 'update');
  if (Object.keys(clean).length === 0) return { error: 'Nessun campo da aggiornare specificato' };

  const sensitivity = computeSensitivity(resource, Object.keys(clean));
  if (sensitivity !== 'low' && !opts.confirmed) {
    return { error: 'RICHIEDE_CONFERMA', requires_confirmation: true, sensitivity };
  }

  // Legge i valori attuali dei soli campi che stanno per cambiare, prima di
  // scrivere — permette alla UI di mostrare un diff prima→dopo invece del solo
  // risultato finale (Fase 3 "Cursor per Palladia"). Non blocca l'update se
  // questa lettura fallisce: il diff è un arricchimento, non un requisito.
  const { data: before } = await supabase
    .from(resource.table)
    .select(Object.keys(clean).join(','))
    .eq(resource.pk, recordId)
    .eq('company_id', companyId)
    .single();

  const { data, error } = await supabase
    .from(resource.table)
    .update(clean)
    .eq(resource.pk, recordId)
    .eq('company_id', companyId)
    .select()
    .single();

  if (error) return { error: error.message };

  await auditLog({
    companyId, userId,
    action: opts.confirmed ? `record.update:${resourceName}:confirmed` : `record.update:${resourceName}`,
    targetType: resourceName,
    targetId: recordId,
    payload: clean,
    req,
  });

  const summary = buildSummary(resourceName, 'update', data);
  const actionHistoryId = await logActionHistory({
    companyId, userId, conversationId: opts.conversationId,
    resource, resourceName, action: 'update', recordId,
    previousValues: before || {}, changedFields: clean, summary,
  });

  return { success: true, record: data, previous: before || {}, actionHistoryId, undoSummary: summary, resource: resourceName, action: 'update' };
}

async function deleteRecord(resourceName, recordId, companyId, userId, req, opts = {}) {
  const resource = getResource(resourceName);
  if (!resource) return { error: `Risorsa non gestita: ${resourceName}` };
  if (!resource.allow.delete) {
    return { error: 'RISORSA_NON_GESTIBILE_GENERICAMENTE', bespoke_tools: resource.bespokeOnly?.delete || [] };
  }
  if (!recordId) return { error: `${resource.pk} obbligatorio` };

  const sensitivity = resource.defaultSensitivity || 'low';
  if (sensitivity !== 'low' && !opts.confirmed) {
    return { error: 'RICHIEDE_CONFERMA', requires_confirmation: true, sensitivity };
  }

  // Snapshot della riga intera PRIMA di cancellare — è l'unico modo per poter
  // annullare un delete (reinserirla identica).
  const { data: fullRow } = await supabase
    .from(resource.table)
    .select('*')
    .eq(resource.pk, recordId)
    .eq('company_id', companyId)
    .single();

  const { error } = await supabase
    .from(resource.table)
    .delete()
    .eq(resource.pk, recordId)
    .eq('company_id', companyId);

  if (error) return { error: error.message };

  await auditLog({
    companyId, userId,
    action: opts.confirmed ? `record.delete:${resourceName}:confirmed` : `record.delete:${resourceName}`,
    targetType: resourceName,
    targetId: recordId,
    req,
  });

  const summary = buildSummary(resourceName, 'delete', fullRow);
  const actionHistoryId = await logActionHistory({
    companyId, userId, conversationId: opts.conversationId,
    resource, resourceName, action: 'delete', recordId,
    fullRowSnapshot: fullRow || null, summary,
  });

  return { success: true, deleted_id: recordId, actionHistoryId, undoSummary: summary, resource: resourceName, action: 'delete' };
}

// Annulla una scrittura precedente (create/update/delete) registrata in
// ladia_action_history. Due controlli di sicurezza prima di procedere:
//   1. Finestra temporale (UNDO_WINDOW_MINUTES) — oltre non si annulla più,
//      per evitare rollback "a sorpresa" molto dopo il fatto.
//   2. Conflitto — se qualcun altro ha modificato di nuovo lo stesso record
//      da allora, l'undo si rifiuta invece di sovrascrivere silenziosamente
//      un cambiamento più recente e legittimo.
async function undoAction(historyId, companyId, userId, req) {
  const { data: entry, error: fetchErr } = await supabase
    .from('ladia_action_history')
    .select('*')
    .eq('id', historyId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (fetchErr) return { error: 'DB_ERROR' };
  if (!entry) return { error: 'NOT_FOUND' };
  if (entry.undone_at) return { error: 'GIA_ANNULLATA', message: 'Questa azione è già stata annullata.' };

  const ageMinutes = (Date.now() - new Date(entry.created_at).getTime()) / 60000;
  if (ageMinutes > UNDO_WINDOW_MINUTES) {
    return { error: 'FINESTRA_SCADUTA', message: `Puoi annullare un'azione solo entro ${UNDO_WINDOW_MINUTES} minuti.` };
  }

  const resource = getResource(entry.resource);
  if (!resource) return { error: `Risorsa non più gestita: ${entry.resource}` };

  if (entry.action === 'create') {
    // L'undo di una create è, di fatto, un delete: rispetta lo stesso divieto
    // di deleteRecord() per le risorse con allow.delete=false (es. workers,
    // sites), che richiedono un flusso di cancellazione dedicato invece di
    // una DELETE generica — altrimenti l'undo aggirerebbe quella restrizione.
    if (!resource.allow.delete) {
      return { error: 'UNDO_NON_DISPONIBILE', message: 'Questa risorsa non supporta l\'eliminazione diretta: annulla la creazione dalla sezione dedicata.' };
    }
  } else if (entry.action === 'update') {
    // Conflitto: se ORA i campi non corrispondono più a quello che QUESTA
    // azione aveva scritto, qualcun altro li ha cambiati di nuovo da allora —
    // annullare sovrascriverebbe silenziosamente quel cambiamento.
    const changedKeys = Object.keys(entry.changed_fields || {});
    const prevKeys    = new Set(Object.keys(entry.previous_values || {}));
    if (changedKeys.length > 0 && !changedKeys.every(k => prevKeys.has(k))) {
      return { error: 'SNAPSHOT_MANCANTE', message: 'Impossibile annullare: i valori precedenti non sono stati salvati per questa modifica.' };
    }
    if (changedKeys.length > 0) {
      const { data: current } = await supabase.from(entry.table_name)
        .select(changedKeys.join(',')).eq(entry.pk_column, entry.record_id)
        .eq('company_id', companyId).single();
      const conflict = current && changedKeys.some(k => String(current[k]) !== String(entry.changed_fields[k]));
      if (conflict) {
        return { error: 'CONFLITTO', message: 'Il dato è stato modificato di nuovo da allora — annullamento non sicuro.' };
      }
    }
  } else if (entry.action === 'delete') {
    if (!entry.full_row_snapshot) return { error: 'SNAPSHOT_MANCANTE', message: 'Impossibile ripristinare: nessuna copia del record salvata.' };
  }

  // Claim atomico contro doppio click/doppia tab: solo la prima richiesta che
  // trova ancora undone_at NULL vince ed esegue la reversal (stesso pattern di
  // POST /chat/confirm-action). Le richieste successive ricevono GIA_ANNULLATA
  // invece di ripetere delete/update/insert una seconda volta.
  const { data: claimed, error: claimErr } = await supabase
    .from('ladia_action_history')
    .update({ undone_at: new Date().toISOString(), undone_by: userId })
    .eq('id', historyId)
    .eq('company_id', companyId)
    .is('undone_at', null)
    .select()
    .maybeSingle();

  if (claimErr) return { error: 'DB_ERROR' };
  if (!claimed) return { error: 'GIA_ANNULLATA', message: 'Questa azione è già stata annullata.' };

  if (entry.action === 'create') {
    const { error } = await supabase.from(entry.table_name).delete()
      .eq(entry.pk_column, entry.record_id).eq('company_id', companyId);
    if (error) return { error: error.message };

  } else if (entry.action === 'update') {
    const { error } = await supabase.from(entry.table_name)
      .update(entry.previous_values || {})
      .eq(entry.pk_column, entry.record_id).eq('company_id', companyId);
    if (error) return { error: error.message };

  } else if (entry.action === 'delete') {
    const { error } = await supabase.from(entry.table_name).insert(entry.full_row_snapshot);
    if (error) return { error: error.message };
  }

  await auditLog({
    companyId, userId,
    action: `record.undo:${entry.resource}`,
    targetType: entry.resource,
    targetId: entry.record_id,
    payload: { original_action: entry.action },
    req,
  });

  return { success: true, undone: entry.action, resource: entry.resource };
}

// Salva una PROPOSTA di scrittura su una risorsa medium/high — non esegue
// nulla. La scrittura vera avviene solo in routes/v1/chat.js via l'endpoint
// POST /chat/confirm-action/:id, che richiama createRecord/updateRecord/
// deleteRecord con { confirmed: true } dopo un decision esplicito dell'utente.
async function proposeAction({ resource: resourceName, action, recordId, payload, summary, companyId, userId, conversationId }) {
  const resource = getResource(resourceName);
  if (!resource) return { error: `Risorsa non gestita: ${resourceName}` };
  if (!resource.allow[action]) {
    return { error: 'RISORSA_NON_GESTIBILE_GENERICAMENTE', bespoke_tools: resource.bespokeOnly?.[action] || [] };
  }
  if (action !== 'create' && !recordId) return { error: `${resource.pk} obbligatorio` };
  if (!summary) return { error: 'summary obbligatorio — riepilogo da mostrare all\'utente' };

  let clean = {};
  if (action !== 'delete') {
    const sanitized = sanitizePayload(resource, payload, action === 'create' ? 'create' : 'update');
    if (action === 'create' && sanitized.missing.length > 0) {
      return { error: `Campi obbligatori mancanti: ${sanitized.missing.join(', ')}` };
    }
    if (Object.keys(sanitized.clean).length === 0) return { error: 'Nessun campo valido specificato' };
    clean = sanitized.clean;
  }

  const sensitivity = action === 'delete'
    ? (resource.defaultSensitivity || 'low')
    : computeSensitivity(resource, Object.keys(clean));

  if (sensitivity === 'low') {
    return { error: 'AZIONE_A_BASSO_RISCHIO', message: 'Questa azione non richiede conferma — usa create_record/update_record/delete_record direttamente.' };
  }

  const { data, error } = await supabase.from('ladia_pending_actions').insert({
    company_id: companyId,
    user_id: userId,
    conversation_id: conversationId || null,
    operations: [{ resource: resourceName, action, record_id: recordId || null, payload: clean }],
    summary,
    sensitivity,
  }).select().single();

  if (error) return { error: error.message };

  return { proposed: true, pending_action_id: data.id, summary: data.summary };
}

module.exports = { createRecord, updateRecord, deleteRecord, proposeAction, undoAction };
