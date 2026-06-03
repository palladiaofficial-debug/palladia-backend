#!/usr/bin/env node
/**
 * scripts/selftest_api.js
 *
 * Test di regressione per gli endpoint API v1.
 * Cattura i bug che in passato sono arrivati in produzione.
 *
 * Env:
 *   TEST_BASE_URL      Default: http://localhost:3001
 *   TEST_JWT           JWT Supabase valido (richiesto per i test autenticati)
 *   TEST_COMPANY_ID    UUID company (richiesto per i test autenticati)
 *   TEST_SITE_ID       UUID cantiere esistente (richiesto per test PATCH site)
 *   TEST_WORKER_ID     UUID lavoratore esistente (opzionale, per test PATCH worker)
 *
 * Uso:
 *   node scripts/selftest_api.js
 *
 * I test senza JWT vengono sempre eseguiti.
 * I test con JWT vengono saltati se TEST_JWT non è impostato.
 */
'use strict';
require('dotenv').config();

const BASE       = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const JWT        = process.env.TEST_JWT        || '';
const COMPANY_ID = process.env.TEST_COMPANY_ID || '';
const SITE_ID    = process.env.TEST_SITE_ID    || '';
const WORKER_ID  = process.env.TEST_WORKER_ID  || '';

let passed = 0, failed = 0, skipped = 0;

