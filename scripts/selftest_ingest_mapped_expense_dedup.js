#!/usr/bin/env node
/**
 * scripts/selftest_ingest_mapped_expense_dedup.js
 *
 * Regressione per services/sdiInvoices.js::ingestMappedExpense dopo l'estensione per
 * il canale email (dedupExtra): il canale email non ha un sdi_invoice_id assegnato da
 * un provider, quindi la dedup deve avvenire per hash del contenuto e per identità
 * fiscale (P.IVA + numero documento normalizzato + data emissione) invece che per
 * sdi_invoice_id. Verifica anche che il path esistente (Openapi/A-Cube, dedup per
 * sdi_invoice_id) resti invariato dopo la modifica.
 *
 * Chiamata diretta alla funzione contro il DB reale (non solo lettura del codice),
 * azienda temporanea creata e ripulita a fine test.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { ingestMappedExpense } = require('../services/sdiInvoices');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function baseRow(companyId, overrides = {}) {
  return {
    company_id: companyId,
    amount: 150,
    description: 'Fattura test dedup',
    category: 'materiali', // evita la chiamata AI di categorizzazione (solo se resta 'altro')
    payment_method: 'bonifico',
    supplier: 'Fornitore Dedup Test',
    supplier_vat: '01234567890',
    expense_date: '2026-08-10',
    invoice_number: '2026/1',
    is_deductible: true,
    notes: 'test',
    source: 'email',
    ...overrides,
  };
}

async function main() {
  console.log('\n=== selftest_ingest_mapped_expense_dedup ===\n');

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Ingest-Dedup-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  try {
    // ── Canale email: dedup per hash contenuto ─────────────────────────────
    const first = await ingestMappedExpense(
      companyId, baseRow(companyId, { content_hash: 'hash-aaa' }), { sender: { name: 'X' }, invoice_lines: [] },
      { dedupExtra: true },
    );
    check('prima importazione (hash aaa): non skippata', first.ok && !first.skipped, first);

    const dupHash = await ingestMappedExpense(
      companyId, baseRow(companyId, { content_hash: 'hash-aaa', invoice_number: 'diverso', expense_date: '2026-01-01' }),
      { sender: { name: 'X' }, invoice_lines: [] }, { dedupExtra: true },
    );
    check('stesso hash contenuto: skippata come duplicate_hash', dupHash.ok && dupHash.skipped && dupHash.reason === 'duplicate_hash', dupHash);

    // ── Canale email: dedup per identità fiscale, formattazione diversa del numero ──
    const dupFiscal = await ingestMappedExpense(
      companyId, baseRow(companyId, { content_hash: 'hash-bbb', invoice_number: '2026-1' }), // "2026/1" vs "2026-1" — stessa identità normalizzata
      { sender: { name: 'X' }, invoice_lines: [] }, { dedupExtra: true },
    );
    check('stessa identità fiscale (numero formattato diverso): skippata come duplicate_fiscal_identity', dupFiscal.ok && dupFiscal.skipped && dupFiscal.reason === 'duplicate_fiscal_identity', dupFiscal);

    const distinctInvoice = await ingestMappedExpense(
      companyId, baseRow(companyId, { content_hash: 'hash-ccc', invoice_number: '2026/2', expense_date: '2026-08-11' }),
      { sender: { name: 'X' }, invoice_lines: [] }, { dedupExtra: true },
    );
    check('fattura realmente diversa: non skippata', distinctInvoice.ok && !distinctInvoice.skipped, distinctInvoice);

    // ── Path esistente (Openapi/A-Cube): dedup per sdi_invoice_id, invariato ──
    const sdiFirst = await ingestMappedExpense(
      companyId, { ...baseRow(companyId, { source: 'acube', invoice_number: '2026/SDI-1' }), sdi_invoice_id: 'sdi-test-001', content_hash: undefined },
      { sender: { name: 'X' }, invoice_lines: [] },
    );
    check('canale acube: prima importazione non skippata', sdiFirst.ok && !sdiFirst.skipped, sdiFirst);

    const sdiDup = await ingestMappedExpense(
      companyId, { ...baseRow(companyId, { source: 'acube', invoice_number: '2026/SDI-1' }), sdi_invoice_id: 'sdi-test-001', content_hash: undefined },
      { sender: { name: 'X' }, invoice_lines: [] },
    );
    check('canale acube: stesso sdi_invoice_id skippata come duplicate (comportamento invariato)', sdiDup.ok && sdiDup.skipped && sdiDup.reason === 'duplicate', sdiDup);

    // Guardia anti-regressione: senza sdi_invoice_id e senza dedupExtra, non deve MAI
    // "trovare" una riga a caso per colpa di .eq(col, undefined) che perde il filtro.
    const noIdRow = baseRow(companyId, { content_hash: undefined, invoice_number: '2026/NOID' });
    delete noIdRow.sdi_invoice_id;
    const withoutId = await ingestMappedExpense(companyId, noIdRow, { sender: { name: 'X' }, invoice_lines: [] });
    check('senza sdi_invoice_id e senza dedupExtra: non trova un falso duplicato', withoutId.ok && !withoutId.skipped, withoutId);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su company_expenses
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exitCode = 1;
});
