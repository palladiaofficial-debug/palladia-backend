#!/usr/bin/env node
/**
 * scripts/selftest_undo_blocked_followup_gate.js
 *
 * Regressione seguito di F-118 (AUDIT.md, LADIA_EVALS, scenario U09):
 * dopo un undo_action rifiutato con UNDO_NON_DISPONIBILE, il modello a volte
 * chiama comunque un tool diverso sullo STESSO record (es. rimuovere un
 * lavoratore da un cantiere invece dell'annullamento negato) e lo spaccia
 * per l'annullamento riuscito. Un'istruzione di sola prompt era già stata
 * provata e riverificata dal vivo NON efficace (3/5 prima, 3/5 dopo il
 * deploy — nessuna differenza statisticamente rilevabile), perché
 * worksite_workers ha defaultSensitivity 'low': zero enforcement lato
 * codice, solo la buona volontà del modello nello scriverne uno a parole.
 *
 * Fix: checkOrProposeGate() (lib/ladiaWriteExecutor.js) ora legge
 * req._blockedUndoTargets (popolato da routes/v1/chat.js dopo ogni round
 * dello streaming quando undo_action ritorna UNDO_NON_DISPONIBILE) — una
 * scrittura bespoke il cui toolInput referenzia lo stesso id passa SEMPRE
 * dal gate di conferma, indipendentemente dalla sensitivity propria della
 * risorsa.
 *
 * Seguito 2026-09-06 (LADIA_EVALS reale su produzione, scenario U09: 4/5
 * ancora falliti dopo il primo fix): il modello non chiamava MAI undo_action
 * — lo saltava perché il risultato della create originale (create_record
 * generico) porta già `undoable: false` (worksite_workers.allow.delete=false),
 * e concludeva da solo "l'undo non serve" andando dritto a
 * remove_worker_from_site. blockedUndoTargets ora si popola anche da questo
 * segnale (qualunque scrittura riuscita con undoable:false), non solo da un
 * undo_action già fallito — vedi Passo 6 sotto, che NON chiama mai
 * undoActionGated/undo_action, esattamente come nella traccia reale.
 *
 * Chiama DIRETTAMENTE undoActionGated() ed executeWrite() — le stesse
 * funzioni a cui delegano rispettivamente il case 'undo_action' e il case
 * 'remove_worker_from_site' di routes/v1/chat.js (non una reimplementazione
 * parallela). Il case-block SSE stesso resta non testabile in modo
 * deterministico senza una vera chiamata a Claude — stesso limite già
 * documentato in selftest_undo_action_sensitivity_gate.js (F-112).
 *
 * Uso: node scripts/selftest_undo_blocked_followup_gate.js
 */
'use strict';
require('dotenv').config();

const supabase = require('../lib/supabase');
const { getResource } = require('../lib/ladiaSchemaRegistry');
const { logActionHistory } = require('../lib/ladiaActionLog');
const { undoActionGated, createRecord } = require('../lib/ladiaGenericTools');
const { executeWrite, collectBlockCandidates } = require('../lib/ladiaWriteExecutor');

const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';
const SITE_ID    = process.env.TEST_SITE_ID    || 'b4d201dd-4721-42bb-89b9-2736f6e52038';
const CI_EMAIL   = process.env.TEST_CI_EMAIL   || 'ci-test@palladia.internal';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function removeWorkerFromSiteAsChatJsWould(workerId, siteId, req, confirmed) {
  // Stesso identico case-block di routes/v1/chat.js::executeTool, 'remove_worker_from_site'.
  const patch = { status: 'inactive' };
  return executeWrite({
    resourceName: 'worksite_workers', action: 'update', row: patch, previousValues: { status: 'active' },
    companyId: COMPANY_ID, userId: req._userId, req, conversationId: null,
    toolName: 'remove_worker_from_site', toolInput: { worker_id: workerId, site_id: siteId, _confirmed: confirmed },
    summary: 'Rimuove lavoratore dal cantiere',
    writeFn: () => supabase.from('worksite_workers').update(patch)
      .eq('worker_id', workerId).eq('site_id', siteId).eq('company_id', COMPANY_ID).eq('status', 'active').select().single(),
  });
}

