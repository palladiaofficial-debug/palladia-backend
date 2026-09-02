#!/usr/bin/env node
/**
 * scripts/selftest_undo_action_sensitivity_gate.js
 *
 * Regressione F-112 (AUDIT.md, trovato da LADIA_EVALS 2026-09-02, scenario
 * U04): annullare via chat la CREAZIONE di un record a sensibilità
 * medium/high (es. un SAL emesso, campo importo_maturato) scriveva subito —
 * undo_action cancellava il record reale, e SOLO DOPO il modello scriveva
 * "Confermo l'annullamento?" seguito immediatamente da "✓ Annullato": una
 * domanda retorica dopo il fatto, non un gate reale. Zero conferma vera per
 * l'annullamento di un documento numerato (SAL) — stessa gravità di rischio
 * di emit_sal stesso, che invece un gate ce l'ha da tempo.
 *
 * Chiama DIRETTAMENTE ladiaGenericTools.undoActionGated() — la stessa
 * funzione a cui il case 'undo_action' di routes/v1/chat.js delega (non una
 * reimplementazione parallela: se qualcuno tocca undoActionGated() o lo
 * scollega da chat.js, questo test lo scopre). Il case-block SSE stesso
 * resta non testabile in modo deterministico senza una vera chiamata a
 * Claude — vedi invece la riverifica end-to-end dello scenario U04 di
 * LADIA_EVALS dopo il fix, annotata in AUDIT.md.
 *
 * Copre anche il non-regressione: un undo di sensibilità 'low' (es.
 * site_notes, il caso comune — annullare una nota appena creata) NON deve
 * finire gatato, altrimenti ogni "annulla" banale richiederebbe un secondo
 * giro inutile.
 *
 * Uso: node scripts/selftest_undo_action_sensitivity_gate.js
 */
'use strict';
require('dotenv').config();

const supabase = require('../lib/supabase');
const { getResource } = require('../lib/ladiaSchemaRegistry');
const { logActionHistory } = require('../lib/ladiaActionLog');
const { undoActionGated } = require('../lib/ladiaGenericTools');

const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';
const SITE_ID    = process.env.TEST_SITE_ID    || 'b4d201dd-4721-42bb-89b9-2736f6e52038';
const CI_EMAIL   = process.env.TEST_CI_EMAIL   || 'ci-test@palladia.internal';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// Stesso wrapper esatto usato dal case 'undo_action' di chat.js.
function undoActionAsChatJsWould(historyId, companyId, userId, confirmed) {
  return undoActionGated(historyId, companyId, userId, null, {
    conversationId: null,
    toolInput: { action_history_id: historyId, _confirmed: confirmed },
  });
}

