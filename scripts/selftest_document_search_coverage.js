#!/usr/bin/env node
/**
 * scripts/selftest_document_search_coverage.js
 *
 * Regressione per due fix collegati alla ricerca documenti di Ladia:
 *
 * 1. services/ladiaDocumentSearch.js non copriva subcontractor_documents,
 *    studio_shared_documents, payslips — un contratto di subappalto, un
 *    documento condiviso col commercialista o un cedolino erano
 *    irraggiungibili chiedendo a Ladia di leggerli/trovarli.
 * 2. services/smartImportPipeline.js::sanitizeCategory rietichettava sempre
 *    'contratto'/'capitolato' a 'altro' (CATEGORY_ALLOWLIST non li ammetteva,
 *    né lo faceva il CHECK di site_documents prima della migrazione 167).
 * 3. Il boost di rilevanza per `tipo` riconosceva solo parole semantiche
 *    italiane (es. 'assicurazione') — se il chiamante passava direttamente il
 *    valore letterale della colonna category (es. 'insurance', usato da
 *    subcontractor_documents invece di 'assicurazione' come site_documents),
 *    il boost non scattava mai. Non impediva mai di TROVARE il documento (la
 *    ricerca per nome resta sempre attiva), solo la sua priorità in una lista
 *    con più risultati.
 *
 * Chiamata diretta alle funzioni contro il DB reale, fixture temporanee
 * create e ripulite dal test stesso.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { searchSubcontractorDocuments, searchStudioSharedDocuments, searchPayslips, matchBoost } = require('../services/ladiaDocumentSearch');
const { sanitizeCategory } = require('../services/smartImportPipeline');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== selftest_document_search_coverage ===\n');

  // ── 2. Categorie contratto/capitolato non più rietichettate 'altro' ──────
  check("sanitizeCategory('site_documents','contratto') resta 'contratto'", sanitizeCategory('site_documents', 'contratto') === 'contratto');
  check("sanitizeCategory('site_documents','capitolato') resta 'capitolato'", sanitizeCategory('site_documents', 'capitolato') === 'capitolato');
  check("sanitizeCategory('company_documents','contratto') resta 'contratto'", sanitizeCategory('company_documents', 'contratto') === 'contratto');
  check("sanitizeCategory('site_documents','tipo_inventato') ripiega su 'altro' (comportamento invariato)", sanitizeCategory('site_documents', 'tipo_inventato') === 'altro');

  // ── 3. matchBoost riconosce sia il vocabolario semantico che quello letterale ──
  const SUB_TIPO_CATEGORIES = { durc: ['durc'], assicurazione: ['insurance'], soa: ['soa'] };
  check("matchBoost: parola semantica italiana ('assicurazione') matcha il valore letterale ('insurance')", matchBoost(SUB_TIPO_CATEGORIES, 'assicurazione', 'insurance') === true);
  check("matchBoost: valore letterale diretto ('insurance', il bug reale) matcha anche se non è una chiave della mappa", matchBoost(SUB_TIPO_CATEGORIES, 'insurance', 'insurance') === true);
  check("matchBoost: nessun match tra categorie diverse", matchBoost(SUB_TIPO_CATEGORIES, 'durc', 'insurance') === false);
  check("matchBoost: tipo assente non fa scattare mai il boost", matchBoost(SUB_TIPO_CATEGORIES, null, 'insurance') === false);

  // ── 1. Copertura ricerca documenti ────────────────────────────────────────
  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-DocSearch-Coverage-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  const cleanup = [];
  try {
    const { data: sub, error: subErr } = await supabase.from('subcontractors').insert({ company_id: companyId, company_name: 'TEST Subappaltatore SRL' }).select().single();
    check('Subappaltatore di test creato', !subErr && sub, subErr);

    const { data: subDoc } = await supabase.from('subcontractor_documents').insert({
      company_id: companyId, subcontractor_id: sub.id, name: 'Contratto subappalto TEST.pdf',
      category: 'altro', file_path: `subcontractors/${companyId}/test-contract.pdf`, mime_type: 'application/pdf',
    }).select().single();
    check('Documento subappaltatore di test creato', !!subDoc, subDoc);

    // Stesso subappaltatore, categoria reale 'insurance' (non 'assicurazione') —
    // verifica dal vivo che il boost scatti col valore letterale del DB, non solo
    // con la parola semantica italiana.
    const { data: subDocInsurance } = await supabase.from('subcontractor_documents').insert({
      company_id: companyId, subcontractor_id: sub.id, name: 'Polizza assicurativa TEST.pdf',
      category: 'insurance', file_path: `subcontractors/${companyId}/test-insurance.pdf`, mime_type: 'application/pdf',
    }).select().single();

    const { data: studioPartner } = await supabase.from('studio_partners').select('id').limit(1).maybeSingle();
    let studioDoc = null;
    if (studioPartner) {
      const { data } = await supabase.from('studio_shared_documents').insert({
        studio_id: studioPartner.id, company_id: companyId, name: 'Documento condiviso TEST.pdf',
        category: 'altro', file_path: `studio-shared/${companyId}/test-shared.pdf`, mime_type: 'application/pdf',
      }).select().single();
      studioDoc = data;
    }

    const { data: worker } = await supabase.from('workers').insert({ company_id: companyId, full_name: 'TEST Lavoratore Cedolino', fiscal_code: 'TSTLVR85M01H501X' }).select().single();
    const { data: payslip } = await supabase.from('payslips').insert({
      company_id: companyId, worker_id: worker?.id, period_year: 2026, period_month: 6,
      filename: 'cedolino_test_06_2026.pdf', file_path: `payslips/${companyId}/test-payslip.pdf`,
    }).select().single();
    check('Cedolino di test creato', !!payslip, payslip);

    const subResults = await searchSubcontractorDocuments(companyId, null, null);
    check('searchSubcontractorDocuments trova il contratto del subappaltatore', subResults.some(d => d.id === subDoc?.id && d.nome.includes('TEST Subappaltatore SRL')), subResults);

    const subResultsInsurance = await searchSubcontractorDocuments(companyId, null, 'insurance');
    const insuranceEntry = subResultsInsurance.find(d => d.id === subDocInsurance?.id);
    const altroEntry     = subResultsInsurance.find(d => d.id === subDoc?.id);
    check(
      "tipo='insurance' (valore letterale, il bug reale) alza il punteggio del documento con category='insurance' sopra quello 'altro'",
      !!insuranceEntry && !!altroEntry && insuranceEntry.score > altroEntry.score,
      { insuranceEntry, altroEntry },
    );

    if (studioPartner) {
      const studioResults = await searchStudioSharedDocuments(companyId, null);
      check('searchStudioSharedDocuments trova il documento condiviso', studioResults.some(d => d.id === studioDoc?.id), studioResults);
    } else {
      console.log('  \x1b[33m–\x1b[0m searchStudioSharedDocuments (skip: nessuno studio_partners in questo ambiente)');
    }

    const payslipResults = await searchPayslips(companyId, null, null);
    check('searchPayslips trova il cedolino e lo etichetta con lavoratore+periodo', payslipResults.some(d => d.id === payslip?.id && d.nome.includes('06/2026')), payslipResults);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su subcontractors/documents/workers/payslips
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exitCode = 1;
});
