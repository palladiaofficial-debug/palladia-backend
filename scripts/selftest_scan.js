#!/usr/bin/env node
/**
 * scripts/selftest_scan.js
 *
 * Test automatici per gli endpoint pubblici Badge Scan.
 * Richiede il server già in esecuzione.
 *
 * Env obbligatorie:
 *   TEST_WORKSITE_ID         UUID di un cantiere con lat/lon configurate
 *   SUPABASE_URL             Per test DB diretti (trigger append-only)
 *   SUPABASE_KEY             Service key
 *   PIN_SIGNING_SECRET       Stesso secret del server
 *
 * Env opzionali:
 *   TEST_BASE_URL            Default: http://localhost:3001
 *   TEST_PIN                 PIN del cantiere (se impostato)
 *   GPS_MAX_ACCURACY_M       Deve coincidere con il valore del server (default 80)
 *   GPS_ACCURACY_REQUIRE_MODE  'strict' (default) | 'compat'
 *
 * Uso:
 *   node scripts/selftest_scan.js
 *
 * 10 gruppi di test (+ 2 mini-check in test 3) — tutti devono passare per deploy sicuro.
 * In modalità 'compat' il test 3 verifica il comportamento di transizione (202 no-write).
 *
 * Test rapido per entrambe le modalità:
 *   node scripts/selftest_scan.js
 *   GPS_ACCURACY_REQUIRE_MODE=compat node scripts/selftest_scan.js
 */
'use strict';
require('dotenv').config();

const crypto   = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE     = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const WSITE_ID = process.env.TEST_WORKSITE_ID;
const TEST_PIN = process.env.TEST_PIN || '';

// Modalità accuracy — deve coincidere con ENV del server
const IS_STRICT = process.env.GPS_ACCURACY_REQUIRE_MODE !== 'compat';

