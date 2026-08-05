#!/usr/bin/env node
/**
 * scripts/selftest_ladia_write_executor.js
 *
 * Test di regressione per lib/ladiaWriteExecutor.js (Fase 2 "Ciclo del
 * Risultato") — chiama executeTool() direttamente, senza passare dall'API
 * Anthropic (vedi il commento su module.exports.executeTool in chat.js).
 *
 * Verifica il comportamento che prima NON esisteva per i tool bespoke:
 *   1. Un tool a bassa sensitivity (create_site_note) esegue ancora SUBITO,
 *      nessun gate — nessuna regressione sui tool già a basso rischio.
 *   2. Un tool finanziario (create_expense, importo presente) ORA richiede
 *      conferma — prima eseguiva sempre subito, zero gate (bug di sicurezza
 *      corretto in questa fase).
 *   3. Il replay dopo conferma (stesso meccanismo di POST /chat/confirm-action,
 *      ramo op.bespoke) esegue davvero la scrittura — verificato leggendo la
 *      riga reale dal DB, non fidandosi del solo valore di ritorno.
 *
 * Usa la company E2E dedicata (stessa dei test Playwright frontend, mai
 * usata per audit manuali) — crea ed elimina il proprio cantiere/dati di
 * test, non tocca nulla di preesistente.
 *
 * Env:
 *   E2E_COMPANY_ID   Default: fda73bf5-403a-4a0e-be6d-501e3f3c5c4d
 *   E2E_USER_ID      Owner della company E2E — nessun default, obbligatorio
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { executeTool } = require('../routes/v1/chat');
const { buildResultCard } = require('../lib/resultCardBuilder');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const USER_ID    = process.env.E2E_USER_ID || '';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }

async function main() {
  if (!USER_ID) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_ladia_write_executor: E2E_USER_ID non configurato.');
    return;
  }

  console.log('\n\x1b[1mladiaWriteExecutor — gate di conferma sui tool bespoke\x1b[0m');

  let { data: sites } = await supabase.from('sites').select('id, name').eq('company_id', COMPANY_ID).limit(1);
  let createdSiteId = null;
  if (!sites?.length) {
    const { data: newSite, error: siteErr } = await supabase.from('sites')
      .insert({ company_id: COMPANY_ID, name: 'TEST-E2E-write-executor', status: 'attivo', address: 'Via Test 1, Genova' })
      .select('id, name').single();
    if (siteErr) { fail('setup cantiere di test', siteErr.message); return report(); }
    sites = [newSite];
    createdSiteId = newSite.id;
  }
  const siteId = sites[0].id;

  // 1. Tool a bassa sensitivity — esegue subito, nessun gate.
  const r1 = await executeTool('create_site_note', {
    site_id: siteId, content: 'TEST-E2E-write-executor selftest', category: 'nota', urgency: 'normale',
  }, COMPANY_ID, USER_ID, null, null);
  if (r1.success && !r1.error) ok('create_site_note (low sensitivity) esegue subito, nessun gate');
  else fail('create_site_note (low sensitivity) esegue subito, nessun gate', r1);

  // 2. Tool finanziario — ora richiede conferma (prima: zero gate).
  const r2 = await executeTool('create_expense', {
    amount: 500, description: 'TEST-E2E-write-executor selftest gate finanziario', category: 'altro',
  }, COMPANY_ID, USER_ID, null, null);
  if (r2.error === 'RICHIEDE_CONFERMA' && r2.pending_action_id) ok('create_expense con importo richiede conferma (gate presente)');
  else fail('create_expense con importo richiede conferma (gate presente)', r2);

  let expenseId = null;
  if (r2.pending_action_id) {
    // 3. Replay dopo conferma — stesso meccanismo del ramo op.bespoke in
    // POST /chat/confirm-action: esegue davvero la scrittura.
    const { data: pending } = await supabase.from('ladia_pending_actions').select('*').eq('id', r2.pending_action_id).single();
    const op = (pending?.operations || [])[0];
    if (op?.bespoke && op.tool === 'create_expense') {
      const r3 = await executeTool(op.tool, { ...op.toolInput, _confirmed: true }, COMPANY_ID, USER_ID, null, pending.conversation_id);
      if (r3.success && r3.data?.id) {
        const { data: row } = await supabase.from('company_expenses').select('id, amount').eq('id', r3.data.id).maybeSingle();
        expenseId = r3.data.id;
        if (row && Number(row.amount) === 500) ok('replay confermato scrive davvero la riga (verificato nel DB)');
        else fail('replay confermato scrive davvero la riga (verificato nel DB)', row);
      } else {
        fail('replay confermato scrive davvero la riga (verificato nel DB)', r3);
      }
    } else {
      fail('operations[0] ha la forma bespoke attesa', op);
    }
    await supabase.from('ladia_pending_actions').delete().eq('id', r2.pending_action_id);
  }

  // 4. emit_sal — prima della Fase 2b non aveva MAI un gate nonostante scriva
  // un vero SAL con importo_maturato. Verifica che il gate scatti PRIMA della
  // RPC di numerazione (non idempotente): nessuna riga site_sal_history deve
  // comparire quando la richiesta resta non confermata.
  const r4 = await executeTool('emit_sal', { site_id: siteId, note: 'TEST-E2E-write-executor selftest SAL' }, COMPANY_ID, USER_ID, null, null);
  if (r4.error === 'RICHIEDE_CONFERMA' && r4.pending_action_id) ok('emit_sal richiede conferma (gate presente, prima assente)');
  else fail('emit_sal richiede conferma (gate presente, prima assente)', r4);
  if (r4.pending_action_id) {
    const { data: salRows } = await supabase.from('site_sal_history').select('id').eq('site_id', siteId);
    if (!salRows?.length) ok('nessun SAL scritto/numerato mentre la richiesta resta non confermata');
    else fail('nessun SAL scritto/numerato mentre la richiesta resta non confermata', salRows);
    await supabase.from('ladia_pending_actions').delete().eq('id', r4.pending_action_id);
  }

  // 5. buildResultCard su company_documents — la RIVERIFICA che archive_document
  // ora attacca dopo ogni archiviazione (lib/complianceRecheck.js). Verifica
  // diretta sul recheck, senza dover simulare l'intero upload di un file.
  const { data: doc } = await supabase.from('company_documents').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-write-executor DURC', category: 'durc',
    file_path: 'test/non-esiste.pdf', ai_expiry_date: '2099-01-01',
  }).select('id').single();
  const card = await buildResultCard({
    id: 'test', title: 'Documento archiviato — test', resourceName: 'company_documents',
    recordId: doc.id, companyId: COMPANY_ID,
  });
  if (card.fatto.verified && card.fatto.verdict.stato === 'ok') ok('buildResultCard su company_documents riverifica lo stato reale (ok, scadenza 2099)');
  else fail('buildResultCard su company_documents riverifica lo stato reale (ok, scadenza 2099)', card);
  await supabase.from('company_documents').delete().eq('id', doc.id);

  // 6. resolve_nonconformity — verifica che passi per executeWrite (gate low,
  // esegue subito) e che il verdetto rischio_dopo/resultCard restino coerenti.
  const { data: nc } = await supabase.from('site_notes').insert({
    company_id: COMPANY_ID, site_id: siteId, author_id: USER_ID, author_name: 'Ladia AI', source: 'web',
    content: 'TEST-E2E-write-executor NC', category: 'non_conformita', urgency: 'normale',
  }).select('id').single();
  const r6 = await executeTool('resolve_nonconformity', { nc_id: nc.id, resolution_notes: 'Risolta per test' }, COMPANY_ID, USER_ID, null, null);
  if (r6.success && r6.rischio_dopo !== undefined && r6.resultCard?.fatto?.verdict?.kind === 'risk_score') {
    ok('resolve_nonconformity esegue subito (low sensitivity) e produce un verdetto risk_score');
  } else {
    fail('resolve_nonconformity esegue subito (low sensitivity) e produce un verdetto risk_score', r6);
  }
  await supabase.from('site_notes').delete().eq('id', nc.id);

  // Cleanup
  if (r1.data?.id) await supabase.from('site_notes').delete().eq('id', r1.data.id);
  if (expenseId) await supabase.from('company_expenses').delete().eq('id', expenseId);
  if (createdSiteId) await supabase.from('sites').delete().eq('id', createdSiteId);

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_ladia_write_executor:', e.message);
  process.exit(1);
});
