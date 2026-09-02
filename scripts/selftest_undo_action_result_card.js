#!/usr/bin/env node
/**
 * scripts/selftest_undo_action_result_card.js
 *
 * Regressione F-029 (AUDIT.md): un undo_action riuscito non restituiva
 * abbastanza informazioni (nessun actionHistoryId — annullare un annullamento
 * non è supportato) perché routes/v1/chat.js potesse emettere l'evento
 * record_action che accende la card verde "Fatto". Un undo vero era quindi
 * indistinguibile, lato UI e lato harness LADIA_EVALS, da uno mai avvenuto —
 * trovato riverificando dal vivo (query DB dirette) i falsi negativi U02/U05
 * del run 2026-08-08.
 *
 * Verifica il contratto lib-level da cui dipende il gate di chat.js
 * (`result.success && (result.actionHistoryId || result.undone)`): un undo
 * riuscito deve restituire recordId + summary, non solo `undone`.
 *
 * Uso: node scripts/selftest_undo_action_result_card.js
 */
'use strict';
require('dotenv').config();

const supabase = require('../lib/supabase');
const { getResource } = require('../lib/ladiaSchemaRegistry');
const { logActionHistory } = require('../lib/ladiaActionLog');
const { undoAction } = require('../lib/ladiaGenericTools');

const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';
const SITE_ID    = process.env.TEST_SITE_ID    || 'b4d201dd-4721-42bb-89b9-2736f6e52038';
const CI_EMAIL = process.env.TEST_CI_EMAIL || 'ci-test@palladia.internal';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const ciUser = users?.users?.find(u => u.email === CI_EMAIL);
  // process.exitCode (non process.exit()): uscire subito qui mentre la
  // richiesta HTTP di listUsers() appena fatta sta ancora chiudendo i suoi
  // handle di rete faceva crashare Node su Windows (libuv assertion
  // "UV_HANDLE_CLOSING", trovato dal vivo 2026-08-28) — lasciare il loop
  // eventi drenare naturalmente evita la race.
  if (!ciUser) { console.log('  – skip (utente CI non trovato — TEST_CI_EMAIL)'); process.exitCode = 0; return; }

  const { data: note, error: noteErr } = await supabase.from('site_notes').insert({
    company_id: COMPANY_ID, site_id: SITE_ID, category: 'nota', urgency: 'normale',
    content: 'Selftest F-029 — undo result card', author_name: 'Selftest',
  }).select('id').single();
  if (noteErr) { console.error('Setup fallito:', noteErr.message); process.exit(1); }

  const historyId = await logActionHistory({
    companyId: COMPANY_ID, userId: ciUser.id, resource: getResource('site_notes'),
    resourceName: 'site_notes', action: 'create', recordId: note.id,
    summary: 'Creato: site_notes',
  });
  if (!historyId) { console.error('Setup ladia_action_history fallito'); await supabase.from('site_notes').delete().eq('id', note.id); process.exit(1); }

  console.log('\n=== F-029: undoAction restituisce recordId/summary per la record_action card ===\n');

  const result = await undoAction(historyId, COMPANY_ID, ciUser.id, null);
  check('undo riesce', result.success === true, result);
  check('recordId presente (serve a chat.js per record_id della card)', result.recordId === note.id, result);
  check('summary presente e leggibile (serve a chat.js per il testo della card)', typeof result.summary === 'string' && result.summary.includes('site_notes'), result);
  check('undone riporta l\'azione originale annullata', result.undone === 'create', result);

  const { data: noteAfter } = await supabase.from('site_notes').select('id').eq('id', note.id).maybeSingle();
  const { data: historyAfter } = await supabase.from('ladia_action_history').select('undone_at').eq('id', historyId).single();
  check('la riga è stata davvero cancellata dal DB', noteAfter === null, noteAfter);
  check('undone_at è stato impostato', !!historyAfter.undone_at, historyAfter);

  if (noteAfter) await supabase.from('site_notes').delete().eq('id', note.id); // cleanup di sicurezza se l'undo non ha già ripulito

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore fatale:', e); process.exit(1); });