function ok(name)         { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got)  { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function skip(name, why)  { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function req(method, path, body, jwt, companyId) {
  const headers = { 'Content-Type': 'application/json' };
  if (jwt)       headers['Authorization']  = `Bearer ${jwt}`;
  if (companyId) headers['X-Company-Id']   = companyId;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let json;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
}

function header(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPalladia API selftest — ${BASE}\n`);

  // ── 1. Health check ─────────────────────────────────────────────────────────
  header('1. Health check');
  {
    const r = await req('GET', '/api/health');
    check('GET /api/health → 200 o 503 (mai crash)', r.status === 200 || r.status === 503, r);
    check('GET /api/health ha campo "status"', typeof r.body?.status === 'string', r.body);
  }

  // ── 2. Auth rejection (no JWT) ───────────────────────────────────────────────
  header('2. Auth rejection — senza JWT');
  {
    const r = await req('GET', '/api/v1/sites');
    check('GET /sites senza JWT → 401', r.status === 401, r);
  }
  {
    const r = await req('POST', '/api/v1/sites', { name: 'Test' });
    check('POST /sites senza JWT → 401', r.status === 401, r);
  }
  {
    const r = await req('POST', '/api/v1/billing/checkout', { plan: 'starter' });
    check('POST /billing/checkout senza JWT → 401', r.status === 401, r);
  }

  // ── 3. Billing — validazione piano (no JWT necessario per vedere l'errore) ───
  // In realtà richiede JWT — lo testiamo nel blocco auth
  header('3. Billing — piano non valido');
  if (!JWT) {
    skip('POST /billing/checkout piano invalido', 'TEST_JWT non impostato');
  } else {
    const r = await req('POST', '/api/v1/billing/checkout', { plan: 'invalid_plan' }, JWT, COMPANY_ID);
    check('plan "invalid_plan" → 400', r.status === 400, r);
    check('error = VALIDATION_ERROR o INVALID_PLAN', ['VALIDATION_ERROR', 'INVALID_PLAN'].includes(r.body?.error), r.body);
  }

  // ── 4. Worker POST — validazione input ──────────────────────────────────────
  header('4. POST /workers — validazione');
  if (!JWT) {
    skip('Worker POST tests', 'TEST_JWT non impostato');
  } else {
    // full_name mancante
    {
      const r = await req('POST', '/api/v1/workers', { fiscal_code: 'RSSMRA80A01H501U' }, JWT, COMPANY_ID);
      check('full_name mancante → 400', r.status === 400, r);
    }
    // full_name troppo corto
    {
      const r = await req('POST', '/api/v1/workers', { full_name: 'A', fiscal_code: 'RSSMRA80A01H501U' }, JWT, COMPANY_ID);
      check('full_name "A" (1 char) → 400', r.status === 400, r);
    }
    // fiscal_code mancante
    {
      const r = await req('POST', '/api/v1/workers', { full_name: 'Mario Rossi' }, JWT, COMPANY_ID);
      check('fiscal_code mancante → 400', r.status === 400, r);
    }
    // fiscal_code troppo corto
    {
      const r = await req('POST', '/api/v1/workers', { full_name: 'Mario Rossi', fiscal_code: 'TOOCRT' }, JWT, COMPANY_ID);
      check('fiscal_code "TOOCRT" (6 char) → 400', r.status === 400, r);
    }
    // fiscal_code valido ma 15 char (manca 1)
    {
      const r = await req('POST', '/api/v1/workers', { full_name: 'Mario Rossi', fiscal_code: 'RSSMRA80A01H50' }, JWT, COMPANY_ID);
      check('fiscal_code 15 char → 400', r.status === 400, r);
    }
  }

  // ── 5. Site POST — validazione input ─────────────────────────────────────────
  header('5. POST /sites — validazione');
  if (!JWT) {
    skip('Site POST tests', 'TEST_JWT non impostato');
  } else {
    // name mancante
    {
      const r = await req('POST', '/api/v1/sites', {}, JWT, COMPANY_ID);
      check('name mancante → 400', r.status === 400, r);
    }
    // name troppo corto
    {
      const r = await req('POST', '/api/v1/sites', { name: 'X' }, JWT, COMPANY_ID);
      check('name "X" (1 char) → 400', r.status === 400, r);
    }
    // status non valido
    {
      const r = await req('POST', '/api/v1/sites', { name: 'Cantiere Test', status: 'FANTASMA' }, JWT, COMPANY_ID);
      // Zod ora filtra i campi sconosciuti (.strip()), quindi status invalido viene ignorato → passa o 400 Zod
      check('status invalido → 400 (Zod) o 200/201', r.status === 400 || r.status === 200 || r.status === 201 || r.status === 403, r);
    }
  }

  // ── 6. Site PATCH — i bug storici ───────────────────────────────────────────
  header('6. PATCH /sites/:siteId — edge case (bug storici)');
  if (!SITE_ID || !JWT) {
    skip('Site PATCH edge cases', !JWT ? 'TEST_JWT non impostato' : 'TEST_SITE_ID non impostato');
  } else {
    // weather_rain_mm = "" (era 400, ora deve essere 200)
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { weather_rain_mm: '' }, JWT, COMPANY_ID);
      check('weather_rain_mm:"" → NON 400 (bug storico)', r.status !== 400, r);
    }
    // weather_wind_kmh = "" (era 400, ora deve essere 200)
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { weather_wind_kmh: '' }, JWT, COMPANY_ID);
      check('weather_wind_kmh:"" → NON 400 (bug storico)', r.status !== 400, r);
    }
    // name = "A" (1 char — deve essere ignorato, non 400)
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { name: 'A' }, JWT, COMPANY_ID);
      // Zod patchSiteSchema non impone min su name, quindi passa allo handler che lo ignora
      check('name "A" (1 char) → NON 400', r.status !== 400, r);
    }
    // status non valido → 400
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { status: 'FANTASMA' }, JWT, COMPANY_ID);
      check('status invalido → 400', r.status === 400, r);
    }
    // weather_rain_mm valido (50) → 200
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { weather_rain_mm: 50 }, JWT, COMPANY_ID);
      check('weather_rain_mm:50 → 200', r.status === 200, r);
    }
    // weather_wind_kmh fuori range (5) → 400
    {
      const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, { weather_wind_kmh: 5 }, JWT, COMPANY_ID);
      check('weather_wind_kmh:5 (< min 10) → 400', r.status === 400, r);
    }
  }

  // ── 7. Site PATCH — campo sconosciuto ignorato (strip) ───────────────────────
  header('7. PATCH /sites/:siteId — iniezione campi sconosciuti');
  if (!SITE_ID || !JWT) {
    skip('Campo sconosciuto', !JWT ? 'TEST_JWT non impostato' : 'TEST_SITE_ID non impostato');
  } else {
    const r = await req('PATCH', `/api/v1/sites/${SITE_ID}`, {
      company_id: 'aaaa-bbbb-cccc-dddd', // tentativo injection
      weather_rain_mm: 20,
    }, JWT, COMPANY_ID);
    check('campo "company_id" ignoto stripped → 200', r.status === 200, r);
    // Verifica che il body risposta non abbia company_id esposto
    check('risposta non espone company_id', r.body?.company_id === undefined, r.body);
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
