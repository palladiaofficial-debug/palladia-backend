'use strict';
const supabase = require('./supabase');
const { auditLog } = require('./audit');
const { getResource, computeSensitivity, sanitizePayload } = require('./ladiaSchemaRegistry');

// Executor generico per i tool create_record/update_record/delete_record di
// Ladia. Nessuna dipendenza da Express/Anthropic — riusabile anche fuori dal
// loop agentico del chat web (es. Telegram, Fase 5 del piano).
//
// Ogni funzione: risolve la risorsa dal registro, sanitizza l'input con
// whitelist stretta, rifiuta strutturalmente le scritture non a basso rischio
// (RICHIEDE_CONFERMA — enforcement reale, non prompt), esegue con company_id
// iniettato server-side, e registra l'azione su admin_audit_log.

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

  return { success: true, record: data };
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

  return { success: true, record: data };
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

  return { success: true, deleted_id: recordId };
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

module.exports = { createRecord, updateRecord, deleteRecord, proposeAction };
