#!/usr/bin/env node
/**
 * scripts/selftest_renewal_resolution.js
 *
 * Test di regressione per lib/renewalResolution.js (Fase 3.4 "Ciclo del
 * Risultato" — flusso scadenza→rinnovo). Verifica che una riga
 * expiry_interception_log ancora aperta venga risolta SUBITO (non al prossimo
 * giro cron) dopo una scrittura di rinnovo, e che il Contato della ResultCard
 * la mostri immediatamente come "scadenza intercettata".
 *
 * Richiede migrations/145_expiry_interception_renewal_letter.sql applicata
 * (colonna superseded_by_action_history_id) — se manca, il primo controllo
 * fallisce con un errore esplicito invece di un falso positivo silenzioso.
 *
 * Env: E2E_COMPANY_ID (default company E2E dedicata).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { resolveInterceptedExpiry } = require('../lib/renewalResolution');
const { buildResultCard } = require('../lib/resultCardBuilder');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }

async function main() {
  console.log('\n\x1b[1mrenewalResolution — scadenza→rinnovo\x1b[0m');

  const { data: doc, error: e1 } = await supabase.from('company_documents').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-renewal-resolution', category: 'durc',
    file_path: 'test/non-esiste.pdf', ai_expiry_date: '2099-01-01',
  }).select('id').single();
  if (e1) { fail('setup company_document di test', e1.message); return report(); }

  const { data: log, error: e2 } = await supabase.from('expiry_interception_log').insert({
    company_id: COMPANY_ID, notification_type: 'company_doc_expiry', entity_type: 'company_document',
    entity_id: doc.id, severity_at_notify: 'warning',
  }).select('id').single();
  if (e2) { fail('setup expiry_interception_log di test', e2.message); await cleanup(doc.id, null); return report(); }

  try {
    const resolved = await resolveInterceptedExpiry({ companyId: COMPANY_ID, destination: 'company_documents', recordId: doc.id, actionHistoryId: null });
    if (resolved?.id === log.id) ok('resolveInterceptedExpiry risolve la riga aperta subito (non aspetta il cron)');
    else fail('resolveInterceptedExpiry risolve la riga aperta subito (non aspetta il cron) — verifica che migrations/145 sia applicata', resolved);

    const { data: logAfter } = await supabase.from('expiry_interception_log').select('resolved_at').eq('id', log.id).single();
    if (logAfter?.resolved_at) ok('resolved_at valorizzato nel DB');
    else fail('resolved_at valorizzato nel DB', logAfter);

    const card = await buildResultCard({ id: 'test', title: 'test', resourceName: 'company_documents', recordId: doc.id, companyId: COMPANY_ID });
    const hasScadenza = card.contato?.items?.some(i => i.kind === 'scadenza_intercettata');
    if (hasScadenza) ok('ResultCard.contato mostra "scadenza intercettata" immediatamente');
    else fail('ResultCard.contato mostra "scadenza intercettata" immediatamente', card.contato);
  } finally {
    await cleanup(doc.id, log.id);
  }

  report();
}

async function cleanup(docId, logId) {
  if (logId) await supabase.from('expiry_interception_log').delete().eq('id', logId);
  if (docId) await supabase.from('company_documents').delete().eq('id', docId);
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_renewal_resolution:', e.message);
  process.exit(1);
});
