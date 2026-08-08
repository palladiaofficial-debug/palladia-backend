#!/usr/bin/env node
/**
 * scripts/selftest_storage_cleanup.js
 *
 * Test di regressione per F-032 (AUDIT.md): la cancellazione azienda puliva solo
 * 4 bucket legacy via storage.list(companyId) — che non trova nulla nei bucket
 * reali (site-documents, site-media) perché i file vivono in sottocartelle, non
 * direttamente sotto companyId/.
 *
 * Verifica dal vivo su Supabase Storage reale (non un mock): crea un'azienda e un
 * cantiere temporanei, carica un file vero per ognuna delle fonti coperte da
 * lib/companyStorageCleanup.js, chiama cleanupCompanyDocumentStorage(), e verifica
 * che ogni file sia davvero sparito dallo storage.
 *
 * Nota bucket 'documents' (worker_certificates.pdf_url): verificato dal vivo che
 * il bucket non esiste su Supabase in questo ambiente (loggato come F-037 in
 * AUDIT.md, fuori scope per questo fix) — quella parte del test verifica solo che
 * cleanupCompanyDocumentStorage non esploda quando il bucket manca, via
 * extractStorageKey a livello unità per la logica di parsing URL.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { cleanupCompanyDocumentStorage, extractStorageKey } = require('../lib/companyStorageCleanup');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function uploadTiny(bucket, path) {
  const { error } = await supabase.storage.from(bucket).upload(path, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf', upsert: true });
  return { ok: !error, error };
}
async function exists(bucket, path) {
  const dir = path.split('/').slice(0, -1).join('/');
  const name = path.split('/').pop();
  const { data } = await supabase.storage.from(bucket).list(dir, { search: name });
  return !!(data || []).find((f) => f.name === name);
}

async function main() {
  console.log('\nPalladia storage cleanup regression — cancellazione azienda (F-032)\n');

  // extractStorageKey — unit-level, nessuna rete
  {
    const raw = 'a/b/c.pdf';
    check('extractStorageKey passa un path raw invariato', extractStorageKey(raw, 'documents') === raw);
    const signed = 'https://proj.supabase.co/storage/v1/object/sign/documents/certificates/co1/w1/123.pdf?token=abc&exp=1';
    check('extractStorageKey estrae il path da una signed URL', extractStorageKey(signed, 'documents') === 'certificates/co1/w1/123.pdf', extractStorageKey(signed, 'documents'));
    check('extractStorageKey ignora URL di un bucket diverso', extractStorageKey(signed, 'site-documents') === null, extractStorageKey(signed, 'site-documents'));
  }

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Storage-Cleanup-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  const { data: site, error: siteErr } = await supabase.from('sites').insert({ company_id: companyId, name: 'TEST-RLS site', status: 'attivo', address: 'Via Test 1, Genova' }).select().single();
  check('Creato cantiere temporaneo', !siteErr && site, siteErr);
  const siteId = site?.id || null;

  const { data: someStudio } = await supabase.from('studio_partners').select('id').limit(1).single();
  const studioId = someStudio?.id || null;

  const seeded = [];   // { table, id }
  const uploads = [];  // { bucket, path }

  async function seedDoc(table, row, bucket, pathField, path) {
    const { ok: uploaded, error: upErr } = await uploadTiny(bucket, path);
    check(`Upload reale ${bucket}/${path}`, uploaded, upErr);
    const { data, error } = await supabase.from(table).insert({ ...row, [pathField]: path }).select().single();
    check(`Seed riga ${table}`, !error && data, error);
    if (data) seeded.push({ table, id: data.id });
    if (uploaded) uploads.push({ bucket, path });
  }

  await seedDoc('site_documents', { company_id: companyId, site_id: siteId, category: 'altro', name: 'test.pdf' }, 'site-documents', 'file_path', `${companyId}/${siteId}/site-doc.pdf`);
  await seedDoc('company_documents', { company_id: companyId, category: 'altro', name: 'test.pdf' }, 'site-documents', 'file_path', `${companyId}/_company/company-doc.pdf`);
  await seedDoc('chat_uploads', { company_id: companyId, user_id: company.id, original_name: 'x.pdf', mime_type: 'application/pdf' }, 'site-documents', 'storage_path', `${companyId}/chat-uploads/chat-doc.pdf`);
  await seedDoc('site_costs', { company_id: companyId, site_id: siteId, descrizione: 'test', importo: 1 }, 'site-media', 'file_url', `${companyId}/costs/receipt.pdf`);

  if (studioId) {
    await seedDoc('studio_shared_documents', { studio_id: studioId, company_id: companyId, name: 'test' }, 'site-documents', 'file_path', `studio-shared/${studioId}/${companyId}/shared.pdf`);
  }

  // worker_certificates: pdf_url è una signed URL, non un path raw. Il bucket 'documents'
  // non esiste in questo ambiente (F-037) — verifichiamo solo che il cleanup non esploda,
  // usando una URL sintetica nella stessa forma che produrrebbe createSignedUrl().
  {
    const path = `certificates/${companyId}/nested/cert.pdf`;
    const fakeSignedUrl = `${process.env.SUPABASE_URL}/storage/v1/object/sign/documents/${path}?token=fake`;
    const { data, error } = await supabase.from('worker_certificates')
      .insert({ company_id: companyId, worker_id: null, issue_date: '2024-01-01', expiry_date: '2099-01-01', issuing_body: 'TEST', pdf_url: fakeSignedUrl }).select().single();
    check('Seed riga worker_certificates (pdf_url = signed URL sintetica)', !error && data, error);
    if (data) seeded.push({ table: 'worker_certificates', id: data.id });
  }

  // Conferma che i file esistono davvero prima della pulizia (altrimenti il test non proverebbe nulla).
  for (const u of uploads) {
    const found = await exists(u.bucket, u.path);
    check(`Precondizione: ${u.bucket}/${u.path} esiste prima della pulizia`, found);
  }

  // Prova diretta del bug pre-fix: il vecchio codice faceva
  //   list(companyId) -> map(f => `${companyId}/${f.name}`) -> remove(paths)
  // list() su un prefisso restituisce le SOTTOCARTELLE come pseudo-entry (es. "_company",
  // "chat-uploads"), non i file nested al loro interno — quindi remove() riceve path di
  // cartella che non corrispondono a nessun object key reale e non cancella nulla.
  // Lo simuliamo qui sui bucket reali e verifichiamo che il file target sopravviva.
  for (const bucket of ['site-documents', 'site-media']) {
    const { data: topLevel } = await supabase.storage.from(bucket).list(companyId, { limit: 1000 });
    check(`Pre-fix: list('${bucket}', companyId) restituisce solo pseudo-cartelle`, Array.isArray(topLevel) && topLevel.length > 0, topLevel);
    if (topLevel?.length) {
      const oldStylePaths = topLevel.map((f) => `${companyId}/${f.name}`);
      await supabase.storage.from(bucket).remove(oldStylePaths);
    }
  }
  for (const u of uploads.filter((x) => x.bucket === 'site-documents' || x.bucket === 'site-media')) {
    const stillThere = await exists(u.bucket, u.path);
    check(`Pre-fix: remove(pseudo-cartelle) NON cancella il file nested ${u.bucket}/${u.path} (bug confermato)`, stillThere);
  }

  let cleanupThrew = null;
  try { await cleanupCompanyDocumentStorage(companyId); } catch (e) { cleanupThrew = e; }
  check('cleanupCompanyDocumentStorage non esplode nonostante il bucket documents mancante', !cleanupThrew, cleanupThrew?.message);

  for (const u of uploads) {
    const found = await exists(u.bucket, u.path);
    check(`Dopo cleanupCompanyDocumentStorage: ${u.bucket}/${u.path} è stato rimosso`, !found);
  }

  // Cleanup DB + eventuali file rimasti (best-effort, non deve far fallire il test).
  // Nota: il client supabase-js è "thenable" ma non un vero Promise — .catch() diretto
  // esplode, serve try/catch attorno all'await (bug noto del progetto).
  for (const s of seeded) { try { await supabase.from(s.table).delete().eq('id', s.id); } catch { /* best-effort */ } }
  for (const u of uploads) { try { await supabase.storage.from(u.bucket).remove([u.path]); } catch { /* best-effort */ } }
  if (siteId) { try { await supabase.from('sites').delete().eq('id', siteId); } catch { /* best-effort */ } }
  await supabase.from('companies').delete().eq('id', companyId);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
