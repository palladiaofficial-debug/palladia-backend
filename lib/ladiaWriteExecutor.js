'use strict';
const supabase = require('./supabase');
const { getResource, computeSensitivity } = require('./ladiaSchemaRegistry');
const { logAction } = require('./ladiaActionLog');
const { buildResultCard } = require('./resultCardBuilder');

// Salva una PROPOSTA di scrittura per un tool BESPOKE (non create/update/delete
// generico — vedi proposeAction in ladiaGenericTools.js per l'equivalente sui
// tool generici). Necessario perché POST /chat/confirm-action/:id sapeva solo
// ri-eseguire create_record/update_record/delete_record: senza questo, gatare
// un tool bespoke con RICHIEDE_CONFERMA sarebbe un vicolo cieco — nessun modo
// di completare l'azione anche dopo l'approvazione dell'utente. Il replay
// (routes/v1/chat.js, ramo op.bespoke) richiama executeTool(tool, {...toolInput,
// _confirmed:true}, ...) — lo stesso dispatcher usato per la chiamata originale,
// non un percorso parallelo.
async function proposeBespokeAction({ tool, toolInput, summary, companyId, userId, conversationId, sensitivity }) {
  const { data, error } = await supabase.from('ladia_pending_actions').insert({
    company_id: companyId,
    user_id: userId,
    conversation_id: conversationId || null,
    operations: [{ bespoke: true, tool, toolInput }],
    summary,
    sensitivity,
  }).select().single();
  if (error) return { error: error.message };
  return { pending_action_id: data.id, summary: data.summary };
}

// ── Percorso unico di scrittura di Ladia — Fase 2 "Ciclo del Risultato" ──────
// Prima di questo file, ogni tool bespoke in routes/v1/chat.js scriveva
// direttamente via supabase ed eseguiva SUBITO, senza alcun gate — solo
// registrando l'audit/undo a cosa fatta (logAction). Questo wrapper aggiunge
// le due fasi che mancavano (PREVIEW/CONFERMA via sensitivity + RIVERIFICA/
// CONTATO via ResultCard) senza toccare COME ogni tool costruisce la propria
// riga da scrivere: il pre-processing bespoke (risoluzione nome→id, calcoli,
// upsert vs insert) resta nel case-block, passato qui solo come `writeFn`.
//
// Deliberatamente NON passa da sanitizePayload/whitelist dei campi come
// create_record/update_record generici: alcuni tool bespoke scrivono
// legittimamente campi che il registro segna createOnly per i tool generici
// (es. update_worker aggiorna 'qualification' dopo la creazione, cosa che
// update_record rifiuterebbe) — comportamento di prodotto esistente, non un
// bug da correggere silenziosamente qui.
//
// row: le chiavi del payload che si sta per scrivere (create: la riga intera;
// update: solo il patch) — usate SOLO per calcolare la sensitivity (quali
// campi sono medium/high per questa risorsa, da ladiaSchemaRegistry), mai
// per una whitelist. Un campo assente da resource.fields non alza la
// sensitivity (resta al default della risorsa) — vedi computeSensitivity.
async function executeWrite({
  resourceName, action, recordId, row, previousValues, fullRowSnapshot,
  companyId, userId, req, conversationId, opts, writeFn, auditActionOverride, resultCard,
  toolName, toolInput, summary,
}) {
  const resource = getResource(resourceName);
  if (!resource) return { error: `Risorsa non gestita: ${resourceName}` };

  // toolInput._confirmed: valorizzato dal ramo op.bespoke di /chat/confirm-action
  // quando ri-esegue il tool dopo l'approvazione dell'utente — vedi
  // proposeBespokeAction sopra. opts.confirmed resta per compatibilità con
  // eventuali chiamate dirette (script/test).
  const confirmed = !!(opts?.confirmed || toolInput?._confirmed);
  // Solo le chiavi con un valore REALE (non null/undefined) contano per la
  // sensitivity — a differenza dei tool generici (sanitizePayload esclude già
  // i null a monte), i case-block bespoke costruiscono spesso una riga con
  // TUTTE le colonne della tabella e null di default per quelle non fornite
  // dal modello: contare anche quelle alzerebbe la sensitivity ad ogni
  // scrittura, anche quando il campo legal/financial-sensitive è semplicemente
  // assente (es. creare un subappaltatore senza ancora sapere il DURC).
  const presentKeys = Object.keys(row || {}).filter(k => row[k] !== null && row[k] !== undefined);
  const sensitivity = action === 'delete'
    ? (resource.defaultSensitivity || 'low')
    : computeSensitivity(resource, presentKeys);

  if (sensitivity !== 'low' && !confirmed) {
    if (!toolName) {
      // Chiamante non predisposto per propose/confirm su questo tool bespoke
      // (toolName/toolInput non passati) — errore esplicito per chi sviluppa,
      // non un'esecuzione silenziosa che aggira il gate.
      return { error: `executeWrite: sensitivity ${sensitivity} su ${resourceName} richiede toolName/toolInput per abilitare la conferma.` };
    }
    const proposed = await proposeBespokeAction({
      tool: toolName, toolInput, companyId, userId, conversationId, sensitivity,
      summary: summary || `Conferma azione su ${resourceName}`,
    });
    if (proposed.error) return proposed;
    return { error: 'RICHIEDE_CONFERMA', requires_confirmation: true, sensitivity, pending_action_id: proposed.pending_action_id, summary: proposed.summary };
  }

  const { data, error } = await writeFn();
  if (error) return { error: error.message || String(error) };

  const finalRecordId = recordId ?? data?.[resource.pk];
  const logged = await logAction({
    companyId, userId, req, conversationId,
    resourceName, action, recordId: finalRecordId,
    record: data, previousValues, fullRowSnapshot, changedFields: row,
    auditActionOverride,
  });

  let card;
  if (resultCard) {
    card = await buildResultCard({
      id: logged.actionHistoryId || String(finalRecordId),
      companyId, recordId: finalRecordId,
      resourceName: resultCard.complianceResource || resourceName,
      title: resultCard.title,
      complianceField: resultCard.complianceField,
      expectedImprovement: resultCard.expectedImprovement,
      inMano: resultCard.inMano,
      hoursSavedKey: resultCard.hoursSavedKey,
    });
  }

  return { success: true, data, ...logged, resultCard: card };
}

module.exports = { executeWrite, proposeBespokeAction };
