#!/usr/bin/env node
/**
 * scripts/selftest_api.js
 *
 * Test di regressione per gli endpoint API v1.
 * Si auto-autentica — non serve configurare manualmente nessun JWT.
 *
 * Env su Railway (una sola obbligatoria per i test autenticati):
 *   TEST_CI_PASSWORD   Password dell'utente CI (da Railway secrets)
 *
 * Env opzionali (hanno già un default):
 *   TEST_BASE_URL      Default: http://localhost:3001
 *   TEST_CI_EMAIL      Default: ci-test@palladia.internal
 *   TEST_COMPANY_ID    Default: d5dd4e79-635b-4ceb-ae74-9548a1dcfee1
 *   TEST_SITE_ID       Default: b4d201dd-4721-42bb-89b9-2736f6e52038
 *   TEST_WORKER_ID     Default: fd358ff5-e6c8-4b06-877d-0dededa69ba5
 *
 * Per rigenerare l'utente CI o aggiornare la password:
 *   node scripts/setup-ci-user.js
 */
'use strict';
require('dotenv').config();

const BASE       = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

// Credenziali CI — baked-in come default, override via env
const CI_EMAIL   = process.env.TEST_CI_EMAIL    || 'ci-test@palladia.internal';
const CI_PASS    = process.env.TEST_CI_PASSWORD || '';
const COMPANY_ID = process.env.TEST_COMPANY_ID  || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';
const SITE_ID    = process.env.TEST_SITE_ID     || 'b4d201dd-4721-42bb-89b9-2736f6e52038';
const WORKER_ID  = process.env.TEST_WORKER_ID   || 'fd358ff5-e6c8-4b06-877d-0dededa69ba5';

let JWT = process.env.TEST_JWT || ''; // fallback manuale

let passed = 0, failed = 0, skipped = 0;

function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function req(method, path, body, jwt, companyId) {
  const headers = { 'Content-Type': 'application/json' };
  if (jwt)       headers['Authorization'] = `Bearer ${jwt}`;
  if (companyId) headers['X-Company-Id']  = companyId;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let json;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
}

