#!/usr/bin/env node
/**
 * scripts/selftest_documents_sync.js
 *
 * Test di regressione per la Fase 2 / Scaglione 1 (documents unificata):
 * 1. Ogni scrittura reale (INSERT/UPDATE/DELETE) sulle 4 tabelle storiche
 *    (site_documents, company_documents, worker_documents, worker_certificates)
 *    si riflette davvero in `documents` tramite i trigger di sync.
 * 2. Un fallimento della sync NON blocca MAI la scrittura sulla tabella storica
 *    (vincolo esplicito) — riprodotto dal vivo rompendo temporaneamente
 *    `documents` con un CHECK impossibile, poi ripristinato.
 *
 * Tutto su dati reali contro Supabase, con cleanup a fine test.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function execSql(sql) {
  let { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) ({ error } = await supabase.rpc('exec_sql', { sql }));
  return error;
}

async function getDocRow(sourceTable, legacyId) {
  const { data } = await supabase.from('documents').select('*').eq('source_table', sourceTable).eq('legacy_id', legacyId).maybeSingle();
  return data;
}

async function main() {
  console.log('\nPalladia documents-sync regression — Scaglione 1\n');

  const { data: company } = await supabase.from('companies').insert({ name: 'TEST-DocsSync-Probe' }).select().single();
  check('Creata azienda temporanea', !!company);
  const companyId = company.id;
  const { data: site } = await supabase.from('sites').insert({ company_id: companyId, name: 'TEST site', status: 'attivo', address: 'Via Test 1' }).select().single();
  check('Creato cantiere temporaneo', !!site);
  const siteId = site.id;
  const { data: worker } = await supabase.from('workers').insert({ company_id: companyId, full_name: 'TEST Worker', fiscal_code: `TSTDS${Date.now()}`.slice(0, 16).toUpperCase(), is_active: true, badge_code: `TSTDS${Date.now()}` }).select().single();
  check('Creato lavoratore temporaneo', !!worker);
  const workerId = worker.id;

  // ── 1. site_documents: INSERT → UPDATE → DELETE, verificato in documents ──
  {
    const { data: row } = await supabase.from('site_documents').insert({ company_id: companyId, site_id: siteId, name: 'Test POS', category: 'pos', file_path: `${companyId}/${siteId}/test.pdf` }).select().single();
    let doc = await getDocRow('site_documents', row.id);
    check('site_documents INSERT sincronizzato in documents', doc && doc.file_path === row.file_path && doc.owner_type === 'site' && doc.site_id === siteId, doc);

    await supabase.from('site_documents').update({ name: 'Test POS Rinominato' }).eq('id', row.id);
    doc = await getDocRow('site_documents', row.id);
    check('site_documents UPDATE sincronizzato in documents', doc && doc.name === 'Test POS Rinominato', doc);

    await supabase.from('site_documents').delete().eq('id', row.id);
    doc = await getDocRow('site_documents', row.id);
    check('site_documents DELETE rimuove la riga in documents', !doc, doc);
  }

  // ── 2. company_documents ──
  {
    const { data: row } = await supabase.from('company_documents').insert({ company_id: companyId, name: 'Test DURC', category: 'durc', file_path: `${companyId}/_company/test.pdf` }).select().single();
    let doc = await getDocRow('company_documents', row.id);
    check('company_documents INSERT sincronizzato in documents', doc && doc.owner_type === 'company' && doc.file_path === row.file_path, doc);
    await supabase.from('company_documents').delete().eq('id', row.id);
    doc = await getDocRow('company_documents', row.id);
    check('company_documents DELETE rimuove la riga in documents', !doc, doc);
  }

  // ── 3. worker_documents (incl. riga senza file, solo metadati) ──
  {
    const { data: row } = await supabase.from('worker_documents').insert({ company_id: companyId, worker_id: workerId, doc_type: 'idoneita_medica', name: 'Idoneità TEST', file_path: `${companyId}/workers/${workerId}/test.pdf`, expiry_date: '2099-01-01' }).select().single();
    let doc = await getDocRow('worker_documents', row.id);
    check('worker_documents INSERT sincronizzato in documents', doc && doc.owner_type === 'worker' && doc.category === 'idoneita_medica' && doc.expiry_date === '2099-01-01', doc);

    const { data: metaOnly } = await supabase.from('worker_documents').insert({ company_id: companyId, worker_id: workerId, doc_type: 'idoneita_medica', name: 'Idoneità senza file', expiry_date: '2099-01-01' }).select().single();
    doc = await getDocRow('worker_documents', metaOnly.id);
    check('worker_documents senza file (solo metadati) sincronizzato con file_path NULL, non bloccato', doc && doc.file_path === null, doc);

    await supabase.from('worker_documents').delete().eq('id', row.id);
    await supabase.from('worker_documents').delete().eq('id', metaOnly.id);
  }

  // ── 4. worker_certificates (incl. pdf_url come signed URL da estrarre) ──
  {
    const rawPath = `certificates/${companyId}/${workerId}/test.pdf`;
    const fakeSignedUrl = `${process.env.SUPABASE_URL}/storage/v1/object/sign/site-documents/${rawPath}?token=fake`;
    const { data: row } = await supabase.from('worker_certificates').insert({ company_id: companyId, worker_id: workerId, issue_date: '2024-01-01', expiry_date: '2099-01-01', issuing_body: 'TEST', pdf_url: fakeSignedUrl }).select().single();
    const doc = await getDocRow('worker_certificates', row.id);
    check('worker_certificates INSERT sincronizzato con path estratto dalla signed URL', doc && doc.file_path === rawPath && doc.bucket === 'site-documents' && !doc.file_path_needs_review, doc);
    await supabase.from('worker_certificates').delete().eq('id', row.id);
    const docAfterDelete = await getDocRow('worker_certificates', row.id);
    check('worker_certificates DELETE rimuove la riga in documents', !docAfterDelete, docAfterDelete);

    const { data: unrecognized } = await supabase.from('worker_certificates').insert({ company_id: companyId, worker_id: workerId, issue_date: '2024-01-01', expiry_date: '2099-01-01', issuing_body: 'TEST', pdf_url: 'https://example.com/not-supabase.pdf' }).select().single();
    const doc2 = await getDocRow('worker_certificates', unrecognized.id);
    check('worker_certificates con URL non riconosciuta viene preservata e marcata needs_review', doc2 && doc2.file_path_needs_review === true, doc2);
    await supabase.from('worker_certificates').delete().eq('id', unrecognized.id);
  }

  // ── 5. Vincolo esplicito: un fallimento di sync non deve MAI bloccare la scrittura storica ──
  {
    // NOT VALID: non controlla le righe esistenti (altrimenti fallirebbe subito,
    // 1=0 è falso per ognuna) ma blocca ogni INSERT/UPDATE successivo — esattamente
    // quello che serve per rompere la sync di proposito senza toccare i dati reali.
    const breakErr = await execSql(`ALTER TABLE documents ADD CONSTRAINT test_force_sync_failure CHECK (1 = 0) NOT VALID;`);
    check('Vincolo impossibile applicato a documents (per rompere la sync di proposito)', !breakErr, breakErr);

    const { data: row, error: insertErr } = await supabase.from('site_documents')
      .insert({ company_id: companyId, site_id: siteId, name: 'Test resilienza', category: 'altro', file_path: 'x.pdf' })
      .select().single();
    check('INSERT su site_documents riesce comunque, nonostante documents sia rotta', !insertErr && row, insertErr);

    if (row) {
      const { data: failures } = await supabase.from('document_sync_failures')
        .select('*').eq('source_table', 'site_documents').eq('legacy_id', row.id);
      check('Il fallimento di sync è stato loggato in document_sync_failures', failures && failures.length === 1 && /1 = 0|check/i.test(failures[0].error_message || ''), failures);
      // Marcato risolto — è un fallimento indotto di proposito dal test, non
      // deve restare a inquinare il report della verifica ricorrente reale.
      if (failures?.length) {
        await supabase.from('document_sync_failures').update({ resolved_at: new Date().toISOString() }).in('id', failures.map(f => f.id));
      }
    }

    const restoreErr = await execSql(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS test_force_sync_failure;`);
    check('Vincolo di test rimosso, documents ripristinata', !restoreErr, restoreErr);

    if (row) {
      // Ora che la sync funziona di nuovo, un UPDATE deve farla comparire in documents.
      await supabase.from('site_documents').update({ name: 'Test resilienza aggiornato' }).eq('id', row.id);
      const doc = await getDocRow('site_documents', row.id);
      check('Dopo il ripristino, la sync riprende a funzionare normalmente', doc && doc.name === 'Test resilienza aggiornato', doc);
      await supabase.from('site_documents').delete().eq('id', row.id);
    }
  }

  // ── Cleanup ──
  try { await supabase.from('workers').delete().eq('id', workerId); } catch { /* best-effort */ }
  try { await supabase.from('sites').delete().eq('id', siteId); } catch { /* best-effort */ }
  try { await supabase.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
