#!/usr/bin/env node
/**
 * scripts/selftest_documents_sync_tier2.js
 *
 * Test di regressione per Fase 2 / Scaglione 2 (subcontractor_documents,
 * payslips) — stesso pattern di scripts/selftest_documents_sync.js per lo
 * Scaglione 1: scritture reali sulle tabelle storiche verificate in
 * `documents`, e riprova indipendente che la resilienza a sync rotta valga
 * anche per le nuove funzioni trigger di questo scaglione.
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
  console.log('\nPalladia documents-sync regression — Scaglione 2\n');

  const { data: company } = await supabase.from('companies').insert({ name: 'TEST-DocsSyncT2-Probe' }).select().single();
  check('Creata azienda temporanea', !!company);
  const companyId = company.id;
  const { data: worker } = await supabase.from('workers').insert({ company_id: companyId, full_name: 'TEST Worker T2', fiscal_code: `TSTT2${Date.now()}`.slice(0, 16).toUpperCase(), is_active: true, badge_code: `TSTT2${Date.now()}` }).select().single();
  check('Creato lavoratore temporaneo', !!worker);
  const workerId = worker.id;
  const { data: sub } = await supabase.from('subcontractors').insert({ company_id: companyId, company_name: 'TEST Subappaltatore' }).select().single();
  check('Creato subappaltatore temporaneo', !!sub);
  const subId = sub.id;

  // ── 1. subcontractor_documents: INSERT → UPDATE → DELETE ──
  {
    const { data: row } = await supabase.from('subcontractor_documents').insert({
      company_id: companyId, subcontractor_id: subId, name: 'Test DURC', category: 'durc',
      file_path: `${companyId}/subcontractors/${subId}/test.pdf`, valid_until: '2099-01-01', content_hash: 'abc123',
    }).select().single();
    let doc = await getDocRow('subcontractor_documents', row.id);
    check('subcontractor_documents INSERT sincronizzato in documents',
      doc && doc.owner_type === 'subcontractor' && doc.subcontractor_id === subId
        && doc.file_path === row.file_path && doc.expiry_date === '2099-01-01' && doc.content_hash === 'abc123',
      doc);

    await supabase.from('subcontractor_documents').update({ name: 'Test DURC rinnovato' }).eq('id', row.id);
    doc = await getDocRow('subcontractor_documents', row.id);
    check('subcontractor_documents UPDATE sincronizzato in documents', doc && doc.name === 'Test DURC rinnovato', doc);

    await supabase.from('subcontractor_documents').delete().eq('id', row.id);
    doc = await getDocRow('subcontractor_documents', row.id);
    check('subcontractor_documents DELETE rimuove la riga in documents', !doc, doc);
  }

  // ── 2. payslips: INSERT (con e senza studio_id) → UPDATE → DELETE ──
  {
    const { data: row } = await supabase.from('payslips').insert({
      company_id: companyId, worker_id: workerId, period_year: 2026, period_month: 1,
      filename: 'test-cedolino.pdf', file_path: `payslips/${companyId}/${workerId}/2026-01.pdf`, status: 'draft',
    }).select().single();
    let doc = await getDocRow('payslips', row.id);
    check('payslips INSERT (senza studio) sincronizzato in documents',
      doc && doc.owner_type === 'worker' && doc.worker_id === workerId && doc.studio_id === null
        && doc.period_year === 2026 && doc.period_month === 1 && doc.payslip_status === 'draft' && doc.category === 'busta_paga',
      doc);

    const { data: someStudio } = await supabase.from('studio_partners').select('id').limit(1).single();
    if (someStudio) {
      await supabase.from('payslips').update({ studio_id: someStudio.id, status: 'shared' }).eq('id', row.id);
      doc = await getDocRow('payslips', row.id);
      check('payslips UPDATE con studio_id sincronizzato in documents', doc && doc.studio_id === someStudio.id && doc.payslip_status === 'shared', doc);
    } else {
      check('payslips UPDATE con studio_id (skip, nessuno studio_partners disponibile)', true);
    }

    await supabase.from('payslips').delete().eq('id', row.id);
    doc = await getDocRow('payslips', row.id);
    check('payslips DELETE rimuove la riga in documents', !doc, doc);
  }

  // ── 3. Resilienza: anche i trigger di Scaglione 2 non bloccano mai la scrittura storica ──
  {
    const breakErr = await execSql(`ALTER TABLE documents ADD CONSTRAINT test_force_sync_failure_t2 CHECK (1 = 0) NOT VALID;`);
    check('Vincolo impossibile applicato a documents', !breakErr, breakErr);

    const { data: row, error: insertErr } = await supabase.from('subcontractor_documents')
      .insert({ company_id: companyId, subcontractor_id: subId, name: 'Test resilienza', category: 'altro', file_path: 'x.pdf' })
      .select().single();
    check('INSERT su subcontractor_documents riesce comunque, nonostante documents sia rotta', !insertErr && row, insertErr);

    if (row) {
      const { data: failures } = await supabase.from('document_sync_failures')
        .select('*').eq('source_table', 'subcontractor_documents').eq('legacy_id', row.id);
      check('Il fallimento di sync è stato loggato in document_sync_failures', failures && failures.length === 1, failures);
      if (failures?.length) {
        await supabase.from('document_sync_failures').update({ resolved_at: new Date().toISOString() }).in('id', failures.map(f => f.id));
      }
    }

    const restoreErr = await execSql(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS test_force_sync_failure_t2;`);
    check('Vincolo di test rimosso, documents ripristinata', !restoreErr, restoreErr);

    if (row) {
      await supabase.from('subcontractor_documents').update({ name: 'Test resilienza aggiornato' }).eq('id', row.id);
      const doc = await getDocRow('subcontractor_documents', row.id);
      check('Dopo il ripristino, la sync riprende a funzionare normalmente', doc && doc.name === 'Test resilienza aggiornato', doc);
      await supabase.from('subcontractor_documents').delete().eq('id', row.id);
    }
  }

  // ── 4. La funzione di verifica unificata copre davvero tutte e 6 le tabelle ──
  {
    const { data: report, error } = await supabase.rpc('verify_documents_sync');
    check('verify_documents_sync() risponde senza errore', !error, error);
    const names = (report || []).map(r => r.source_table).sort();
    check('verify_documents_sync() copre tutte e 6 le tabelle',
      JSON.stringify(names) === JSON.stringify(['company_documents', 'payslips', 'site_documents', 'subcontractor_documents', 'worker_certificates', 'worker_documents'].sort()),
      names);
  }

  // ── Cleanup ──
  try { await supabase.from('subcontractors').delete().eq('id', subId); } catch { /* best-effort */ }
  try { await supabase.from('workers').delete().eq('id', workerId); } catch { /* best-effort */ }
  try { await supabase.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
