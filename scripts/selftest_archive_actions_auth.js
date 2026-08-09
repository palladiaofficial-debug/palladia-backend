#!/usr/bin/env node
/**
 * scripts/selftest_archive_actions_auth.js
 *
 * Test di regressione per routes/v1/archiveActions.js (Fase 2, Scaglione 3):
 * verifica dal vivo, con JWT reali (non letture di codice), i 3 scenari di
 * autorizzazione su studio_shared_documents/studio_document_requests:
 *   (a) impresa sulla propria company: download OK, delete/review 403
 *   (b) studio su cliente attivo (owned_by_studio): tutto OK
 *   (c) studio su cliente NON assegnato: 403 dal fallback CDL
 *
 * Env: TEST_BASE_URL (default http://localhost:3001), SUPABASE_URL,
 * SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY, E2E_EMAIL,
 * E2E_PASSWORD, E2E_COMPANY_ID, E2E_STUDIO_EMAIL, E2E_STUDIO_PASSWORD,
 * E2E_STUDIO_ID — stessi fixture permanenti usati dalla suite Playwright
 * frontend. Se mancano, il test si salta (stesso principio di
 * selftest_rls_documenti.js per TEST_CI_PASSWORD): non è una regressione,
 * è un ambiente senza le credenziali di test.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../lib/supabase');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
const E2E_COMPANY_ID = process.env.E2E_COMPANY_ID;
const E2E_STUDIO_EMAIL = process.env.E2E_STUDIO_EMAIL;
const E2E_STUDIO_PASSWORD = process.env.E2E_STUDIO_PASSWORD;
const E2E_STUDIO_ID = process.env.E2E_STUDIO_ID;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function signIn(email, password) {
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login fallito per ${email}: ${error.message}`);
  return data.session.access_token;
}

async function call(method, path, jwt, companyId, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function main() {
  console.log('\nPalladia regression — auth routes/v1/archiveActions.js (Scaglione 3)\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID || !E2E_STUDIO_EMAIL || !E2E_STUDIO_PASSWORD || !E2E_STUDIO_ID) {
    skip('archiveActions auth suite', 'fixture E2E (E2E_EMAIL/E2E_STUDIO_*) non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  // Pulizia preventiva e relazione studio↔company attiva (idempotente).
  await supabase.from('studio_clients').delete().eq('studio_id', E2E_STUDIO_ID).eq('company_id', E2E_COMPANY_ID);
  const { error: relErr } = await supabase.from('studio_clients').insert({
    studio_id: E2E_STUDIO_ID, company_id: E2E_COMPANY_ID, status: 'active', owned_by_studio: true,
  });
  check('Fixture: relazione studio_clients attiva creata', !relErr, relErr);

  const sharedDocPath = `${E2E_COMPANY_ID}/studio-shared/selftest-auth-${Date.now()}.pdf`;
  const { error: uploadErr } = await supabase.storage.from('site-documents').upload(sharedDocPath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  check('Fixture: file reale caricato su storage', !uploadErr, uploadErr);

  const { data: sharedDoc } = await supabase.from('studio_shared_documents').insert({
    studio_id: E2E_STUDIO_ID, company_id: E2E_COMPANY_ID, name: 'Selftest auth', category: 'altro', file_path: sharedDocPath,
  }).select().single();
  check('Fixture: studio_shared_documents di test creato', !!sharedDoc, sharedDoc);

  const { data: request } = await supabase.from('studio_document_requests').insert({
    studio_id: E2E_STUDIO_ID, company_id: E2E_COMPANY_ID, title: 'Selftest auth', document_type: 'altro',
    status: 'uploaded', response_url: 'https://example.com/fake-response',
  }).select().single();
  check('Fixture: studio_document_requests di test creato (uploaded)', !!request, request);

  const impresaJwt = await signIn(E2E_EMAIL, E2E_PASSWORD);
  const studioJwt = await signIn(E2E_STUDIO_EMAIL, E2E_STUDIO_PASSWORD);

  // ── upload_token: segreto che dà accesso non autenticato al link pubblico,
  // non deve MAI comparire nella lista per un viewer impresa (routes/v1/archive.js) ──
  {
    const listAsImpresa = await call('GET', `/api/v1/archive/documents?source_tables=studio_document_requests`, impresaJwt, E2E_COMPANY_ID);
    const rowImpresa = listAsImpresa.json?.results?.find((r) => r.legacy_id === request.id);
    check('GET /archive/documents: upload_token assente/null per viewer impresa', !!rowImpresa && rowImpresa.upload_token == null, rowImpresa);

    const listAsStudio = await call('GET', `/api/v1/archive/documents?source_tables=studio_document_requests`, studioJwt, E2E_COMPANY_ID);
    const rowStudio = listAsStudio.json?.results?.find((r) => r.legacy_id === request.id);
    check('GET /archive/documents: upload_token presente per viewer CDL', !!rowStudio && rowStudio.upload_token === request.upload_token, rowStudio);
  }

  // ── (a) impresa sulla propria company ──
  {
    const dl = await call('GET', `/api/v1/archive/studio-shared-documents/${sharedDoc.id}/download`, impresaJwt, E2E_COMPANY_ID);
    check('(a) impresa: download shared-doc OK (200 + url)', dl.status === 200 && !!dl.json?.url, dl);

    const del = await call('DELETE', `/api/v1/archive/studio-shared-documents/${sharedDoc.id}`, impresaJwt, E2E_COMPANY_ID);
    check('(a) impresa: delete shared-doc 403 (CDL_ONLY)', del.status === 403, del);

    const rev = await call('PATCH', `/api/v1/archive/studio-document-requests/${request.id}/review`, impresaJwt, E2E_COMPANY_ID, { status: 'reviewed' });
    check('(a) impresa: review request 403 (CDL_ONLY)', rev.status === 403, rev);
  }

  // ── (b) studio su cliente attivo ──
  {
    const dl = await call('GET', `/api/v1/archive/studio-shared-documents/${sharedDoc.id}/download`, studioJwt, E2E_COMPANY_ID);
    check('(b) studio/cliente attivo: download shared-doc OK', dl.status === 200 && !!dl.json?.url, dl);

    const dlReq = await call('GET', `/api/v1/archive/studio-document-requests/${request.id}/download`, studioJwt, E2E_COMPANY_ID);
    check('(b) studio/cliente attivo: download response request OK', dlReq.status === 200 && dlReq.json?.url === 'https://example.com/fake-response', dlReq);

    const rev = await call('PATCH', `/api/v1/archive/studio-document-requests/${request.id}/review`, studioJwt, E2E_COMPANY_ID, { status: 'reviewed', reviewer_notes: 'Selftest OK' });
    check('(b) studio/cliente attivo: review request OK', rev.status === 200 && rev.json?.request?.status === 'reviewed', rev);

    const del = await call('DELETE', `/api/v1/archive/studio-shared-documents/${sharedDoc.id}`, studioJwt, E2E_COMPANY_ID);
    check('(b) studio/cliente attivo: delete shared-doc OK', del.status === 200 && del.json?.ok === true, del);

    const delReq = await call('DELETE', `/api/v1/archive/studio-document-requests/${request.id}`, studioJwt, E2E_COMPANY_ID);
    check('(b) studio/cliente attivo: delete request OK', delReq.status === 200 && delReq.json?.ok === true, delReq);
  }

  // ── (c) studio su cliente NON assegnato ──
  {
    const { data: unrelatedRows } = await supabase.from('companies').select('id').neq('id', E2E_COMPANY_ID).limit(1);
    const unrelated = unrelatedRows?.[0];
    if (unrelated) {
      const dl = await call('GET', `/api/v1/archive/studio-shared-documents/${sharedDoc.id}/download`, studioJwt, unrelated.id);
      check('(c) studio/cliente non assegnato: 403 dal fallback CDL', dl.status === 403, dl);
    } else {
      skip('(c) studio/cliente non assegnato', 'nessuna company alternativa trovata nel DB');
    }
  }

  // ── Cleanup ──
  try { await supabase.storage.from('site-documents').remove([sharedDocPath]); } catch { /* best-effort */ }
  try { await supabase.from('studio_clients').delete().eq('studio_id', E2E_STUDIO_ID).eq('company_id', E2E_COMPANY_ID); } catch { /* best-effort */ }
  try { await supabase.from('studio_shared_documents').delete().eq('id', sharedDoc.id); } catch { /* best-effort */ }
  try { await supabase.from('studio_document_requests').delete().eq('id', request.id); } catch { /* best-effort */ }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