async function makeWorkerAssignedToSite(fiscalCodeSuffix, ciUserId) {
  const { data: worker, error: workerErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: `Selftest F118-Followup ${fiscalCodeSuffix}`,
    fiscal_code: `TSTF18${fiscalCodeSuffix}A01H501${fiscalCodeSuffix === '1' ? 'X' : 'Y'}`,
    badge_code: `SELFTEST-F118-${fiscalCodeSuffix}-${Date.now()}`, is_active: true,
  }).select('id').single();
  if (workerErr) throw new Error(`Setup worker fallito: ${workerErr.message}`);

  const { error: assignErr } = await supabase.from('worksite_workers').insert({
    company_id: COMPANY_ID, worker_id: worker.id, site_id: SITE_ID, status: 'active', start_date: new Date().toISOString().slice(0, 10),
  });
  if (assignErr) throw new Error(`Setup assegnazione fallito: ${assignErr.message}`);

  const historyId = await logActionHistory({
    companyId: COMPANY_ID, userId: ciUserId, resource: getResource('workers'),
    resourceName: 'workers', action: 'create', recordId: worker.id,
    summary: `Creato: workers — ${worker.id}`,
  });
  if (!historyId) throw new Error('Setup ladia_action_history fallito');

  return { workerId: worker.id, historyId };
}

// Come workerA/workerB, ma NON pre-assegnato via insert diretto — l'assegnazione
// arriva più sotto tramite createRecord() vero, per ottenere un undoable:false
// genuino (il ramo dedupeCheck di createRecord ritorna prima di calcolarlo).
async function makeUnassignedWorker(fiscalCodeSuffix) {
  const { data: worker, error } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: `Selftest F118-Followup ${fiscalCodeSuffix}`,
    fiscal_code: `TSTF18${fiscalCodeSuffix}A01H501Z`,
    badge_code: `SELFTEST-F118-${fiscalCodeSuffix}-${Date.now()}`, is_active: true,
  }).select('id').single();
  if (error) throw new Error(`Setup worker fallito: ${error.message}`);
  return worker.id;
}

async function cleanup(workerIds) {
  await supabase.from('worksite_workers').delete().eq('company_id', COMPANY_ID).in('worker_id', workerIds);
  await supabase.from('ladia_action_history').delete().eq('company_id', COMPANY_ID).in('record_id', workerIds);
  await supabase.from('ladia_pending_actions').delete().eq('company_id', COMPANY_ID).eq('summary', 'Rimuove lavoratore dal cantiere');
  await supabase.from('workers').delete().in('id', workerIds);
}

