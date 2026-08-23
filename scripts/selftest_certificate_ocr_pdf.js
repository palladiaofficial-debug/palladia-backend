#!/usr/bin/env node
/**
 * scripts/selftest_certificate_ocr_pdf.js
 *
 * Regressione per F-070 (AUDIT.md): POST /api/v1/workers/:id/certificates/extract
 * mandava SEMPRE il file come blocco 'image' all'API Anthropic, anche quando
 * era un PDF — un blocco 'image' accetta solo jpeg/png/gif/webp, quindi ogni
 * attestato caricato come PDF falliva con 500 OCR_ERROR (stesso bug di
 * F-068 su ocrExpiry.js, trovato qui verificando dal vivo F-069). A
 * differenza di F-068 questo endpoint ha consumatori reali — un attestato
 * scansionato/fotografato e salvato PDF non ha mai funzionato in produzione.
 * Fix: type: 'document' per i PDF, come già fa routes/v1/equipment.js.
 *
 * Env: stesse di selftest_certificate_ocr_upload.js (TEST_BASE_URL,
 * SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY, E2E_EMAIL, E2E_PASSWORD,
 * E2E_COMPANY_ID). Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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
  console.log('\nPalladia regression — F-069/F-070 /certificates/extract con un PDF reale\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('F-070 /certificates/extract con PDF', 'fixture E2E non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const pdfPath = path.join(__dirname, '_demo_attestato.pdf');
  if (!fs.existsSync(pdfPath)) {
    skip('F-070 /certificates/extract con PDF', `${pdfPath} non presente in questo ambiente`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_EMAIL, password: E2E_PASSWORD });
  check('Login E2E riuscito', !loginErr && session?.session, loginErr);
  const jwt = session?.session?.access_token;
  if (!jwt) {
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const supabase = require('../lib/supabase');
  const { data: worker } = await supabase.from('workers').select('id').eq('company_id', E2E_COMPANY_ID).limit(1).maybeSingle();
  check('Worker E2E trovato', !!worker, worker);
  if (!worker) {
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const b64 = fs.readFileSync(pdfPath).toString('base64');
  const res = await fetch(`${BASE}/api/v1/workers/${worker.id}/certificates/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID },
    body: JSON.stringify({ file_base64: b64, mime_type: 'application/pdf' }),
  });
  const body = await res.json().catch(() => ({}));
  check('Un PDF risponde 200 (prima falliva sempre 500 OCR_ERROR — stesso bug di F-068)', res.status === 200, { status: res.status, body });

  const objFields = Object.entries(body.extracted || {}).filter(([, v]) => v !== null && typeof v === 'object');
  check('Nessun campo di extracted è un oggetto (F-069)', objFields.length === 0, body.extracted);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
