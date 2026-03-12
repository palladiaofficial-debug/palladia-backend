#!/usr/bin/env node
/**
 * scripts/test_badge_flow.js
 *
 * End-to-end integration test for the full PalladIA badge flow.
 * Tests both the admin API (JWT-protected) and the public scan endpoints.
 *
 * Env required:
 *   TEST_WORKSITE_ID        UUID of a configured worksite (with lat/lon)
 *   TEST_JWT                Supabase JWT of an admin/owner user
 *   TEST_COMPANY_ID         Company UUID (must match JWT)
 *   SUPABASE_URL            For direct DB trigger verification
 *   SUPABASE_KEY            Service role key
 *
 * Optional:
 *   TEST_BASE_URL           Default: http://localhost:3001
 *   TEST_PIN                PIN of the worksite (if set)
 *   TEST_EXIT_DELAY_MS      Delay between ENTRY and EXIT in ms (default: 65000 = 65s)
 *
 * Usage:
 *   node scripts/test_badge_flow.js
 *
 * Note: TEST_EXIT_DELAY_MS defaults to 65s to pass the 60s punch rate limit.
 *       Set to 5000 only in dev environments where punch_atomic() is patched to skip rate limit.
 */
'use strict';
require('dotenv').config();

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE       = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const WSITE_ID   = process.env.TEST_WORKSITE_ID;
const JWT        = process.env.TEST_JWT;
const COMPANY_ID = process.env.TEST_COMPANY_ID;
const TEST_PIN   = process.env.TEST_PIN || '';
const EXIT_DELAY = Number(process.env.TEST_EXIT_DELAY_MS) || 65_000;