async function main() {
  const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const ciUser = users?.users?.find(u => u.email === CI_EMAIL);
  if (!ciUser) { console.log('  – skip (utente CI non trovato — TEST_CI_EMAIL)'); process.exitCode = 0; return; }

  console.log('\n=== Seguito F-118: azione alternativa dopo undo rifiutato viene gatata ===\n');

  const workerA = await makeWorkerAssignedToSite('1', ciUser.id); // quello il cui undo verrà rifiutato
  const workerB = await makeWorkerAssignedToSite('2', ciUser.id); // non correlato — non deve essere toccato dal gate
  const workerCId = await makeUnassignedWorker('3'); // assegnato più sotto via createRecord — undo_action mai chiamato in questo passo

  try {
    // ── Passo 1: l'undo del lavoratore A viene rifiutato (workers.allow.delete=false) ──
    const undoResult = await undoActionGated(workerA.historyId, COMPANY_ID, ciUser.id, null, { conversationId: null, toolInput: { action_history_id: workerA.historyId } });
    check('undo_action su un lavoratore ritorna UNDO_NON_DISPONIBILE', undoResult?.error === 'UNDO_NON_DISPONIBILE', undoResult);
    check('la risposta porta il recordId del lavoratore bloccato', undoResult?.recordId === workerA.workerId, undoResult);

    // req come lo costruirebbe routes/v1/chat.js dopo aver visto quel risultato in questo turno.
    const req = { _blockedUndoTargets: [String(undoResult.recordId)], _userId: ciUser.id };

    // ── Passo 2: remove_worker_from_site sullo STESSO lavoratore viene gatato ──
    const blocked = await removeWorkerFromSiteAsChatJsWould(workerA.workerId, SITE_ID, req, false);
    check('remove_worker_from_site sul lavoratore bloccato richiede conferma, non esegue', blocked?.error === 'RICHIEDE_CONFERMA' && blocked?.requires_confirmation === true, blocked);
    check('la risposta porta un pending_action_id (serve alla card SSE)', typeof blocked?.pending_action_id === 'string' && blocked.pending_action_id.length > 0, blocked);
    check('la risposta è marcata blocked_undo_followup', blocked?.blocked_undo_followup === true, blocked);

    const { data: assignAfterGate } = await supabase.from('worksite_workers').select('status').eq('worker_id', workerA.workerId).eq('site_id', SITE_ID).single();
    check('il lavoratore NON è stato rimosso dal cantiere dal solo gate', assignAfterGate?.status === 'active', assignAfterGate);

    // ── Passo 3: con _confirmed:true (dopo un sì esplicito dell'utente), procede davvero ──
    const confirmed = await removeWorkerFromSiteAsChatJsWould(workerA.workerId, SITE_ID, req, true);
    check('con _confirmed:true la rimozione riesce per davvero', confirmed?.success === true, confirmed);
    const { data: assignAfterConfirm } = await supabase.from('worksite_workers').select('status').eq('worker_id', workerA.workerId).eq('site_id', SITE_ID).single();
    check('dopo la conferma il lavoratore risulta rimosso dal cantiere', assignAfterConfirm?.status === 'inactive', assignAfterConfirm);

    // ── Passo 4: un lavoratore NON correlato (B) non viene toccato dal gate ──
    // Stesso req (blockedUndoTargets ancora valorizzato per A) — dimostra che
    // il blocco è specifico al record, non "qualunque scrittura nello stesso turno".
    const unrelated = await removeWorkerFromSiteAsChatJsWould(workerB.workerId, SITE_ID, req, false);
    check('un lavoratore NON correlato allo stesso turno non viene gatato — nessuna frizione su richieste composte legittime', unrelated?.success === true, unrelated);
    const { data: assignB } = await supabase.from('worksite_workers').select('status').eq('worker_id', workerB.workerId).eq('site_id', SITE_ID).single();
    check('il lavoratore B risulta davvero rimosso dal cantiere', assignB?.status === 'inactive', assignB);

    // ── Passo 5: non-regressione — senza blockedUndoTargets, il comportamento resta invariato ──
    await supabase.from('worksite_workers').update({ status: 'active' }).eq('worker_id', workerA.workerId).eq('site_id', SITE_ID);
    const baseline = await removeWorkerFromSiteAsChatJsWould(workerA.workerId, SITE_ID, { _userId: ciUser.id }, false);
    check('senza alcun blockedUndoTargets (baseline pre-fix) la rimozione riesce subito — nessuna regressione sul caso comune', baseline?.success === true, baseline);

    // ── Passo 6: undo_action MAI chiamato — solo undoable:false sulla create ──
    // Riproduce esattamente la traccia reale trovata su produzione (LADIA_EVALS
    // U09, 2026-09-06): il modello assegna con create_record, vede
    // undoable:false, e salta dritto a remove_worker_from_site senza mai
    // tentare l'annullamento.
    const assignResult = await createRecord('worksite_workers', { worker_id: workerCId, site_id: SITE_ID }, COMPANY_ID, ciUser.id, null, { conversationId: null });
    check('create_record su worksite_workers riesce ed espone undoable:false', assignResult?.success === true && assignResult?.undoable === false, assignResult);

    // req popolato SOLO dal segnale undoable:false — stessa identica logica
    // aggiunta in routes/v1/chat.js (collectBlockCandidates sul block.input
    // originale, non solo l'id della riga risultante), nessuna chiamata a
    // undo_action qui.
    const originalToolInput = { table: 'worksite_workers', payload: { worker_id: workerCId, site_id: SITE_ID } };
    const blockedIdsFromUndoableFalse = [String(assignResult.record.id), ...collectBlockCandidates(originalToolInput)];
    const reqFromUndoableFalse = { _blockedUndoTargets: blockedIdsFromUndoableFalse, _userId: ciUser.id };
    const blockedNoUndo = await removeWorkerFromSiteAsChatJsWould(workerCId, SITE_ID, reqFromUndoableFalse, false);
    check('remove_worker_from_site viene gatato anche se undo_action non è mai stato chiamato', blockedNoUndo?.error === 'RICHIEDE_CONFERMA' && blockedNoUndo?.requires_confirmation === true, blockedNoUndo);
    const { data: assignCAfterGate } = await supabase.from('worksite_workers').select('status').eq('worker_id', workerCId).eq('site_id', SITE_ID).single();
    check('il lavoratore C NON è stato rimosso dal solo gate (senza aver mai chiamato undo_action)', assignCAfterGate?.status === 'active', assignCAfterGate);
  } finally {
    await cleanup([workerA.workerId, workerB.workerId, workerCId]);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('Errore fatale:', e); process.exitCode = 1; });
