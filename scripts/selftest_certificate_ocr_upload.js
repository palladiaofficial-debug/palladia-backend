#!/usr/bin/env node
/**
 * scripts/selftest_certificate_ocr_upload.js
 *
 * Regressione per F-037 (AUDIT.md): POST /workers/:workerId/certificates/upload
 * scriveva sempre sul bucket Storage 'documents', che non esiste — ogni upload
 * falliva con 500 STORAGE_ERROR. Ripuntato a 'site-documents' (bucket reale,
 * già usato ovunque). Verifica dal vivo con una chiamata HTTP reale (multipart),
 * non solo lettura di codice — esattamente il tipo di bug che una lettura del
 * diff non avrebbe la certezza di aver chiuso.
 *
 * Env: stesse di selftest_archive_actions_auth.js (TEST_BASE_URL, SUPABASE_URL,
 * SUPABASE_ANON_KEY/SUPABASE_KEY, E2E_EMAIL, E2E_PASSWORD, E2E_COMPANY_ID).
 * Se mancano, il test si salta — non è una regressione, è un ambiente senza
 * le credenziali di test.
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

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — F-037 upload certificato OCR (bucket storage)\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('F-037 upload certificato', 'fixture E2E non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_EMAIL, password: E2E_PASSWORD });
  check('Login E2E riuscito', !loginErr && session?.session, loginErr);
  const jwt = session?.session?.access_token;

  const { data: worker } = await supabase.from('workers').select('id').eq('company_id', E2E_COMPANY_ID).limit(1).maybeSingle();
  check('Trovato un lavoratore reale su cui testare', !!worker, worker);
  if (!jwt || !worker) {
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'test-attestato.pdf');

  const res = await fetch(`${BASE}/api/v1/workers/${worker.id}/certificates/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  check('Upload certificato risponde 200 (prima falliva sempre 500 STORAGE_ERROR)', res.status === 200, { status: res.status, body });
  check('URL firmata restituita', !!body.url, body);

  // Pulizia: il path è ricostruibile solo dall'URL firmata restituita, non
  // manteniamo un riferimento diretto — best-effort, non blocca il test.
  if (body.path) {
    try { await supabase.storage.from('site-documents').remove([body.path]); } catch { /* best-effort */ }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