async function main() {
  const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const ciUser = users?.users?.find(u => u.email === CI_EMAIL);
  if (!ciUser) { console.log('  – skip (utente CI non trovato — TEST_CI_EMAIL)'); process.exitCode = 0; return; }

  console.log('\n=== F-112: undo_action gated per le create a sensibilità medium (es. SAL) ===\n');

  // Pulizia difensiva di eventuali residui da un run precedente interrotto
  // a metà (crash prima del cleanup finale) — rende lo script rilanciabile.
  await supabase.from('site_sal_history').delete().eq('company_id', COMPANY_ID).eq('site_id', SITE_ID).eq('note', 'Selftest F-112');

  // ── Caso 1: SAL emesso (sensibilità medium via importo_maturato) ─────────
  const salRow = {
    company_id: COMPANY_ID, site_id: SITE_ID, sal_number: 900000 + Math.floor(Math.random() * 90000),
    sal_percentuale: 42, data_emissione: new Date().toISOString().slice(0, 10),
    totale_contratto: 100000, importo_maturato: 42000,
    costo_mo: 0, costi_diretti: 0, totale_costi: 0, margine: 42000, margine_percentuale: 100,
    note: 'Selftest F-112', created_by: ciUser.id,
  };
  const { data: sal, error: salErr } = await supabase.from('site_sal_history').insert(salRow).select('id').single();
  if (salErr) { console.error('Setup SAL fallito:', salErr.message); process.exit(1); }

  const salHistoryId = await logActionHistory({
    companyId: COMPANY_ID, userId: ciUser.id, resource: getResource('site_sal_history'),
    resourceName: 'site_sal_history', action: 'create', recordId: sal.id,
    changedFields: salRow, summary: `Creato: site_sal_history — SAL ${salRow.sal_number}`,
  });
  if (!salHistoryId) { console.error('Setup ladia_action_history (SAL) fallito'); process.exit(1); }

  const gated = await undoActionAsChatJsWould(salHistoryId, COMPANY_ID, ciUser.id, false);
  check('primo tentativo (senza conferma): richiede conferma, non scrive', gated?.error === 'RICHIEDE_CONFERMA' && gated?.requires_confirmation === true, gated);
  check('la risposta porta un pending_action_id (serve alla card SSE)', typeof gated?.pending_action_id === 'string' && gated.pending_action_id.length > 0, gated);

  const { data: salAfterGate } = await supabase.from('site_sal_history').select('id').eq('id', sal.id).maybeSingle();
  check('il SAL NON è stato cancellato dal primo tentativo', !!salAfterGate, salAfterGate);
  const { data: histAfterGate } = await supabase.from('ladia_action_history').select('undone_at').eq('id', salHistoryId).single();
  check('undone_at resta NULL dopo il solo gate (non è stato annullato davvero)', histAfterGate.undone_at === null, histAfterGate);

  const confirmedResult = await undoActionAsChatJsWould(salHistoryId, COMPANY_ID, ciUser.id, true);
  check('secondo tentativo (_confirmed:true, come dal replay di /chat/confirm-action) riesce davvero', confirmedResult?.success === true, confirmedResult);
  const { data: salAfterConfirm } = await supabase.from('site_sal_history').select('id').eq('id', sal.id).maybeSingle();
  check('dopo la conferma il SAL è stato cancellato per davvero', salAfterConfirm === null, salAfterConfirm);

  await supabase.from('ladia_pending_actions').delete().eq('company_id', COMPANY_ID).eq('summary', `Annulla — Creato: site_sal_history — SAL ${salRow.sal_number}`);
  if (salAfterGate) await supabase.from('site_sal_history').delete().eq('id', sal.id); // sicurezza, non dovrebbe servire

  // ── Caso 2: nota (sensibilità low) — non deve essere gatata ───────────────
  const { data: note, error: noteErr } = await supabase.from('site_notes').insert({
    company_id: COMPANY_ID, site_id: SITE_ID, category: 'nota', urgency: 'normale',
    content: 'Selftest F-112 — undo low-sensitivity non gatato', author_name: 'Selftest',
  }).select('id').single();
  if (noteErr) { console.error('Setup nota fallito:', noteErr.message); process.exit(1); }

  const noteHistoryId = await logActionHistory({
    companyId: COMPANY_ID, userId: ciUser.id, resource: getResource('site_notes'),
    resourceName: 'site_notes', action: 'create', recordId: note.id,
    summary: 'Creato: site_notes',
  });
  if (!noteHistoryId) { console.error('Setup ladia_action_history (nota) fallito'); await supabase.from('site_notes').delete().eq('id', note.id); process.exit(1); }

  const noteResult = await undoActionAsChatJsWould(noteHistoryId, COMPANY_ID, ciUser.id, false);
  check('un undo a bassa sensibilità (nota) NON viene gatato — nessuna frizione in più sul caso comune', noteResult?.success === true, noteResult);
  const { data: noteAfter } = await supabase.from('site_notes').select('id').eq('id', note.id).maybeSingle();
  check('la nota è stata davvero cancellata al primo tentativo', noteAfter === null, noteAfter);
  if (noteAfter) await supabase.from('site_notes').delete().eq('id', note.id);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('Errore fatale:', e); process.exitCode = 1; });
