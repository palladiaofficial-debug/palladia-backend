'use strict';
const supabase = require('./supabase');
const { auditLog } = require('./audit');
const { getResource } = require('./ladiaSchemaRegistry');

// Trail legale (admin_audit_log) + undo reale (ladia_action_history) condivisi
// da tutti gli esecutori di scrittura di Ladia — sia i tool generici
// (create_record/update_record/delete_record, lib/ladiaGenericTools.js) sia i
// tool "bespoke" in routes/v1/chat.js che hanno già eseguito la scrittura e
// vogliono solo registrarla (vedi logAction() sotto).

// Riepilogo leggibile per il bottone "Annulla" — usa il primo campo
// name-like disponibile sul record, altrimenti solo il nome risorsa.
function buildSummary(resourceName, action, record) {
  const nameField = ['full_name', 'name', 'nome', 'titolo', 'ragione_sociale'].find(f => record && record[f]);
  const label = nameField ? `${resourceName} — ${record[nameField]}` : resourceName;
  const verb = action === 'create' ? 'Creato' : action === 'update' ? 'Modificato' : 'Eliminato';
  return `${verb}: ${label}`;
}

async function logActionHistory({ companyId, userId, conversationId, resource, resourceName, action, recordId, previousValues, changedFields, fullRowSnapshot, summary }) {
  try {
    const { data, error } = await supabase.from('ladia_action_history').insert({
      company_id:        companyId,
      user_id:            userId,
      conversation_id:    conversationId || null,
      resource:           resourceName,
      table_name:         resource.table,
      pk_column:          resource.pk,
      record_id:          String(recordId),
      action,
      previous_values:    previousValues || null,
      changed_fields:     changedFields || null,
      full_row_snapshot:  fullRowSnapshot || null,
      summary,
    }).select('id').single();
    if (error) { console.error('[ladia_action_history] insert error:', error.message); return null; }
    return data.id;
  } catch (e) {
    console.error('[ladia_action_history] insert exception:', e.message);
    return null;
  }
}

// Per tool bespoke che hanno GIÀ eseguito la scrittura (validazione/logica di
// dominio propria, es. risoluzione nome→id) e vogliono solo registrarla:
// audit legale + riga in ladia_action_history per abilitare undo + card SSE
// generica, senza passare da sanitizePayload/computeSensitivity (che servono
// solo ai tool generici create_record/update_record).
async function logAction({ companyId, userId, req, conversationId, resourceName, action, recordId, record, previousValues, changedFields, fullRowSnapshot, auditActionOverride }) {
  const resource = getResource(resourceName);
  if (!resource) {
    console.error(`[ladiaActionLog] risorsa "${resourceName}" non registrata in ladiaSchemaRegistry — audit/undo saltati`);
    return { actionHistoryId: null, summary: null, resource: resourceName, action, record: record || null, previous: previousValues || null };
  }

  await auditLog({
    companyId, userId,
    action: auditActionOverride || `record.${action}:${resourceName}`,
    targetType: resourceName,
    targetId: recordId,
    payload: changedFields || record || null,
    req,
  });

  const summary = buildSummary(resourceName, action, record || fullRowSnapshot || {});
  const actionHistoryId = await logActionHistory({
    companyId, userId, conversationId,
    resource, resourceName, action, recordId,
    previousValues, changedFields, fullRowSnapshot, summary,
  });

  return { actionHistoryId, summary, resource: resourceName, action, record: record || null, previous: previousValues || null };
}

module.exports = { buildSummary, logActionHistory, logAction };
