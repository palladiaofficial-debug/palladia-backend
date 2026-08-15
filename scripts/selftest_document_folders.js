#!/usr/bin/env node
/**
 * scripts/selftest_document_folders.js
 *
 * Test di regressione per Cartelle Intelligenti (routes/v1/archive.js —
 * GET /document-folders, GET /document-folders/:type, GET /document-folders/
 * :type/:key/documents, POST/DELETE /documents/:id/homes) e per la casa
 * extra scritta da archiveChatUpload (services/chatDocumentAnalysis.js).
 *
 * Verifica dal vivo, JWT reale, contro dati creati/ripuliti in E2E_COMPANY_ID
 * — stesso pattern di selftest_archive_actions_auth.js. Se le fixture E2E
 * non sono configurate, il test si salta (non è una regressione).
 *
 * Env: TEST_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, E2E_EMAIL, E2E_PASSWORD, E2E_COMPANY_ID.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../lib/supabase');
const { archiveChatUpload } = require('../services/chatDocumentAnalysis');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
const E2E_COMPANY_ID = process.env.E2E_COMPANY_ID;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function call(method, path, jwt, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function seedChatUpload(filename, userId) {
  const storagePath = `${E2E_COMPANY_ID}/chat-uploads/selftest-folders-${Date.now()}-${filename}`;
  await supabase.storage.from('site-documents').upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  const { data: row, error } = await supabase.from('chat_uploads').insert({
    company_id: E2E_COMPANY_ID, user_id: userId, original_name: filename,
    mime_type: 'application/pdf', storage_path: storagePath, size_bytes: 13,
  }).select('id').single();
  if (error) throw new Error('seed chat_uploads: ' + error.message);
  return row.id;
}

async function main() {
  console.log('\nPalladia regression — Cartelle Intelligenti (routes/v1/archive.js)\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('document-folders suite', 'fixture E2E (E2E_EMAIL/E2E_COMPANY_ID) non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: sess, error: authErr } = await anon.auth.signInWithPassword({ email: E2E_EMAIL, password: E2E_PASSWORD });
  if (authErr) { fail('login E2E', authErr.message); console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const jwt = sess.session.access_token;

  let siteId = null, workerId = null, workerDocId = null, unifiedDocId = null, homeId = null;
  const storagePaths = [];

  try {
    const { data: site } = await supabase.from('sites').insert({
      company_id: E2E_COMPANY_ID, name: 'TEST-DocFolders-Cantiere', status: 'attivo', address: 'Via Test Cartelle 1',
    }).select('id').single();
    siteId = site.id;

    const { data: worker } = await supabase.from('workers').insert({
      company_id: E2E_COMPANY_ID, full_name: 'TEST-DocFolders Worker', is_active: true,
      fiscal_code: `TSTDF${Date.now()}`.slice(0, 16).toUpperCase(),
      badge_code: `TSTDF${Date.now()}`,
    }).select('id').single();
    workerId = worker.id;

    // ── 1) Un documento del lavoratore, archiviato via archiveChatUpload con
    //    un cantiere extra (siteId esplicito) — verifica il fix di
    //    chatDocumentAnalysis.js: la casa extra deve finire in
    //    document_extra_homes, non essere scartata. ─────────────────────────
    const uploadId = await seedChatUpload('attestato-test-cartelle.pdf', sess.session.user.id);
    const archiveResult = await archiveChatUpload({
      uploadId, companyId: E2E_COMPANY_ID, userId: sess.session.user.id,
      destination: 'worker_documents', name: 'Attestato test cartelle', workerId,
      siteId, category: 'attestato_formazione',
    });
    check('archiveChatUpload scrive il documento del lavoratore', archiveResult?.success === true, archiveResult);
    workerDocId = archiveResult?.doc_id;

    const { data: unified } = await supabase.from('documents')
      .select('id').eq('source_table', 'worker_documents').eq('legacy_id', workerDocId).maybeSingle();
    unifiedDocId = unified?.id;
    check('il documento appare nella tabella unificata documents', !!unifiedDocId, unified);

    const { data: extraHome } = await supabase.from('document_extra_homes')
      .select('id, folder_type, folder_key').eq('document_id', unifiedDocId).eq('folder_type', 'site').maybeSingle();
    check('archiveChatUpload ha scritto la casa extra (cantiere) in document_extra_homes', extraHome?.folder_key === siteId, extraHome);

    // ── 2) GET /document-folders — conteggi radice ─────────────────────────
    const root = await call('GET', '/api/v1/document-folders', jwt);
    check('GET /document-folders risponde 200 con le 6 cartelle attese', root.status === 200 && root.json?.folders?.length === 6, root);

    // ── 3) GET /document-folders/lavoratori — il worker di test compare ────
    const workersFolder = await call('GET', '/api/v1/document-folders/lavoratori', jwt);
    const workerEntry = workersFolder.json?.items?.find(i => i.key === workerId);
    check('GET /document-folders/lavoratori include il lavoratore di test con conteggio >= 1', workerEntry?.count >= 1, workerEntry);

    // ── 4) Il documento compare SIA nella cartella lavoratore (casa primaria)
    //    SIA nella cartella cantiere (casa extra) — il punto centrale del
    //    concept "vive in più cartelle insieme". ────────────────────────────
    const inWorkerFolder = await call('GET', `/api/v1/document-folders/lavoratori/${workerId}/documents`, jwt);
    const foundInWorker = inWorkerFolder.json?.documents?.some(d => d.id === unifiedDocId);
    check('il documento compare nella cartella del lavoratore (casa primaria)', foundInWorker === true, inWorkerFolder.json?.documents?.map(d => d.id));

    const inSiteFolder = await call('GET', `/api/v1/document-folders/cantieri/${siteId}/documents`, jwt);
    const foundInSite = inSiteFolder.json?.documents?.some(d => d.id === unifiedDocId);
    check('lo STESSO documento compare anche nella cartella del cantiere (casa extra, nessuna duplicazione)', foundInSite === true, inSiteFolder.json?.documents?.map(d => d.id));

    const docInSiteFolder = inSiteFolder.json?.documents?.find(d => d.id === unifiedDocId);
    check('il documento nella cartella cantiere elenca entrambe le case in "homes"', (docInSiteFolder?.homes || []).length >= 2, docInSiteFolder?.homes);

    // ── 5) POST/DELETE /documents/:id/homes — aggiungi/rimuovi a mano ──────
    const { data: site2 } = await supabase.from('sites').insert({
      company_id: E2E_COMPANY_ID, name: 'TEST-DocFolders-Cantiere-2', status: 'attivo', address: 'Via Test Cartelle 2',
    }).select('id').single();

    const addHome = await call('POST', `/api/v1/documents/${unifiedDocId}/homes`, jwt, { folder_type: 'site', folder_key: site2.id });
    check('POST /documents/:id/homes aggiunge una casa extra a mano', addHome.status === 200 && addHome.json?.ok === true, addHome);
    homeId = addHome.json?.id;

    const inSite2Folder = await call('GET', `/api/v1/document-folders/cantieri/${site2.id}/documents`, jwt);
    check('la casa aggiunta a mano è visibile subito nella nuova cartella', inSite2Folder.json?.documents?.some(d => d.id === unifiedDocId), inSite2Folder.json);

    if (homeId) {
      const delHome = await call('DELETE', `/api/v1/documents/${unifiedDocId}/homes/${homeId}`, jwt);
      check('DELETE /documents/:id/homes/:homeId rimuove la casa extra', delHome.status === 200 && delHome.json?.ok === true, delHome);
    } else {
      skip('DELETE /documents/:id/homes/:homeId', 'id casa extra non restituito da POST (probabile duplicato — non bloccante)');
    }

    await supabase.from('sites').delete().eq('id', site2.id);

    // ── 6) Cartella smart "In scadenza" — un documento con scadenza entro 30gg
    //    conta senza bisogno di una casa dedicata (calcolata al volo). ──────
    const { data: expiringDoc } = await supabase.from('worker_documents').insert({
      company_id: E2E_COMPANY_ID, worker_id: workerId, name: 'TEST-DocFolders scadenza',
      doc_type: 'idoneita_medica', expiry_date: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
      file_path: `${E2E_COMPANY_ID}/selftest-folders-expiry.pdf`,
    }).select('id').single();

    const rootAfter = await call('GET', '/api/v1/document-folders', jwt);
    const scadutiFolder = rootAfter.json?.folders?.find(f => f.type === 'scaduti');
    check('la cartella smart "scaduti" conta il documento in scadenza appena creato', (scadutiFolder?.count || 0) >= 1, scadutiFolder);

    await supabase.from('worker_documents').delete().eq('id', expiringDoc.id);

  } finally {
    if (unifiedDocId) await supabase.from('document_extra_homes').delete().eq('document_id', unifiedDocId);
    if (workerDocId)  await supabase.from('worker_documents').delete().eq('id', workerDocId);
    if (workerId)     await supabase.from('workers').delete().eq('id', workerId);
    if (siteId)       await supabase.from('sites').delete().eq('id', siteId);
    for (const p of storagePaths) await supabase.storage.from('site-documents').remove([p]).catch(() => {});
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE selftest_document_folders:', e.message); process.exitCode = 1; });