// ── Preflight ─────────────────────────────────────────────────────────────────
if (!WSITE_ID || !JWT || !COMPANY_ID) {
  console.error('[FAIL] Required: TEST_WORKSITE_ID, TEST_JWT, TEST_COMPANY_ID');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('[FAIL] Required for DB tests: SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Test counters ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(msg)           { console.log(`  ✓ ${msg}`);       passed++; }
function fail(msg, detail) { console.error(`  ✗ ${msg}`, detail ?? ''); failed++; }
function check(label, cond, detail) {
  if (cond) ok(label);
  else fail(label, detail);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function httpPost(path, body, headers = {}) {
  const res  = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body)
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  return { status: res.status, body: parsed };
}

async function httpGet(path, headers = {}) {
  const res  = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  return { status: res.status, body: parsed };
}

function authHeaders() {
  return { Authorization: `Bearer ${JWT}`, 'X-Company-Id': COMPANY_ID };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function genTestCF() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const all    = chars + digits;
  let cf = '';
  for (let i = 0; i < 6; i++) cf += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 2; i++) cf += digits[Math.floor(Math.random() * digits.length)];
  cf += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 2; i++) cf += digits[Math.floor(Math.random() * digits.length)];
  cf += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 3; i++) cf += digits[Math.floor(Math.random() * digits.length)];
  cf += chars[Math.floor(Math.random() * chars.length)];
  return cf;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log(' PalladIA — Badge Flow End-to-End Test');
  console.log(`  base:     ${BASE}`);
  console.log(`  worksite: ${WSITE_ID}`);
  console.log(`  delay:    ${EXIT_DELAY}ms between ENTRY and EXIT`);
  console.log('═'.repeat(60));

  // Preflight: read worksite to get lat/lon for geofence tests
  const wsRes = await httpGet(`/api/v1/scan/worksites/${WSITE_ID}`);
  if (wsRes.status !== 200 || !wsRes.body.id) {
    console.error('\n[FATAL] Cannot load worksite. Check TEST_WORKSITE_ID and server.');
    process.exit(1);
  }
  const site = wsRes.body;
  console.log(`\n  Worksite: "${site.name}" — geofence: ${site.geofence_radius_m}m`);

  // We need real lat/lon for punch — fetch from admin API (sites list)
  const siteAdminRes = await httpGet('/api/v1/sites', authHeaders());
  const siteDetails  = Array.isArray(siteAdminRes.body)
    ? siteAdminRes.body.find(s => s.id === WSITE_ID)
    : null;
  const siteLat = siteDetails?.latitude;
  const siteLon = siteDetails?.longitude;
  if (siteLat == null || siteLon == null) {
    console.error('\n[FATAL] Worksite has no coordinates. Configure lat/lon first.');
    process.exit(1);
  }

  const testCF   = genTestCF();
  const fullName = `Test Worker ${testCF.slice(0, 4)}`;
  let   workerId, sessionToken;
  let   logRowId;

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 1 — Create worker via admin API
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nStep 1 — Create worker via POST /api/v1/workers');
  {
    const r = await httpPost('/api/v1/workers',
      { full_name: fullName, fiscal_code: testCF },
      authHeaders()
    );
    check('status 201',             r.status === 201,                    r);
    check('id returned',            typeof r.body.id === 'string',       r.body);
    check('fiscal_code uppercase',  r.body.fiscal_code === testCF,       r.body);
    check('is_active true',         r.body.is_active === true,           r.body);
    workerId = r.body.id;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 2 — Identify worker (scan API, public)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nStep 2 — Identify worker via POST /scan/identify');
  {
    const r = await httpPost('/api/v1/scan/identify', {
      worksite_id: WSITE_ID,
      fiscal_code: testCF,
      full_name:   fullName,
      pin_code:    TEST_PIN || undefined
    });
    check('status 200',             r.status === 200,                    r);
    check('session_token returned', typeof r.body.session_token === 'string', r.body);
    check('token length = 64',      r.body.session_token?.length === 64, r.body);
    check('worker_name correct',    r.body.worker_name === fullName,     r.body);
    check('expires_in_days = 60',   r.body.expires_in_days === 60,       r.body);
    check('company_id NOT exposed', r.body.company_id == null,           r.body);
    sessionToken = r.body.session_token;
  }

  if (!sessionToken) {
    console.error('\n[FATAL] No session token — cannot continue punch tests.');
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 3 — Punch ENTRY
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nStep 3 — Punch ENTRY');
  {
    const r = await httpPost('/api/v1/scan/punch', {
      worksite_id:    WSITE_ID,
      session_token:  sessionToken,
      latitude:       siteLat,
      longitude:      siteLon,
      gps_accuracy_m: 12.3
    });
    check('status 200',             r.status === 200,                    r);
    check('event_type = ENTRY',     r.body.event_type === 'ENTRY',       r.body);
    check('distance_m = 0',         r.body.distance_m === 0,             r.body);
    check('timestamp_server present', typeof r.body.timestamp_server === 'string', r.body);

    // Grab the last log ID for append-only test later
    const { data } = await supabase
      .from('presence_logs')
      .select('id')
      .eq('site_id', WSITE_ID)
      .order('timestamp_server', { ascending: false })
      .limit(1)
      .maybeSingle();
    logRowId = data?.id;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 4 — Immediate second punch → PUNCH_TOO_SOON (rate limit)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nStep 4 — Second punch immediately → expect PUNCH_TOO_SOON');
  {
    const r = await httpPost('/api/v1/scan/punch', {
      worksite_id:    WSITE_ID,
      session_token:  sessionToken,
      latitude:       siteLat,
      longitude:      siteLon,
      gps_accuracy_m: 12.3
    });
    check('status 429',              r.status === 429,                   r);
    check('error = PUNCH_TOO_SOON',  r.body.error === 'PUNCH_TOO_SOON',  r.body);
    check('retry_after_secs present', typeof r.body.retry_after_secs === 'number', r.body);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 5 — Wait then punch EXIT
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\nStep 5 — Wait ${EXIT_DELAY / 1000}s then punch EXIT`);
  console.log('  (waiting…)');
  await sleep(EXIT_DELAY);
  {
    const r = await httpPost('/api/v1/scan/punch', {
      worksite_id:    WSITE_ID,
      session_token:  sessionToken,
      latitude:       siteLat,
      longitude:      siteLon,
      gps_accuracy_m: 12.3
    });
    check('status 200',             r.status === 200,                    r);
    check('event_type = EXIT',      r.body.event_type === 'EXIT',        r.body);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 6 — Punch outside geofence → OUTSIDE_GEOFENCE
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nStep 6 — Punch from ~555km away → expect OUTSIDE_GEOFENCE');
  // Wait 65s to avoid PUNCH_TOO_SOON
  await sleep(EXIT_DELAY);
  {
    const farLat = siteLat + (siteLat <= 85 ? 5 : -5);
    const r = await httpPost('/api/v1/scan/punch', {
      worksite_id:    WSITE_ID,
      session_token:  sessionToken,
      latitude:       farLat,
      longitude:      siteLon,
      gps_accuracy_m: 12.3
    });
    check('status 403',              r.status === 403,                    r);
    check('error = OUTSIDE_GEOFENCE', r.body.error === 'OUTSIDE_GEOFENCE', r.body);
    check('distance_m > 1000',       r.body.distance_m > 1000,           r.body);
    check('max_allowed_m present',   typeof r.body.max_allowed_m === 'number', r.body);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 7 — Export presence report (admin API)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nStep 7 — Export presence report CSV');
  {
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch(
      `${BASE}/api/v1/worksites/${WSITE_ID}/presence-report?format=csv&from=${today}&to=${today}`,
      { headers: authHeaders() }
    );
    check('status 200',                  r.status === 200,                              { status: r.status });
    check('content-type text/csv',       r.headers.get('content-type')?.includes('csv'), r.headers.get('content-type'));
    const csv = await r.text();
    check('CSV has header row',          csv.includes('lavoratore') || csv.includes('full_name'), { csv: csv.slice(0, 200) });
    check('CSV has data rows',           csv.split('\n').length > 2,                    { lines: csv.split('\n').length });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 8 — Attempt UPDATE on presence_logs → must fail (append-only trigger)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nStep 8 — Attempt UPDATE presence_logs → must be blocked by trigger');
  if (!logRowId) {
    fail('prerequisito: logRowId da step 3');
  } else {
    const { error: updErr } = await supabase
      .from('presence_logs')
      .update({ event_type: 'EXIT' })
      .eq('id', logRowId);

    check('UPDATE blocked',                    !!updErr,                                               updErr?.message);
    check('message contains "append-only"',    updErr?.message?.toLowerCase().includes('append-only'), updErr?.message);

    const { error: delErr } = await supabase
      .from('presence_logs')
      .delete()
      .eq('id', logRowId);

    check('DELETE blocked',                    !!delErr,                                               delErr?.message);
    check('message contains "append-only"',    delErr?.message?.toLowerCase().includes('append-only'), delErr?.message);

    // Verify record still exists
    const { data: stillThere } = await supabase
      .from('presence_logs')
      .select('id')
      .eq('id', logRowId)
      .maybeSingle();
    check('record intact after DELETE attempt', stillThere?.id === logRowId,                           stillThere);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` Result: ${passed}/${total} checks passed`);
  console.log(`${'═'.repeat(60)}`);

  if (failed > 0) {
    console.error(`\n\x1b[31m[FAIL] ${failed} check(s) failed. Do NOT deploy.\x1b[0m\n`);
    process.exit(1);
  } else {
    console.log(`\n\x1b[32m[OK] All checks passed. Ready for deployment.\x1b[0m\n`);
  }
}

run().catch(e => {
  console.error('\n[FATAL]', e.message);
  process.exit(1);
});
