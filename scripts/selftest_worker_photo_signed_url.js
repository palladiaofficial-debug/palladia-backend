#!/usr/bin/env node
/**
 * scripts/selftest_worker_photo_signed_url.js
 *
 * Test di regressione per F-179 (AUDIT.md, 2026-09-12): il bucket
 * worker-photos era pubblico — qualunque URL comparso in una risposta JSON
 * (visibile con F12) restava raggiungibile per sempre senza login.
 * Verificato rosso dal vivo prima del fix: GET diretta senza credenziali a
 * un file reale del bucket rispondeva 200 (vedi AUDIT.md per il log).
 *
 * Dopo il fix: il bucket è privato, workers.photo_url salva solo il path,
 * e lib/workerPhotoUrl.js firma un URL a scadenza ad ogni risposta JSON di
 * /api/v1/*. Verifica: (1) il path grezzo non è più raggiungibile senza
 * credenziali, (2) resolvePhotoUrlsInBody produce un URL firmato
 * funzionante per un oggetto reale, annidato a qualunque profondità, (3)
 * un valore già un URL http (es. foto pubblica di un consulente) resta
 * intoccato, (4) una chiamata HTTP reale a /api/v1/workers/:id restituisce
 * un photo_url firmato e funzionante, non il path grezzo.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { resolvePhotoUrlsInBody, BUCKET } = require('../lib/workerPhotoUrl');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const COMPANY_ID = 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

async function getJwt(email) {
  const admin = supabase;
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function main() {
  console.log('\n\x1b[1mBucket worker-photos privato + URL firmati — F-179\x1b[0m');

  const path = `${COMPANY_ID}/test-f179-${crypto.randomBytes(4).toString('hex')}.txt`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, Buffer.from('fixture F-179'), { contentType: 'text/plain' });
  if (upErr) { fail('setup: upload file fixture nel bucket', upErr.message); return report(); }

  const { data: worker, error: wErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-F179-PHOTO', is_active: true,
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
    photo_url: path,
  }).select('id').single();
  if (wErr) { fail('setup: worker fixture con photo_url', wErr.message); return report(); }

  try {
    // TEST 1 — il path grezzo non è raggiungibile senza credenziali
    const rawRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`);
    if (rawRes.status !== 200) {
      ok('URL pubblico diretto sul path grezzo: NON più raggiungibile (bucket privato)');
    } else {
      fail('URL pubblico diretto sul path grezzo: NON più raggiungibile (bucket privato)', rawRes.status);
    }

    // TEST 2 — resolvePhotoUrlsInBody firma un path annidato a qualunque profondità
    const body = { workers: [{ id: worker.id, photo_url: path, nested: { worker: { photo_url: path } } }] };
    const resolved = await resolvePhotoUrlsInBody(supabase, body);
    const signedUrl = resolved.workers[0].photo_url;
    const signedUrlNested = resolved.workers[0].nested.worker.photo_url;
    if (typeof signedUrl === 'string' && signedUrl.includes('token=') && signedUrl === signedUrlNested) {
      ok('resolvePhotoUrlsInBody: path annidato a qualunque profondità sostituito con URL firmato');
    } else {
      fail('resolvePhotoUrlsInBody: path annidato a qualunque profondità sostituito con URL firmato', resolved);
    }

    const signedRes = await fetch(signedUrl);
    const signedText = await signedRes.text();
    if (signedRes.status === 200 && signedText === 'fixture F-179') {
      ok('URL firmato generato: funziona davvero, restituisce il contenuto reale del file');
    } else {
      fail('URL firmato generato: funziona davvero, restituisce il contenuto reale del file', { status: signedRes.status, signedText });
    }

    // TEST 3 — un valore già un URL http (foto pubblica esterna, es. consulente) resta intoccato
    const externalUrl = 'https://example.com/foto-pubblica-consulente.jpg';
    const untouched = await resolvePhotoUrlsInBody(supabase, { consultant: { photo_url: externalUrl } });
    if (untouched.consultant.photo_url === externalUrl) {
      ok('resolvePhotoUrlsInBody: un photo_url già un URL http (non un path) resta intoccato');
    } else {
      fail('resolvePhotoUrlsInBody: un photo_url già un URL http (non un path) resta intoccato', untouched);
    }

    // TEST 4 — chiamata HTTP reale: GET /api/v1/workers/:id restituisce un URL firmato funzionante
    const jwt = await getJwt('e2e-suite@palladia.internal');
    const res = await fetch(`${BASE}/api/v1/workers/${worker.id}`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID },
    });
    const data = await res.json();
    if (res.status === 200 && typeof data.photo_url === 'string' && data.photo_url.startsWith('http') && data.photo_url.includes('token=')) {
      const imgRes = await fetch(data.photo_url);
      if (imgRes.status === 200) {
        ok('GET /api/v1/workers/:id reale: photo_url è un URL firmato funzionante, non il path grezzo');
      } else {
        fail('GET /api/v1/workers/:id reale: photo_url è un URL firmato funzionante, non il path grezzo', { imgStatus: imgRes.status });
      }
    } else {
      fail('GET /api/v1/workers/:id reale: photo_url è un URL firmato funzionante, non il path grezzo', data);
    }
  } finally {
    await supabase.storage.from(BUCKET).remove([path]);
    await supabase.from('workers').delete().eq('id', worker.id);
    console.log('\nFixture ripulite.');
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error('ERRORE selftest_worker_photo_signed_url:', e); process.exit(1); });