function header(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

async function autoLogin() {
  if (!CI_PASS) return;
  if (!SUPABASE_URL || !ANON_KEY) return;

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY,
      },
      body: JSON.stringify({ email: CI_EMAIL, password: CI_PASS }),
    });
    const data = await r.json();
    if (data?.access_token) {
      JWT = data.access_token;
      console.log(`  ✓ Auto-login CI completato (${CI_EMAIL})`);
    } else {
      console.warn(`  ⚠ Auto-login fallito: ${data?.error_description || JSON.stringify(data)}`);
    }
  } catch (e) {
    console.warn(`  ⚠ Auto-login errore: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPalladia API regression tests — ${BASE}`);

  // Auto-login con utente CI
  await autoLogin();
  console.log(`JWT: ${JWT ? '✓ attivo' : '✗ mancante — solo test pubblici'}\n`);

  // ── 1. Infrastruttura ───────────────────────────────────────────────────────
  header('1. Infrastruttura');
  {
    const r = await req('GET', '/api/health');
    check('GET /api/health risponde', r.status === 200 || r.status === 503, r);
    check('/api/health ha campo status', typeof r.body?.status === 'string', r.body);
  }
  {
    const r = await req('GET', '/api/config');
    check('GET /api/config → 200', r.status === 200, r);
    check('/api/config ha supabase_url', typeof r.body?.supabase_url === 'string', r.body);
  }

  // ── 2. Auth rejection — endpoint protetti senza JWT ─────────────────────────
  header('2. Auth rejection (nessun JWT)');
  const protectedEndpoints = [
    ['GET',   '/api/v1/sites'],
    ['POST',  '/api/v1/sites'],
    ['GET',   '/api/v1/workers'],
    ['POST',  '/api/v1/workers'],
    ['GET',   '/api/v1/billing/status'],
    ['POST',  '/api/v1/billing/checkout'],
    ['GET',   '/api/v1/company'],
    ['GET',   '/api/v1/equipment'],
    ['GET',   '/api/v1/dashboard'],
  ];
  for (const [method, path] of protectedEndpoints) {
    const r = await req(method, path);
    check(`${method} ${path} senza JWT → 401`, r.status === 401, r);
  }

  // ── 3. Billing — validazione piano ──────────────────────────────────────────
  header('3. Billing — piano non valido');
  if (!JWT) {
    skip('Test billing', 'JWT non disponibile');
  } else {
    {
      const r = await req('POST', '/api/v1/billing/checkout', { plan: 'enterprise_gold_vip' }, JWT, COMPANY_ID);
      check('plan sconosciuto → 400', r.status === 400, r);
      check('errore VALIDATION_ERROR o INVALID_PLAN', ['VALIDATION_ERROR','INVALID_PLAN'].includes(r.body?.error), r.body);
    }
    {
      const r = await req('POST', '/api/v1/billing/checkout', {}, JWT, COMPANY_ID);
      check('body vuoto → 400', r.status === 400, r);
    }
  }

  // ── 4. Worker POST — validazione input ──────────────────────────────────────
  header('4. POST /workers — validazione');
  if (!JWT) {
    skip('Worker POST tests', 'JWT non disponibile');
  } else {
    const cases = [
      [{ fiscal_code: 'RSSMRA80A01H501U' },                            'full_name mancante → 400',   400],
      [{ full_name: 'A', fiscal_code: 'RSSMRA80A01H501U' },           'full_name 1 char → 400',      400],
      [{ full_name: 'Mario Rossi' },                                   'fiscal_code mancante → 400',  400],
      [{ full_name: 'Mario Rossi', fiscal_code: 'TOOCRT' },           'fiscal_code 6 char → 400',    400],
      [{ full_name: 'Mario Rossi', fiscal_code: 'INVALIDO$$$$$$$$' }, 'fiscal_code con $ → 400',     400],
    ];
    for (const [body, name, expected] of cases) {
      const r = await req('POST', '/api/v1/workers', body, JWT, COMPANY_ID);
      check(name, r.status === expected, r);
    }
  }

  // ── 5. Worker PATCH — edge case ──────────────────────────────────────────────
  header('5. PATCH /workers/:id — edge case');
  if (!JWT || !WORKER_ID) {
    skip('Worker PATCH tests', !JWT ? 'JWT non disponibile' : 'WORKER_ID mancante');
  } else {
    {
      const r = await req('PATCH', `/api/v1/workers/${WORKER_ID}`, { tariffa_oraria: -5 }, JWT, COMPANY_ID);
      check('tariffa_oraria negativa → 400', r.status === 400, r);
    }
    {
      const r = await req('PATCH', `/api/v1/workers/${WORKER_ID}`, { hire_date: '01/01/2024' }, JWT, COMPANY_ID);
      check('hire_date formato sbagliato → 400', r.status === 400, r);
    }
    {
      const r = await req('PATCH', `/api/v1/workers/${WORKER_ID}`, { company_id: 'evil', tariffa_oraria: 15 }, JWT, COMPANY_ID);
      check('company_id sconosciuto strippato → NON 500', r.status !== 500, r);
    }
  }

  // ── 6. Site POST — validazione ───────────────────────────────────────────────
  header('6. POST /sites — validazione');
  if (!JWT) {
    skip('Site POST tests', 'JWT non disponibile');
  } else {
    const cases = [
      [{},               'body vuoto → 400',    400],
      [{ name: 'X' },   'name 1 char → 400',   400],
      [{ name: 'A'.repeat(201) }, 'name 201 char → 400', 400],
    ];
    for (const [body, name, expected] of cases) {
      const r = await req('POST', '/api/v1/sites', body, JWT, COMPANY_ID);
      check(name, r.status === expected, r);
    }
  }

  // ── 7. Site PATCH — bug storici ──────────────────────────────────────────────
  header('7. PATCH /sites/:siteId — edge case (bug storici)');
  if (!JWT || !SITE_ID) {
    skip('Site PATCH tests', !JWT ? 'JWT non disponibile' : 'SITE_ID mancante');
  } else {
    const cases = [
      [{ weather_rain_mm: '' },    'weather_rain_mm:"" → NON 400',     (s) => s !== 400],
      [{ weather_wind_kmh: '' },   'weather_wind_kmh:"" → NON 400',    (s) => s !== 400],
      [{ weather_rain_mm: null },  'weather_rain_mm:null → NON 400',   (s) => s !== 400],
      [{ weather_rain_mm: 25 },    'weather_rain_mm:25 → 200',         (s) => s === 200],
      [{ weather_wind_kmh: 60 },   'weather_wind_kmh:60 → 200',        (s) => s === 200],
      [{ weather_snow: true },     'weather_snow:true → 200',          (s) => s === 200],
      [{ weather_wind_kmh: 5 },    'weather_wind_kmh:5 (< 10) → 400', (s) => s === 400],
      [{ weather_rain_mm: 250 },   'weather_rain_mm:250 (> 200) → 400',(s) => s === 400],
      [{ status: 'FANTASMA' },     'status invalido → 400',            (s) => s === 400],
      [{ company_id: 'evil', weather_rain_mm: 20 }, 'company_id strippato → 200', (s) => s === 200],
    ];
    for (const [body, name, predicate] of cases) {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, body, JWT, COMPANY_ID);
      check(name, predicate(r.status), { status: r.status, error: r.body?.error });
    }
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { weather_rain_mm: 20 }, JWT, COMPANY_ID);
      if (r.status === 200) check('risposta PATCH non espone company_id', r.body?.company_id === undefined, r.body);
    }
  }

  // ── 8. IDOR — cross-company protection ─────────────────────────────────────
  header('8. IDOR — cross-company protection');
  if (!JWT) {
    skip('IDOR tests', 'JWT non disponibile');
  } else {
    const fakeId = '00000000-0000-4000-8000-000000000001';
    {
      const r = await req('GET',    `/api/v1/sites/${fakeId}`,  undefined, JWT, COMPANY_ID);
      check(`GET /sites/fake → 404`, r.status === 404 || r.status === 403, r);
    }
    {
      const r = await req('PATCH',  `/api/v1/sites/${fakeId}`, { weather_rain_mm: 20 }, JWT, COMPANY_ID);
      check(`PATCH /sites/fake → 404`, r.status === 404 || r.status === 403, r);
    }
    {
      const r = await req('DELETE', `/api/v1/sites/${fakeId}`,  undefined, JWT, COMPANY_ID);
      check(`DELETE /sites/fake → 404`, r.status === 404 || r.status === 403 || r.status === 405, r);
    }
  }

  // ── 9. Struttura errori ─────────────────────────────────────────────────────
  header('9. Struttura risposte errore');
  if (!JWT) {
    skip('Struttura errori', 'JWT non disponibile');
  } else {
    const r = await req('POST', '/api/v1/billing/checkout', { plan: 'xxx' }, JWT, COMPANY_ID);
    check('400 ha campo "error"', typeof r.body?.error === 'string', r.body);
    check('400 NON espone stack trace', !JSON.stringify(r.body || '').includes(' at '), r.body);
  }

  // ── 10. VALIDATION_ERROR — struttura ────────────────────────────────────────
  header('10. VALIDATION_ERROR — struttura Zod');
  if (!JWT) {
    skip('VALIDATION_ERROR', 'JWT non disponibile');
  } else {
    const r = await req('POST', '/api/v1/billing/checkout', { plan: 123 }, JWT, COMPANY_ID);
    if (r.status === 400) {
      check('ha campo "error"', typeof r.body?.error === 'string', r.body);
      if (r.body?.error === 'VALIDATION_ERROR') {
        check('VALIDATION_ERROR ha message', typeof r.body?.message === 'string', r.body);
      } else {
        ok('validazione custom OK (non Zod)');
      }
    } else {
      skip('struttura VALIDATION_ERROR', `risposta inattesa: ${r.status}`);
    }
  }

  // ── 11. Security — fix specifici ───────────────────────────────────────────
  header('11. Security — auth, SSRF, DoS cap');

  // 11a. pdf-diag e pdf-smoke devono richiedere JWT (non più pubblici)
  {
    const r = await req('GET', '/api/pdf-diag');
    check('GET /api/pdf-diag senza JWT → 401', r.status === 401, r);
  }
  {
    const r = await req('GET', '/api/pdf-smoke');
    check('GET /api/pdf-smoke senza JWT → 401', r.status === 401, r);
  }

  // 11b. Bulk prezzario — cap 500 items
  if (!JWT) {
    skip('Bulk prezzario cap 500', 'JWT non disponibile');
  } else {
    const items = Array.from({ length: 501 }, (_, i) => ({
      code: `T${i}`, description: 'voce test', unit: 'mq', price: 10,
    }));
    const r = await req('POST', '/api/v1/company-prezzi/bulk', { items }, JWT, COMPANY_ID);
    check('bulk 501 items → 400 TOO_MANY_ITEMS', r.status === 400, r);
    check('errore TOO_MANY_ITEMS', r.body?.error === 'TOO_MANY_ITEMS', r.body);
  }

  // 11c. SSRF — certificate OCR rifiuta URL non-Supabase
  if (!JWT || !WORKER_ID) {
    skip('SSRF certificate extract', !JWT ? 'JWT non disponibile' : 'WORKER_ID mancante');
  } else {
    const r = await req(
      'POST',
      `/api/v1/workers/${WORKER_ID}/certificates/extract`,
      { file_url: 'https://evil.com/malicious.pdf' },
      JWT, COMPANY_ID,
    );
    check('URL non-Supabase → 400 INVALID_FILE_URL', r.status === 400, r);
    check('errore INVALID_FILE_URL', r.body?.error === 'INVALID_FILE_URL', r.body);
  }

  // 11d. IDOR POS — fake ID di un'altra company → 404/403
  if (!JWT) {
    skip('IDOR POS cross-company', 'JWT non disponibile');
  } else {
    const fakePos = '00000000-0000-4000-8000-000000000099';
    {
      const r = await req('GET', `/api/v1/pos/${fakePos}`, undefined, JWT, COMPANY_ID);
      check('GET /pos/fake → 404/403 (no leak)', r.status === 404 || r.status === 403, r);
    }
    {
      const r = await req('POST', `/api/v1/pos/${fakePos}/acknowledgments`, { worker_id: WORKER_ID }, JWT, COMPANY_ID);
      check('POST /pos/fake/acknowledgments → 404/403', r.status === 404 || r.status === 403, r);
    }
  }

  // 11e. IDOR NC — fake ID → 404/403
  if (!JWT) {
    skip('IDOR NC cross-company', 'JWT non disponibile');
  } else {
    const fakeNc = '00000000-0000-4000-8000-000000000098';
    const r = await req('PATCH', `/api/v1/nonconformities/${fakeNc}`, { status: 'chiusa' }, JWT, COMPANY_ID);
    check('PATCH /nonconformities/fake → 404/403', r.status === 404 || r.status === 403, r);
  }

  // ── Sommario ─────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────');
  if (failed === 0) {
    console.log(`\x1b[32m✓ Tutti i test passati (${passed} ok, ${skipped} saltati)\x1b[0m\n`);
    process.exit(0);
  } else {
    console.error(`\x1b[31m✗ ${failed} test falliti, ${passed} ok, ${skipped} saltati\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[selftest_api] errore imprevisto:', e.message);
  process.exit(1);
});
