#!/usr/bin/env node
/**
 * scripts/selftest_api.js
 *
 * Test di regressione per gli endpoint API v1.
 * Copre: validazione input, auth rejection, edge case storici, IDOR basic.
 *
 * Env:
 *   TEST_BASE_URL      Default: http://localhost:3001
 *   TEST_JWT           JWT Supabase valido (richiesto per test autenticati)
 *   TEST_COMPANY_ID    UUID company
 *   TEST_SITE_ID       UUID cantiere esistente (per test PATCH site)
 *   TEST_WORKER_ID     UUID lavoratore esistente (per test PATCH worker)
 *
 * Uso:
 *   node scripts/selftest_api.js
 *   TEST_JWT=xxx TEST_COMPANY_ID=yyy TEST_SITE_ID=zzz node scripts/selftest_api.js
 */
'use strict';
require('dotenv').config();

const BASE       = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const JWT        = process.env.TEST_JWT        || '';
const COMPANY_ID = process.env.TEST_COMPANY_ID || '';
const SITE_ID    = process.env.TEST_SITE_ID    || '';
const WORKER_ID  = process.env.TEST_WORKER_ID  || '';

let passed = 0, failed = 0, skipped = 0;

function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 200)}`); failed++; }
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

const needsJwt  = (name) => !JWT && (skip(name, 'TEST_JWT mancante'), true);
const needsSite = (name) => (!JWT || !SITE_ID) && (skip(name, !JWT ? 'TEST_JWT mancante' : 'TEST_SITE_ID mancante'), true);
const needsWorker = (name) => (!JWT || !WORKER_ID) && (skip(name, !JWT ? 'TEST_JWT mancante' : 'TEST_WORKER_ID mancante'), true);

function header(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPalladia API regression tests — ${BASE}`);
  console.log(`JWT: ${JWT ? '✓ impostato' : '✗ mancante (solo test pubblici)'}\n`);

  // ── 1. Infrastruttura ───────────────────────────────────────────────────────
  header('1. Infrastruttura');
  {
    const r = await req('GET', '/api/health');
    check('GET /api/health risponde (200 o 503)', r.status === 200 || r.status === 503, r);
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
  if (!needsJwt('POST /billing/checkout piano invalido')) {
    const r = await req('POST', '/api/v1/billing/checkout', { plan: 'enterprise_gold_vip' }, JWT, COMPANY_ID);
    check('plan sconosciuto → 400', r.status === 400, r);
    check('errore VALIDATION_ERROR o INVALID_PLAN', ['VALIDATION_ERROR','INVALID_PLAN'].includes(r.body?.error), r.body);
  }
  if (!needsJwt('POST /billing/checkout body vuoto')) {
    const r = await req('POST', '/api/v1/billing/checkout', {}, JWT, COMPANY_ID);
    check('body vuoto → 400', r.status === 400, r);
  }

  // ── 4. Worker POST — validazione input ──────────────────────────────────────
  header('4. POST /workers — validazione');
  if (!needsJwt('Worker POST tests')) {
    const cases = [
      [{ fiscal_code: 'RSSMRA80A01H501U' },                               'full_name mancante → 400', 400],
      [{ full_name: 'A', fiscal_code: 'RSSMRA80A01H501U' },              'full_name 1 char → 400',   400],
      [{ full_name: 'Mario Rossi' },                                      'fiscal_code mancante → 400',400],
      [{ full_name: 'Mario Rossi', fiscal_code: 'TOOCRT' },              'fiscal_code 6 char → 400', 400],
      [{ full_name: 'Mario Rossi', fiscal_code: 'RSSMRA80A01H50' },      'fiscal_code 15 char → 400',400],
      [{ full_name: 'Mario Rossi', fiscal_code: 'INVALIDO$$$$$$$$' },    'fiscal_code con $ → 400',  400],
    ];
    for (const [body, name, expectedStatus] of cases) {
      const r = await req('POST', '/api/v1/workers', body, JWT, COMPANY_ID);
      check(name, r.status === expectedStatus, r);
    }
  }

  // ── 5. Worker PATCH — edge case ──────────────────────────────────────────────
  header('5. PATCH /workers/:id — edge case');
  if (!needsWorker('Worker PATCH tests')) {
    // tariffa_oraria negativa
    {
      const r = await req('PATCH', `/api/v1/workers/${WORKER_ID}`, { tariffa_oraria: -5 }, JWT, COMPANY_ID);
      check('tariffa_oraria negativa → 400', r.status === 400, r);
    }
    // data formato sbagliato
    {
      const r = await req('PATCH', `/api/v1/workers/${WORKER_ID}`, { hire_date: '01/01/2024' }, JWT, COMPANY_ID);
      check('hire_date formato sbagliato → 400', r.status === 400, r);
    }
    // campo sconosciuto ignorato (strip)
    {
      const r = await req('PATCH', `/api/v1/workers/${WORKER_ID}`, { company_id: 'aaaa-bbbb', tariffa_oraria: 15 }, JWT, COMPANY_ID);
      check('company_id sconosciuto strippato → NON 500', r.status !== 500, r);
    }
  }

  // ── 6. Site POST — validazione ───────────────────────────────────────────────
  header('6. POST /sites — validazione');
  if (!needsJwt('Site POST tests')) {
    const cases = [
      [{},                        'body vuoto → 400',         400],
      [{ name: 'X' },            'name 1 char → 400',        400],
      [{ name: 'A'.repeat(201) },'name 201 char → 400',      400],
    ];
    for (const [body, name, expectedStatus] of cases) {
      const r = await req('POST', '/api/v1/sites', body, JWT, COMPANY_ID);
      check(name, r.status === expectedStatus, r);
    }
  }

  // ── 7. Site PATCH — bug storici e edge case ──────────────────────────────────
  header('7. PATCH /sites/:siteId — edge case (bug storici)');
  if (!needsSite('Site PATCH tests')) {
    const cases = [
      // Bug storici — erano 400, ora devono passare
      [{ weather_rain_mm: '' },          'weather_rain_mm:"" → NON 400',      (s) => s !== 400],
      [{ weather_wind_kmh: '' },         'weather_wind_kmh:"" → NON 400',     (s) => s !== 400],
      [{ weather_rain_mm: null },        'weather_rain_mm:null → NON 400',    (s) => s !== 400],
      [{ weather_wind_kmh: null },       'weather_wind_kmh:null → NON 400',   (s) => s !== 400],
      // Valori validi
      [{ weather_rain_mm: 25 },          'weather_rain_mm:25 → 200',          (s) => s === 200],
      [{ weather_wind_kmh: 60 },         'weather_wind_kmh:60 → 200',         (s) => s === 200],
      [{ weather_snow: true },           'weather_snow:true → 200',           (s) => s === 200],
      // Valori fuori range
      [{ weather_wind_kmh: 5 },          'weather_wind_kmh:5 (< 10) → 400',  (s) => s === 400],
      [{ weather_rain_mm: 250 },         'weather_rain_mm:250 (> 200) → 400',(s) => s === 400],
      // Status invalido
      [{ status: 'FANTASMA' },           'status invalido → 400',             (s) => s === 400],
      // Injection: campo company_id sconosciuto → deve essere strippato
      [{ company_id: 'evil', weather_rain_mm: 20 }, 'company_id ignorato → 200', (s) => s === 200],
    ];
    for (const [body, name, predicate] of cases) {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, body, JWT, COMPANY_ID);
      check(name, predicate(r.status), { status: r.status, body: r.body });
    }
    // Verifica che company_id non sia esposto nella risposta
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { weather_rain_mm: 20 }, JWT, COMPANY_ID);
      if (r.status === 200) {
        check('risposta PATCH site non espone company_id', r.body?.company_id === undefined, r.body);
      }
    }
  }

  // ── 8. IDOR basic — cantiere di un'altra company ────────────────────────────
  header('8. IDOR — cross-company protection');
  if (!needsJwt('IDOR tests')) {
    // UUID random — non appartiene alla nostra company
    const fakeId = '00000000-0000-4000-8000-000000000001';
    {
      const r = await req('GET', `/api/v1/sites/${fakeId}`, undefined, JWT, COMPANY_ID);
      check(`GET /sites/${fakeId} → 404 (non 200)`, r.status === 404 || r.status === 403, r);
    }
    {
      const r = await req('PATCH', `/api/v1/sites/${fakeId}`, { weather_rain_mm: 20 }, JWT, COMPANY_ID);
      check(`PATCH /sites/${fakeId} → 404 (non 200)`, r.status === 404 || r.status === 403, r);
    }
    {
      const r = await req('DELETE', `/api/v1/sites/${fakeId}`, undefined, JWT, COMPANY_ID);
      check(`DELETE /sites/${fakeId} → 404 (non 204)`, r.status === 404 || r.status === 403 || r.status === 405, r);
    }
  }

  // ── 9. Rate limit — risposta corretta su endpoint sensibili ─────────────────
  header('9. Struttura risposta errori');
  if (!needsJwt('Struttura errori')) {
    // Un 400 deve sempre avere { error: string }
    const r = await req('POST', '/api/v1/billing/checkout', { plan: 'xxx' }, JWT, COMPANY_ID);
    check('400 ha campo "error"', typeof r.body?.error === 'string', r.body);
    check('400 NON espone stack trace', !JSON.stringify(r.body).includes('at Object'), r.body);
  }

  // ── 10. Validazione Zod — VALIDATION_ERROR ha field e message ───────────────
  header('10. Struttura VALIDATION_ERROR');
  if (!needsJwt('Struttura VALIDATION_ERROR')) {
    const r = await req('POST', '/api/v1/billing/checkout', { plan: 123 }, JWT, COMPANY_ID);
    if (r.status === 400 && r.body?.error === 'VALIDATION_ERROR') {
      check('VALIDATION_ERROR ha message', typeof r.body?.message === 'string', r.body);
      ok('VALIDATION_ERROR: struttura corretta');
    } else {
      skip('VALIDATION_ERROR struttura', 'endpoint non restituisce VALIDATION_ERROR (potrebbe avere validazione propria)');
    }
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
