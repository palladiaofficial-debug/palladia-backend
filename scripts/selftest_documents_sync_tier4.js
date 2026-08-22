#!/usr/bin/env node
/**
 * scripts/selftest_documents_sync_tier4.js
 *
 * Test di regressione per Fase 2 / Scaglione 4 (equipment_documents → cartella
 * "Mezzi" in /documenti, migrazioni 172-174) — stesso pattern degli scaglioni
 * precedenti: scritture reali sulla tabella storica verificate in `documents`,
 * più il caso specifico di questo scaglione: la scadenza non è una colonna
 * diretta ma va estratta da ai_extracted (jsonb) in base al doc_type.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== selftest_documents_sync_tier4 (equipment_documents) ===\n');

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Documents-Sync-Tier4' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  try {
    const { data: eq, error: eqErr } = await supabase.from('equipment')
      .insert({ company_id: companyId, type: 'Gru', model: 'Test-Model', name: 'Gru Test-Model' })
      .select().single();
    check('Creato mezzo temporaneo', !eqErr && eq, eqErr);

    // ── INSERT con scadenza assicurazione in ai_extracted → estratta in expiry_date ──
    const { data: doc, error: docErr } = await supabase.from('equipment_documents').insert({
      company_id: companyId, equipment_id: eq.id, doc_type: 'assicurazione',
      file_name: 'polizza.pdf', file_url: 'test/polizza.pdf', file_size: 999, mime_type: 'application/pdf',
      ai_extracted: { data_scadenza_assicurazione: '2027-06-15', compagnia_assicurativa: 'TestCo', note_extra: 'nota di prova' },
    }).select().single();
    check('equipment_documents INSERT riuscito', !docErr && doc, docErr);

    let synced = null;
    for (let i = 0; i < 10 && !synced; i++) {
      const { data } = await supabase.from('documents').select('*').eq('source_table', 'equipment_documents').eq('legacy_id', doc.id).maybeSingle();
      if (data) synced = data; else await new Promise((r) => setTimeout(r, 200));
    }
    check('equipment_documents INSERT sincronizzato in documents', !!synced, synced);
    check('owner_type = equipment', synced?.owner_type === 'equipment', synced?.owner_type);
    check('equipment_id propagato', synced?.equipment_id === eq.id, synced?.equipment_id);
    check('category = doc_type', synced?.category === 'assicurazione', synced?.category);
    check('bucket = equipment-docs (non site-documents come gli altri scagli)', synced?.bucket === 'equipment-docs', synced?.bucket);
    check('expiry_date estratta da ai_extracted.data_scadenza_assicurazione', synced?.expiry_date === '2027-06-15', synced?.expiry_date);
    check('ai_summary popolato da ai_extracted.note_extra', synced?.ai_summary === 'nota di prova', synced?.ai_summary);

    // ── Un doc_type='revisione' guarda un'altra chiave jsonb, non quella dell'assicurazione ──
    const { data: docRev } = await supabase.from('equipment_documents').insert({
      company_id: companyId, equipment_id: eq.id, doc_type: 'revisione',
      file_name: 'revisione.pdf', file_url: 'test/revisione.pdf',
      ai_extracted: { data_prossima_revisione: '2027-01-10' },
    }).select().single();
    let syncedRev = null;
    for (let i = 0; i < 10 && !syncedRev; i++) {
      const { data } = await supabase.from('documents').select('expiry_date').eq('source_table', 'equipment_documents').eq('legacy_id', docRev.id).maybeSingle();
      if (data) syncedRev = data; else await new Promise((r) => setTimeout(r, 200));
    }
    check('doc_type=revisione legge data_prossima_revisione, non data_scadenza_assicurazione', syncedRev?.expiry_date === '2027-01-10', syncedRev);

    // ── Una data malformata non deve rompere la sync (regex guard) ──
    const { data: docBad } = await supabase.from('equipment_documents').insert({
      company_id: companyId, equipment_id: eq.id, doc_type: 'assicurazione',
      file_name: 'malformato.pdf', file_url: 'test/malformato.pdf',
      ai_extracted: { data_scadenza_assicurazione: 'non-una-data' },
    }).select().single();
    let syncedBad = null;
    for (let i = 0; i < 10 && !syncedBad; i++) {
      const { data } = await supabase.from('documents').select('expiry_date').eq('source_table', 'equipment_documents').eq('legacy_id', docBad.id).maybeSingle();
      if (data) syncedBad = data; else await new Promise((r) => setTimeout(r, 200));
    }
    check('data malformata in ai_extracted → sincronizzato comunque, expiry_date NULL (non un crash della sync)', !!syncedBad && syncedBad.expiry_date === null, syncedBad);

    // ── UPDATE ──
    await supabase.from('equipment_documents').update({ file_name: 'polizza-rinnovata.pdf' }).eq('id', doc.id);
    let updated = null;
    for (let i = 0; i < 10; i++) {
      const { data } = await supabase.from('documents').select('name').eq('source_table', 'equipment_documents').eq('legacy_id', doc.id).maybeSingle();
      if (data?.name === 'polizza-rinnovata.pdf') { updated = data; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    check('equipment_documents UPDATE sincronizzato in documents', !!updated, updated);

    // ── DELETE ──
    await supabase.from('equipment_documents').delete().eq('id', doc.id);
    let afterDelete = 'not-checked';
    for (let i = 0; i < 10; i++) {
      const { data } = await supabase.from('documents').select('id').eq('source_table', 'equipment_documents').eq('legacy_id', doc.id).maybeSingle();
      afterDelete = data;
      if (!data) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check('equipment_documents DELETE rimuove la riga in documents', !afterDelete, afterDelete);

    // ── verify_documents_sync() non trova mismatch/orfani su questa company ──
    const { data: report } = await supabase.rpc('verify_documents_sync');
    const row = (report || []).find((r) => r.source_table === 'equipment_documents');
    check('verify_documents_sync() include equipment_documents', !!row, report?.map((r) => r.source_table));
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su equipment/equipment_documents/documents
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message, err.stack);
  process.exitCode = 1;
});
