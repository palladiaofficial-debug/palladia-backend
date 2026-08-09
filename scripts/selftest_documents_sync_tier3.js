#!/usr/bin/env node
/**
 * scripts/selftest_documents_sync_tier3.js
 *
 * Test di regressione per Fase 2 / Scaglione 3 (ladia_document_templates,
 * studio_shared_documents, studio_document_requests) — stesso pattern di
 * scripts/selftest_documents_sync_tier2.js: scritture reali sulle tabelle
 * storiche verificate in `documents`, riprova di resilienza a sync rotta,
 * verifica che verify_documents_sync() copra ora tutte e 9 le tabelle.
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
  console.log('\nPalladia documents-sync regression — Scaglione 3\n');

  const { data: company } = await supabase.from('companies').insert({ name: 'TEST-DocsSyncT3-Probe' }).select().single();
  check('Creata azienda temporanea', !!company);
  const companyId = company.id;

  const { data: studio } = await supabase.from('studio_partners').select('id').limit(1).maybeSingle();
  const studioId = studio?.id || null;
  if (!studioId) console.log('  (nessuno studio_partners disponibile — sotto-test studio_shared_documents/studio_document_requests con studio_id verranno saltati)');

  // ── 1. ladia_document_templates: INSERT (con storage_path NULL) → UPDATE → DELETE ──
  {
    const { data: row, error: insertErr } = await supabase.from('ladia_document_templates').insert({
      company_id: companyId, uploaded_by_chat_id: 'TEST-CHAT-123', document_type: 'contratto',
      original_filename: 'Test contratto.pdf', summary: 'Riassunto di test', storage_path: null,
    }).select().single();
    check('ladia_document_templates INSERT (storage_path NULL) riesce', !insertErr && row, insertErr);

    if (row) {
      let doc = await getDocRow('ladia_document_templates', row.id);
      check('ladia_document_templates INSERT sincronizzato in documents anche con file_path NULL',
        doc && doc.company_id === companyId && doc.file_path === null && doc.category === 'contratto' && doc.ai_summary === 'Riassunto di test',
        doc);

      await supabase.from('ladia_document_templates').update({ storage_path: `${companyId}/ladia/test.pdf`, summary: 'Riassunto aggiornato' }).eq('id', row.id);
      doc = await getDocRow('ladia_document_templates', row.id);
      check('ladia_document_templates UPDATE sincronizzato in documents', doc && doc.file_path === `${companyId}/ladia/test.pdf` && doc.ai_summary === 'Riassunto aggiornato', doc);

      await supabase.from('ladia_document_templates').delete().eq('id', row.id);
      doc = await getDocRow('ladia_document_templates', row.id);
      check('ladia_document_templates DELETE rimuove la riga in documents', !doc, doc);
    }
  }

  // ── 2. studio_shared_documents: INSERT → UPDATE → DELETE ──
  if (studioId) {
    const { data: row } = await supabase.from('studio_shared_documents').insert({
      studio_id: studioId, company_id: companyId, name: 'Test comunicazione', category: 'comunicazione',
      file_path: `${companyId}/studio-shared/test.pdf`,
    }).select().single();
    let doc = await getDocRow('studio_shared_documents', row.id);
    check('studio_shared_documents INSERT sincronizzato in documents',
      doc && doc.owner_type === 'company' && doc.studio_id === studioId && doc.file_path === row.file_path && doc.category === 'comunicazione',
      doc);

    await supabase.from('studio_shared_documents').update({ name: 'Test comunicazione rinominata' }).eq('id', row.id);
    doc = await getDocRow('studio_shared_documents', row.id);
    check('studio_shared_documents UPDATE sincronizzato in documents', doc && doc.name === 'Test comunicazione rinominata', doc);

    await supabase.from('studio_shared_documents').delete().eq('id', row.id);
    doc = await getDocRow('studio_shared_documents', row.id);
    check('studio_shared_documents DELETE rimuove la riga in documents', !doc, doc);
  } else {
    check('studio_shared_documents (skip, nessuno studio_partners disponibile)', true);
  }

  // ── 3. studio_document_requests: INSERT (pending) → UPDATE (uploaded → reviewed) → DELETE ──
  if (studioId) {
    const { data: row } = await supabase.from('studio_document_requests').insert({
      studio_id: studioId, company_id: companyId, title: 'Test DURC richiesto', document_type: 'durc', due_date: '2099-01-01',
    }).select().single();
    let doc = await getDocRow('studio_document_requests', row.id);
    check('studio_document_requests INSERT (pending) sincronizzato in documents',
      doc && doc.owner_type === 'company' && doc.studio_id === studioId && doc.name === 'Test DURC richiesto'
        && doc.request_status === 'pending' && doc.due_date === '2099-01-01' && doc.upload_token === row.upload_token
        && doc.response_url === null,
      doc);

    await supabase.from('studio_document_requests').update({
      status: 'uploaded', response_url: 'https://example.com/fake-drive-link', response_filename: 'durc.pdf',
    }).eq('id', row.id);
    doc = await getDocRow('studio_document_requests', row.id);
    check('studio_document_requests UPDATE (uploaded) sincronizzato in documents',
      doc && doc.request_status === 'uploaded' && doc.response_url === 'https://example.com/fake-drive-link' && doc.response_filename === 'durc.pdf',
      doc);

    await supabase.from('studio_document_requests').update({ status: 'reviewed', reviewer_notes: 'Tutto ok' }).eq('id', row.id);
    doc = await getDocRow('studio_document_requests', row.id);
    check('studio_document_requests UPDATE (reviewed) sincronizzato in documents', doc && doc.request_status === 'reviewed' && doc.reviewer_notes === 'Tutto ok', doc);

    await supabase.from('studio_document_requests').delete().eq('id', row.id);
    doc = await getDocRow('studio_document_requests', row.id);
    check('studio_document_requests DELETE rimuove la riga in documents', !doc, doc);
  } else {
    check('studio_document_requests (skip, nessuno studio_partners disponibile)', true);
  }

  // ── 4. Resilienza: anche i trigger di Scaglione 3 non bloccano mai la scrittura storica ──
  {
    const breakErr = await execSql(`ALTER TABLE documents ADD CONSTRAINT test_force_sync_failure_t3 CHECK (1 = 0) NOT VALID;`);
    check('Vincolo impossibile applicato a documents', !breakErr, breakErr);

    const { data: row, error: insertErr } = await supabase.from('ladia_document_templates')
      .insert({ company_id: companyId, uploaded_by_chat_id: 'TEST-CHAT-RESIL', document_type: 'altro' })
      .select().single();
    check('INSERT su ladia_document_templates riesce comunque, nonostante documents sia rotta', !insertErr && row, insertErr);

    if (row) {
      const { data: failures } = await supabase.from('document_sync_failures')
        .select('*').eq('source_table', 'ladia_document_templates').eq('legacy_id', row.id);
      check('Il fallimento di sync è stato loggato in document_sync_failures', failures && failures.length === 1, failures);
      if (failures?.length) {
        await supabase.from('document_sync_failures').update({ resolved_at: new Date().toISOString() }).in('id', failures.map(f => f.id));
      }
    }

    const restoreErr = await execSql(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS test_force_sync_failure_t3;`);
    check('Vincolo di test rimosso, documents ripristinata', !restoreErr, restoreErr);

    if (row) {
      await supabase.from('ladia_document_templates').update({ summary: 'Post-ripristino' }).eq('id', row.id);
      const doc = await getDocRow('ladia_document_templates', row.id);
      check('Dopo il ripristino, la sync riprende a funzionare normalmente', doc && doc.ai_summary === 'Post-ripristino', doc);
      await supabase.from('ladia_document_templates').delete().eq('id', row.id);
    }
  }

  // ── 5. La funzione di verifica unificata copre ora tutte e 9 le tabelle ──
  {
    const { data: report, error } = await supabase.rpc('verify_documents_sync');
    check('verify_documents_sync() risponde senza errore', !error, error);
    const names = (report || []).map(r => r.source_table).sort();
    const expected = [
      'company_documents', 'ladia_document_templates', 'payslips', 'site_documents',
      'studio_document_requests', 'studio_shared_documents', 'subcontractor_documents',
      'worker_certificates', 'worker_documents',
    ].sort();
    check('verify_documents_sync() copre tutte e 9 le tabelle', JSON.stringify(names) === JSON.stringify(expected), names);
  }

  // ── Cleanup ──
  try { await supabase.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