// ── Preflight checks ──────────────────────────────────────────────────────────
if (!WSITE_ID) {
  console.error('[FAIL] TEST_WORKSITE_ID env var obbligatoria');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('[FAIL] SUPABASE_URL e SUPABASE_KEY obbligatorie per test DB (test 8+9)');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function ok(name) {
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  passed++;
}
function fail(name, got) {
  console.error(`  \x1b[31m✗\x1b[0m ${name}`);
  if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`);
  failed++;
}
function check(name, cond, got) {
  cond ? ok(name) : fail(name, got);
}

async function httpPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

async function httpGet(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}

// CF test univoco: 4 lettere + 12 hex = 16 char alfanumerici
function genTestCF() {
  return `TEST${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

// ── Test suite ────────────────────────────────────────────────────────────────
async function run() {
  const modeLabel = IS_STRICT ? 'strict' : 'compat';
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` selftest_scan — ${BASE}  [mode: ${modeLabel}]`);
  console.log(`${'═'.repeat(60)}\n`);

  // Verifica che il cantiere abbia lat/lon (necessario per i test punch)
  const { data: site } = await supabase
    .from('sites')
    .select('latitude, longitude, geofence_radius_m')
    .eq('id', WSITE_ID)
    .single();

  if (!site) {
    console.error(`[FAIL] Cantiere ${WSITE_ID} non trovato nel DB.`);
    process.exit(1);
  }
  if (site.latitude == null || site.longitude == null) {
    console.error('[FAIL] Il cantiere non ha lat/lon: configurarle prima di eseguire i test.');
    console.error('  UPDATE sites SET latitude=<val>, longitude=<val> WHERE id=\'<uuid>\';');
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1 — GET worksite info: 200, no dati sensibili, max_gps_accuracy_m presente
  // ──────────────────────────────────────────────────────────────────────────
  console.log('Test 1 — GET /scan/worksites/:id');
  const t1 = await httpGet(`/api/v1/scan/worksites/${WSITE_ID}`);

  check('status 200',                    t1.status === 200,                                       t1.status);
  check('no company_id in response',     !('company_id' in t1.body),                              t1.body);
  check('no pin_hash/pin_code',          !('pin_hash' in t1.body) && !('pin_code' in t1.body),    t1.body);
  check('no latitude/longitude raw',     !('latitude' in t1.body) && !('longitude' in t1.body),   t1.body);
  check('ha campo has_geofence',         typeof t1.body.has_geofence === 'boolean',                t1.body);
  check('has_geofence = true',           t1.body.has_geofence === true,                           t1.body);
  check('max_gps_accuracy_m presente',   typeof t1.body.max_gps_accuracy_m === 'number',          t1.body);

  // Leggi la soglia effettiva dal backend per usarla nei test successivi
  const serverMaxAcc = t1.body.max_gps_accuracy_m ?? 80;

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2 — POST identify: 200, session_token presente (worker A)
  // Worker A viene usato per i test di validazione 3 e 4 (che non producono
  // timbrature reali in strict, oppure una sola in compat).
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\nTest 2 — POST /scan/identify (worker A)');
  const cfA = genTestCF();
  const t2 = await httpPost('/api/v1/scan/identify', {
    worksite_id: WSITE_ID,
    fiscal_code: cfA,
    full_name:   'Test Worker Alpha',
    pin_code:    TEST_PIN || undefined
  });

  check('status 200',                    t2.status === 200,                                                   t2);
  check('session_token: 64 hex chars',   typeof t2.body.session_token === 'string' && t2.body.session_token.length === 64, t2.body);
  check('worker_name presente',          typeof t2.body.worker_name === 'string',                             t2.body);
  check('worker_id presente',            typeof t2.body.worker_id === 'string',                               t2.body);
  check('no company_id in response',     !('company_id' in t2.body),                                          t2.body);
  check('expires_in_days = 60',          t2.body.expires_in_days === 60,                                      t2.body);

  const sessionTokenA = t2.body.session_token;

  if (!sessionTokenA) {
    console.error('\n[ABORT] identify fallito: impossibile continuare i test.\n');
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3 — POST punch senza gps_accuracy_m
  //   strict → 422 GPS_ACCURACY_REQUIRED
  //   compat → 202 REFRESH_REQUIRED (nessuna scrittura in DB)
  //            Il 202 viene emesso solo dopo aver verificato sessione e cantiere
  //            (anti-spam): worker A resta senza punch → test 5-7 usano worker C
  //            fresco, senza rischio rate-limit.
  //
  // 3a — mini-test: punch senza session_token => 400 (sempre, in ogni modalità)
  // ──────────────────────────────────────────────────────────────────────────
  console.log(`\nTest 3 — POST /scan/punch senza gps_accuracy_m [mode: ${modeLabel}]`);

  // 3a — mini-test: session_token mancante deve dare 400 (anche in compat)
  const t3a = await httpPost('/api/v1/scan/punch', {
    worksite_id: WSITE_ID,
    latitude:    site.latitude,
    longitude:   site.longitude
    // session_token assente
  });
  check('3a: status 400 senza session_token',   t3a.status === 400,                 t3a);
  check('3a: error = MISSING_FIELDS',           t3a.body.error === 'MISSING_FIELDS', t3a.body);

  // 3b — test principale: accuracy mancante con sessione valida
  const t3 = await httpPost('/api/v1/scan/punch', {
    worksite_id:   WSITE_ID,
    session_token: sessionTokenA,
    latitude:      site.latitude,
    longitude:     site.longitude
    // gps_accuracy_m assente
  });

  if (IS_STRICT) {
    check('status 422',                    t3.status === 422,                             t3);
    check('error = GPS_ACCURACY_REQUIRED', t3.body.error === 'GPS_ACCURACY_REQUIRED',    t3.body);
    check('max_accuracy_m nel body',       typeof t3.body.max_accuracy_m === 'number',   t3.body);
  } else {
    // compat: nessuna scrittura in DB — backend risponde 202 dopo aver validato sessione+cantiere
    check('status 202',                    t3.status === 202,                             t3);
    check('warning GPS_ACCURACY_MISSING',  t3.body.warning === 'GPS_ACCURACY_MISSING',   t3.body);
    check('action REFRESH_REQUIRED',       t3.body.action  === 'REFRESH_REQUIRED',        t3.body);
    check('max_accuracy_m nel body',       typeof t3.body.max_accuracy_m === 'number',   t3.body);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4 — POST punch con gps_accuracy_m > soglia: 422 GPS_ACCURACY_TOO_LOW
  // (accuracy molto alta >> soglia server)
  // In entrambe le modalità: l'accuracy check è PRIMA del rate-limit,
  // quindi anche in compat (dove worker A ha già punched) otteniamo 422.
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\nTest 4 — POST /scan/punch con accuracy molto alta (422 GPS_ACCURACY_TOO_LOW)');
  const highAcc = serverMaxAcc + 500;   // sempre sopra la soglia
  const t4 = await httpPost('/api/v1/scan/punch', {
    worksite_id:    WSITE_ID,
    session_token:  sessionTokenA,
    latitude:       site.latitude,
    longitude:      site.longitude,
    gps_accuracy_m: highAcc
  });

  check('status 422',                    t4.status === 422,                                        t4);
  check('error = GPS_ACCURACY_TOO_LOW',  t4.body.error === 'GPS_ACCURACY_TOO_LOW',                 t4.body);
  check('accuracy_m nel body',           t4.body.accuracy_m === Math.round(highAcc),               t4.body);
  check('max_accuracy_m nel body',       t4.body.max_accuracy_m === serverMaxAcc,                  t4.body);

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5 — POST punch happy-path: 200 ENTRY, accuracy ok (worker C)
  // Worker C è sempre fresco (nessun punch precedente) → no rate-limit in entrambe le modalità.
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\nTest 5 — POST /scan/punch ENTRY (worker C, accuracy ok)');

  let sessionTokenC = null;
  const cfC = genTestCF();
  const t5_id = await httpPost('/api/v1/scan/identify', {
    worksite_id: WSITE_ID,
    fiscal_code: cfC,
    full_name:   'Test Worker Gamma',
    pin_code:    TEST_PIN || undefined
  });

  if (t5_id.status !== 200) {
    fail('worker C identify ok', t5_id);
  } else {
    sessionTokenC = t5_id.body.session_token;
    const goodAcc = Math.min(12.3, serverMaxAcc - 1);   // sicuramente sotto soglia

    const t5 = await httpPost('/api/v1/scan/punch', {
      worksite_id:    WSITE_ID,
      session_token:  sessionTokenC,
      latitude:       site.latitude,   // stessa posizione → distanza 0
      longitude:      site.longitude,
      gps_accuracy_m: goodAcc
    });

    check('status 200',                  t5.status === 200,                                        t5);
    check('event_type = ENTRY',          t5.body.event_type === 'ENTRY',                           t5.body);
    check('timestamp_server presente',   typeof t5.body.timestamp_server === 'string',             t5.body);
    check('distance_m = 0',             t5.body.distance_m === 0,                                  t5.body);
    check('gps_accuracy_m rounded',      t5.body.gps_accuracy_m === Math.round(goodAcc),           t5.body);
    check('gps_accuracy_m_raw presente', t5.body.gps_accuracy_m_raw === goodAcc,                   t5.body);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6 — POST punch subito dopo (worker C): 429 PUNCH_TOO_SOON
  // Worker C ha appena timbrato nel test 5.
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\nTest 6 — POST /scan/punch subito dopo (rate limit 60s, worker C)');

  if (!sessionTokenC) {
    fail('prerequisito: sessionTokenC da test 5');
  } else {
    const t6 = await httpPost('/api/v1/scan/punch', {
      worksite_id:    WSITE_ID,
      session_token:  sessionTokenC,
      latitude:       site.latitude,
      longitude:      site.longitude,
      gps_accuracy_m: 12.3
    });

    check('status 429',                  t6.status === 429,                                        t6);
    check('error = PUNCH_TOO_SOON',      t6.body.error === 'PUNCH_TOO_SOON',                       t6.body);
    check('retry_after_secs presente',   typeof t6.body.retry_after_secs === 'number',             t6.body);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 7 — POST punch fuori raggio: 403 OUTSIDE_GEOFENCE (worker B)
  // Coordinate spostate di ~5° (~555km) → sicuramente fuori qualsiasi geofence
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\nTest 7 — POST /scan/punch fuori raggio (worker B, ~555km di distanza)');

  const cfB    = genTestCF();
  const t7_id  = await httpPost('/api/v1/scan/identify', {
    worksite_id: WSITE_ID,
    fiscal_code: cfB,
    full_name:   'Test Worker Beta',
    pin_code:    TEST_PIN || undefined
  });

  if (t7_id.status !== 200) {
    fail('worker B identify ok', t7_id);
  } else {
    const sessionTokenB = t7_id.body.session_token;
    const farLat = site.latitude + (site.latitude <= 85 ? 5 : -5);

    const t7 = await httpPost('/api/v1/scan/punch', {
      worksite_id:    WSITE_ID,
      session_token:  sessionTokenB,
      latitude:       farLat,
      longitude:      site.longitude,
      gps_accuracy_m: 12.3
    });

    check('status 403',                  t7.status === 403,                                        t7);
    check('error = OUTSIDE_GEOFENCE',    t7.body.error === 'OUTSIDE_GEOFENCE',                     t7.body);
    check('distance_m > 1000',           typeof t7.body.distance_m === 'number' && t7.body.distance_m > 1000, t7.body);
    check('max_allowed_m presente',      typeof t7.body.max_allowed_m === 'number',                t7.body);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 8+9 — Trigger DB append-only: UPDATE e DELETE su presence_logs devono fallire
  // Anche con service_role key (che bypassa RLS ma non i trigger PostgreSQL)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\nTest 8+9 — Trigger append-only presence_logs (service_role bypassa RLS, non i trigger)');

  const { data: logRow } = await supabase
    .from('presence_logs')
    .select('id, event_type')
    .order('timestamp_server', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!logRow) {
    fail('presenza di almeno un log (prerequisito test 8+9)');
    console.error('    Suggerimento: completare il test 5 prima.');
  } else {
    ok(`log trovato: ${logRow.id} (event: ${logRow.event_type})`);

    // Tenta UPDATE
    const { error: updErr } = await supabase
      .from('presence_logs')
      .update({ event_type: logRow.event_type === 'ENTRY' ? 'EXIT' : 'ENTRY' })
      .eq('id', logRow.id);

    check('UPDATE bloccato dal trigger',         !!updErr,                                              updErr?.message);
    check('messaggio trigger: "append-only"',    updErr?.message?.toLowerCase().includes('append-only'), updErr?.message);

    // Tenta DELETE
    const { error: delErr } = await supabase
      .from('presence_logs')
      .delete()
      .eq('id', logRow.id);

    check('DELETE bloccato dal trigger',         !!delErr,                                              delErr?.message);
    check('messaggio trigger: "append-only"',    delErr?.message?.toLowerCase().includes('append-only'), delErr?.message);

    // Verifica che il record esista ancora
    const { data: stillThere } = await supabase
      .from('presence_logs')
      .select('id')
      .eq('id', logRow.id)
      .maybeSingle();

    check('record intatto dopo DELETE fallito',  stillThere?.id === logRow.id,                          stillThere);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 10 — POST /scan/logout-device: revoca sessione worker C
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\nTest 10 — POST /scan/logout-device (revoca sessione worker C)');

  if (!sessionTokenC) {
    fail('prerequisito: sessionTokenC da test 5');
  } else {
    // 10a. Logout con token valido → 200
    const t10 = await httpPost('/api/v1/scan/logout-device', { session_token: sessionTokenC });
    check('status 200',   t10.status === 200,   t10);
    check('ok: true',     t10.body.ok === true,  t10.body);

    // 10b. Secondo logout con lo stesso token (già revocato) → 401
    const t10b = await httpPost('/api/v1/scan/logout-device', { session_token: sessionTokenC });
    check('secondo logout → 401',               t10b.status === 401,                          t10b);
    check('error SESSION_ALREADY_EXPIRED|NOT_FOUND',
      ['SESSION_ALREADY_EXPIRED', 'SESSION_NOT_FOUND'].includes(t10b.body.error),             t10b.body);

    // 10c. Token inesistente → 401
    const fakeToken = crypto.randomBytes(32).toString('hex');
    const t10c = await httpPost('/api/v1/scan/logout-device', { session_token: fakeToken });
    check('token inesistente → 401',            t10c.status === 401,                          t10c);
    check('error SESSION_NOT_FOUND',            t10c.body.error === 'SESSION_NOT_FOUND',      t10c.body);

    // 10d. Token malformato → 400
    const t10d = await httpPost('/api/v1/scan/logout-device', { session_token: 'bad' });
    check('token malformato → 400',             t10d.status === 400,                          t10d);
  }

  // ── Riepilogo ─────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` Risultato: ${passed}/${total} check passati  [mode: ${modeLabel}]`);
  console.log(`${'═'.repeat(60)}`);

  if (failed > 0) {
    console.error(`\n\x1b[31m[FAIL] ${failed} check falliti. NON fare il deploy.\x1b[0m\n`);
    process.exit(1);
  } else {
    console.log(`\n\x1b[32m[OK] Tutti i check passati. Pronto per deploy.\x1b[0m\n`);
  }
}

run().catch(e => {
  console.error('\n[FATAL]', e.message);
  process.exit(1);
});
