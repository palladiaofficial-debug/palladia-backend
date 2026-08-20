#!/usr/bin/env node
/**
 * scripts/selftest_email_ingest_health.js
 *
 * Regressione per services/emailIngestHealthCheck.js — i tre controlli richiesti
 * esplicitamente per il canale fatture via email: salti di numerazione per
 * fornitore, anomalie di cadenza, salute del canale. Chiamata diretta alla
 * funzione contro il DB reale, azienda temporanea creata e ripulita a fine test.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { getHealthReport } = require('../services/emailIngestHealthCheck');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('\n=== selftest_email_ingest_health ===\n');

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Email-Ingest-Health-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  try {
    // Fornitore A: fattura 12 e 14 — salto (manca la 13).
    const supplierA = '11111111111';
    // Fornitore B: cadenza mensile regolare (5 fatture, ~30gg l'una dall'altra),
    // poi silenzio da 90 giorni — anomalia di cadenza attesa.
    const supplierB = '22222222222';

    const rows = [
      { supplier_vat: supplierA, invoice_number: '2026/12', expense_date: isoDaysAgo(40), supplier: 'Fornitore A' },
      { supplier_vat: supplierA, invoice_number: '2026/14', expense_date: isoDaysAgo(10), supplier: 'Fornitore A' },

      { supplier_vat: supplierB, invoice_number: 'B-1', expense_date: isoDaysAgo(150), supplier: 'Fornitore B' },
      { supplier_vat: supplierB, invoice_number: 'B-2', expense_date: isoDaysAgo(120), supplier: 'Fornitore B' },
      { supplier_vat: supplierB, invoice_number: 'B-3', expense_date: isoDaysAgo(90), supplier: 'Fornitore B' },
      { supplier_vat: supplierB, invoice_number: 'B-4', expense_date: isoDaysAgo(60), supplier: 'Fornitore B' }, // ultima: 60gg fa, gap tipico ~30gg → 60gg silenzio è 2x, non ancora oltre soglia stretta
    ].map((r) => ({
      company_id: companyId, amount: 100, description: 'test', category: 'materiali',
      payment_method: 'bonifico', is_deductible: true, source: 'email', ...r,
    }));

    const { error: insertErr } = await supabase.from('company_expenses').insert(rows);
    check('Righe di test inserite', !insertErr, insertErr);

    const { error: cfgErr } = await supabase.from('email_ingest_configurations').insert({
      company_id: companyId, inbound_token: `health-test-${companyId}`, status: 'active',
      last_invoice_received_at: new Date(Date.now() - 60 * 86400000).toISOString(),
    });
    check('Configurazione canale creata', !cfgErr, cfgErr);

    const report = await getHealthReport(companyId);

    check('Salto di numerazione fornitore A rilevato (manca la 13)', report.numbering_gaps.some((g) => g.supplier_vat === supplierA && g.missing_count === 1), report.numbering_gaps);
    check('Nessun salto segnalato per fornitore B (numerazione non progressiva pura, atteso: sequenza estratta 1..4 senza buchi)', !report.numbering_gaps.some((g) => g.supplier_vat === supplierB), report.numbering_gaps);

    check('Canale risulta collegato', report.channel_health.connected === true, report.channel_health);
    check('silent_days calcolato correttamente (~60 giorni)', report.channel_health.silent_days >= 59 && report.channel_health.silent_days <= 61, report.channel_health);
    check('never_received_after_setup falso quando esiste già uno storico', report.channel_health.never_received_after_setup === false, report.channel_health);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade
  }

  // ── Caso 2: canale attivo da giorni, mai ricevuto nulla — il buco che
  // silent_days da solo non copre (resta null senza uno storico da cui calcolarlo) ──
  const { data: company2 } = await supabase.from('companies').insert({ name: 'TEST-Email-Ingest-Health-NeverReceived' }).select().single();
  const companyId2 = company2.id;
  try {
    await supabase.from('email_ingest_configurations').insert({
      company_id: companyId2, inbound_token: `health-test-2-${companyId2}`, status: 'active',
      last_invoice_received_at: null,
      created_at: new Date(Date.now() - 10 * 86400000).toISOString(), // attivato 10gg fa
    });
    const report2 = await getHealthReport(companyId2);
    check('never_received_after_setup vero — attivo da 10gg, mai ricevuto nulla', report2.channel_health.never_received_after_setup === true, report2.channel_health);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId2);
  }

  // ── Caso 3: canale appena attivato (oggi), mai ricevuto nulla — non deve
  // ancora allarmare, c'è un periodo di grazia di 3 giorni ──
  const { data: company3 } = await supabase.from('companies').insert({ name: 'TEST-Email-Ingest-Health-JustSetup' }).select().single();
  const companyId3 = company3.id;
  try {
    await supabase.from('email_ingest_configurations').insert({
      company_id: companyId3, inbound_token: `health-test-3-${companyId3}`, status: 'active',
      last_invoice_received_at: null,
    });
    const report3 = await getHealthReport(companyId3);
    check('never_received_after_setup falso — canale attivato oggi, periodo di grazia', report3.channel_health.never_received_after_setup === false, report3.channel_health);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId3);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exitCode = 1;
});
