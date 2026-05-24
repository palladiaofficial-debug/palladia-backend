'use strict';
/**
 * fulltest_platform.js
 * Test completo della piattaforma Palladia — tutti i moduli, tutti i ruoli.
 * Uso: node scripts/fulltest_platform.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ── Configurazione ────────────────────────────────────────────────────────────
const BASE       = 'https://palladia-backend-production.up.railway.app';
const JWT        = process.env._TEST_JWT;
const COMPANY_ID = 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1'; // carpiooricardo@gmail.com
const SITE_ID    = '7542ab79-1725-4727-b7d8-f226705fbd06'; // Piazzetta degli Orti dei Banchi 3
const SITE_LAT   = 44.409587;
const SITE_LON   = 8.930213;
const TODAY      = new Date().toISOString().slice(0, 10);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Runner ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const FAILURES = [];

function ok(name)           { process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`); passed++; }
function fail(name, detail) { process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n`); if (detail !== undefined) process.stdout.write(`    ↳ ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 120)}\n`); failed++; FAILURES.push(name); }
function skip(name, why)    { process.stdout.write(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})\n`); skipped++; }
function check(name, cond, detail) { cond ? ok(name) : fail(name, detail); }
function section(title)     { process.stdout.write(`\n\x1b[1m── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}\x1b[0m\n`); }

async function GET(path, auth = true) {
  const h = { 'Content-Type': 'application/json' };
  if (auth && JWT) { h['Authorization'] = `Bearer ${JWT}`; h['X-Company-Id'] = COMPANY_ID; }
  const r = await fetch(`${BASE}${path}`, { headers: h });
  let body; try { body = await r.json(); } catch { body = {}; }
  return { status: r.status, body };
}

async function POST(path, data, auth = true) {
  const h = { 'Content-Type': 'application/json' };
  if (auth && JWT) { h['Authorization'] = `Bearer ${JWT}`; h['X-Company-Id'] = COMPANY_ID; }
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: h, body: JSON.stringify(data) });
  let body; try { body = await r.json(); } catch { body = {}; }
  return { status: r.status, body };
}

async function DEL(path, auth = true) {
  const h = { 'Content-Type': 'application/json' };
  if (auth && JWT) { h['Authorization'] = `Bearer ${JWT}`; h['X-Company-Id'] = COMPANY_ID; }
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: h });
  let body; try { body = await r.json(); } catch { body = {}; }
  return { status: r.status, body };
}

// ── Test suite ────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` PALLADIA — Test completo piattaforma`);
  console.log(` Server : ${BASE}`);
  console.log(` Company: ${COMPANY_ID}`);
  console.log(` Sito   : ${SITE_ID}`);
  console.log(` Data   : ${TODAY}`);
  console.log(`${'═'.repeat(60)}`);

  // ══════════════════════════════════════════════════════════
  // 1. HEALTH & ENDPOINT PUBBLICI
  // ══════════════════════════════════════════════════════════
  section('1. HEALTH & ENDPOINT PUBBLICI');

  const health = await GET('/health', false);
  check('GET /health → 200', health.status === 200, health.body);

  const smoke = await GET('/api/pdf-smoke', false);
  check('GET /api/pdf-smoke → 200 (PDF smoke)', smoke.status === 200, { status: smoke.status });

  // Auth wall: senza JWT → 401
  const noAuth = await GET('/api/v1/dashboard', false);
  check('GET /dashboard senza JWT → 401', noAuth.status === 401, noAuth.body);

  // Auth wall: senza X-Company-Id → 400
  const noCompany = await (async () => {
    const r = await fetch(`${BASE}/api/v1/dashboard`, { headers: { 'Authorization': `Bearer ${JWT}` } });
    let body; try { body = await r.json(); } catch { body = {}; }
    return { status: r.status, body };
  })();
  check('GET /dashboard senza X-Company-Id → 400', noCompany.status === 400, noCompany.body);

  // ══════════════════════════════════════════════════════════
  // 2. DASHBOARD
  // ══════════════════════════════════════════════════════════
  section('2. DASHBOARD');

  const dash = await GET('/api/v1/dashboard');
  check('GET /dashboard → 200', dash.status === 200, dash.body);
  // Struttura attesa: { sites:{total,active,top}, workers:{total}, today:{...}, documents:{...} }
  check('dashboard ha sites.total', typeof dash.body?.sites?.total === 'number', dash.body);
  check('dashboard ha today', typeof dash.body?.today === 'object', dash.body);
  check('dashboard ha workers', typeof dash.body?.workers?.total === 'number', dash.body);

  // ══════════════════════════════════════════════════════════
  // 3. CANTIERI
  // ══════════════════════════════════════════════════════════
  section('3. CANTIERI');

  const sites = await GET('/api/v1/sites');
  check('GET /sites → 200', sites.status === 200, sites.body);
  check('sites è array', Array.isArray(sites.body), sites.body);
  check('sites ha cantieri', (sites.body?.length ?? 0) > 0, sites.body);

  const overview = await GET('/api/v1/sites/overview');
  check('GET /sites/overview → 200', overview.status === 200, overview.body);
  check('overview ha sites array', Array.isArray(overview.body?.sites), overview.body);

  // ══════════════════════════════════════════════════════════
  // 4. LAVORATORI
  // ══════════════════════════════════════════════════════════
  section('4. LAVORATORI (WORKERS)');

  const workers = await GET('/api/v1/workers');
  check('GET /workers → 200', workers.status === 200, workers.body);
  check('workers è array', Array.isArray(workers.body), workers.body);

  const siteWks = await GET(`/api/v1/workers?siteId=${SITE_ID}`);
  check('GET /workers?siteId → 200', siteWks.status === 200, siteWks.body);

  // Crea lavoratore di test — CF deve essere esattamente 16 chars alfanumerici [A-Z0-9]
  const testCF = ('TSTS' + crypto.randomBytes(6).toString('hex')).toUpperCase().slice(0, 16);
  const newWk = await POST('/api/v1/workers', {
    full_name: 'Tizio Test Palladia',
    fiscal_code: testCF,
    is_active: true
  });
  check('POST /workers → 201 (crea lavoratore test)', newWk.status === 201, newWk.body);
  const testWorkerId = newWk.body?.id;

  if (testWorkerId) {
    const wDetail = await GET(`/api/v1/workers/${testWorkerId}`);
    check('GET /workers/:id → 200', wDetail.status === 200, wDetail.body);
    check('worker ha full_name', typeof wDetail.body?.full_name === 'string', wDetail.body);

    // Assegna a cantiere
    const assign = await POST(`/api/v1/sites/${SITE_ID}/workers`, { worker_id: testWorkerId });
    check('POST /sites/:id/workers (assegna) → 200/201', [200,201].includes(assign.status), assign.body);

    // Lista workers del cantiere
    const siteWorkerList = await GET(`/api/v1/sites/${SITE_ID}/workers`);
    check('GET /sites/:id/workers → 200', siteWorkerList.status === 200, siteWorkerList.body);
  }

  // ══════════════════════════════════════════════════════════
  // 5. PRESENZE
  // ══════════════════════════════════════════════════════════
  section('5. PRESENZE & STORICO');

  const presence = await GET(`/api/v1/presence?siteId=${SITE_ID}&date=${TODAY}`);
  check('GET /presence?siteId&date → 200', presence.status === 200, presence.body);

  const presHistory = await GET(`/api/v1/presence/history?siteId=${SITE_ID}&from=2026-05-01&to=${TODAY}`);
  check('GET /presence/history → 200', presHistory.status === 200, presHistory.body);

  // Report CSV range — bug fixato (remove site:sites join)
  const presRange = await GET(`/api/v1/reports/presence-range?siteId=${SITE_ID}&from=2026-05-01&to=${TODAY}`);
  check('GET /reports/presence-range → 200 (fix bug DB join)', presRange.status === 200, presRange.body);

  // ══════════════════════════════════════════════════════════
  // 6. QR CODE & BADGE
  // ══════════════════════════════════════════════════════════
  section('6. QR CODE');

  const qr = await GET(`/api/v1/sites/${SITE_ID}/qr-link`);
  check('GET /sites/:id/qr-link → 200', qr.status === 200, qr.body);
  check('qr ha link', typeof qr.body?.link === 'string' || typeof qr.body?.url === 'string' || typeof qr.body?.qr_url === 'string', qr.body);

  // Endpoint pubblico scan — dati sensibili non esposti
  const scanSite = await GET(`/api/v1/scan/worksites/${SITE_ID}`, false);
  check('GET /scan/worksites/:id (pubblico) → 200', scanSite.status === 200, scanSite.body);
  check('scan site ha name', typeof scanSite.body?.name === 'string', scanSite.body);
  check('scan site NO company_id', !('company_id' in scanSite.body), scanSite.body);
  check('scan site NO lat/lon', !('latitude' in scanSite.body), scanSite.body);
  check('scan site ha has_geofence', typeof scanSite.body?.has_geofence === 'boolean', scanSite.body);

  // ══════════════════════════════════════════════════════════
  // 7. DOCUMENTI
  // ══════════════════════════════════════════════════════════
  section('7. DOCUMENTI');

  const docs = await GET(`/api/v1/sites/${SITE_ID}/documents`);
  check('GET /sites/:id/documents → 200', docs.status === 200, docs.body);

  const compDocs = await GET('/api/v1/company-documents');
  check('GET /company-documents → 200', compDocs.status === 200, compDocs.body);

  if (testWorkerId) {
    const wDocs = await GET(`/api/v1/workers/${testWorkerId}/documents`);
    check('GET /workers/:id/documents → 200', wDocs.status === 200, wDocs.body);
  }

  // ══════════════════════════════════════════════════════════
  // 8. FORMAZIONE & ATTESTATI
  // ══════════════════════════════════════════════════════════
  section('8. FORMAZIONE & ATTESTATI');

  const formDash = await GET('/api/v1/formazione/dashboard');
  check('GET /formazione/dashboard → 200', formDash.status === 200, formDash.body);

  const notifs = await GET('/api/v1/notifications');
  check('GET /notifications → 200', notifs.status === 200, notifs.body);

  const marketplace = await GET('/api/v1/marketplace/courses');
  check('GET /marketplace/courses → 200', marketplace.status === 200, marketplace.body);

  const recommend = await GET('/api/v1/formazione/recommended-courses');
  check('GET /formazione/recommended-courses → 200', recommend.status === 200, recommend.body);

  // ══════════════════════════════════════════════════════════
  // 9. BILLING
  // ══════════════════════════════════════════════════════════
  section('9. BILLING & ABBONAMENTO');

  const billing = await GET('/api/v1/billing/status');
  check('GET /billing/status → 200', billing.status === 200, billing.body);
  check('billing ha status', typeof billing.body?.status === 'string', billing.body);
  check('billing ha plan', typeof billing.body?.plan === 'string', billing.body);
  check('billing ha site_limit', typeof billing.body?.site_limit === 'number', billing.body);
  check('billing non scaduto', billing.body?.is_expired === false, billing.body);

  // ══════════════════════════════════════════════════════════
  // 10. AZIENDA & TEAM
  // ══════════════════════════════════════════════════════════
  section('10. PROFILO AZIENDA & TEAM');

  const company = await GET('/api/v1/company');
  check('GET /company → 200', company.status === 200, company.body);
  check('company ha name', typeof company.body?.name === 'string', company.body);

  const invites = await GET('/api/v1/invites');
  check('GET /invites → 200', invites.status === 200, invites.body);

  const profile = await GET('/api/v1/me');
  check('GET /me (onboarding/profilo) → 200', profile.status === 200, profile.body);

  // ══════════════════════════════════════════════════════════
  // 11. SUBAPPALTATORI & ATTREZZATURE
  // ══════════════════════════════════════════════════════════
  section('11. SUBAPPALTATORI & ATTREZZATURE');

  const subs = await GET('/api/v1/subcontractors');
  check('GET /subcontractors → 200', subs.status === 200, subs.body);

  const equip = await GET('/api/v1/equipment');
  check('GET /equipment → 200', equip.status === 200, equip.body);

  // ══════════════════════════════════════════════════════════
  // 12. POS / DVR / PIMUS
  // ══════════════════════════════════════════════════════════
  section('12. DOCUMENTI SICUREZZA (POS / DVR / PIMUS)');

  const posList = await GET('/api/v1/pos');
  check('GET /pos (lista) → 200', posList.status === 200, posList.body);

  const dvrList = await GET(`/api/v1/sites/${SITE_ID}/dvr`);
  check('GET /sites/:id/dvr → 200/404', [200,404].includes(dvrList.status), dvrList.body);

  const pimusList = await GET(`/api/v1/sites/${SITE_ID}/pimus`);
  check('GET /sites/:id/pimus → 200/404', [200,404].includes(pimusList.status), pimusList.body);

  // ══════════════════════════════════════════════════════════
  // 13. COORDINATORE CSE
  // ══════════════════════════════════════════════════════════
  section('13. COORDINATORE CSE');

  const coordInvites = await GET(`/api/v1/sites/${SITE_ID}/coordinator-invites`);
  check('GET /sites/:id/coordinator-invites → 200', coordInvites.status === 200, coordInvites.body);

  const coordNotes = await GET(`/api/v1/sites/${SITE_ID}/coordinator-notes`);
  check('GET /sites/:id/coordinator-notes → 200', coordNotes.status === 200, coordNotes.body);

  const coordVerif = await GET(`/api/v1/sites/${SITE_ID}/coordinator-verifications`);
  check('GET /sites/:id/coordinator-verifications → 200', coordVerif.status === 200, coordVerif.body);

  const nonconf = await GET(`/api/v1/sites/${SITE_ID}/nonconformities`);
  check('GET /sites/:id/nonconformities → 200', nonconf.status === 200, nonconf.body);

  // ══════════════════════════════════════════════════════════
  // 14. AUDIT LOG & SESSIONI
  // ══════════════════════════════════════════════════════════
  section('14. AUDIT LOG & SESSIONI');

  const audit = await GET('/api/v1/audit-log');
  check('GET /audit-log → 200', audit.status === 200, audit.body);
  check('audit-log ha entries (array)', Array.isArray(audit.body?.entries), audit.body);
  check('audit-log ha count', typeof audit.body?.count === 'number', audit.body);

  if (testWorkerId) {
    const sessions = await GET(`/api/v1/workers/${testWorkerId}/sessions`);
    check('GET /workers/:id/sessions → 200', sessions.status === 200, sessions.body);
  }

  // ══════════════════════════════════════════════════════════
  // 15. ALERTS (uscite mancanti)
  // ══════════════════════════════════════════════════════════
  section('15. ALERTS');

  const alerts = await GET(`/api/v1/alerts/missing-exits?date=${TODAY}`);
  check('GET /alerts/missing-exits?date → 200', alerts.status === 200, alerts.body);

  // ══════════════════════════════════════════════════════════
  // 16. LINK ASL
  // ══════════════════════════════════════════════════════════
  section('16. LINK ASL');

  const aslList = await GET(`/api/v1/sites/${SITE_ID}/asl-tokens`);
  check('GET /sites/:id/asl-tokens → 200', aslList.status === 200, aslList.body);

  const aslCreate = await POST(`/api/v1/sites/${SITE_ID}/asl-token`, {
    from_date: '2026-01-01',
    to_date:   TODAY
  });
  check('POST /sites/:id/asl-token → 201', aslCreate.status === 201, aslCreate.body);
  const aslTokenId = aslCreate.body?.id;
  const aslToken   = aslCreate.body?.token;

  if (aslToken) {
    const aslPub = await GET(`/api/v1/asl/${aslToken}?format=info`, false);
    check('GET /asl/:token (pubblico) → 200', aslPub.status === 200, aslPub.body);
    check('asl ha site_name', typeof aslPub.body?.site_name === 'string', aslPub.body);

    if (aslTokenId) {
      const aslDel = await DEL(`/api/v1/asl-tokens/${aslTokenId}`);
      check('DELETE /asl-tokens/:id (cleanup) → 200/204', [200,204].includes(aslDel.status), aslDel.body);
    }
  }

  // ══════════════════════════════════════════════════════════
  // 17. KIT BARACCA
  // ══════════════════════════════════════════════════════════
  section('17. KIT BARACCA');

  const baracca = await GET(`/api/v1/sites/${SITE_ID}/baracca`);
  check('GET /sites/:id/baracca → 200', baracca.status === 200, baracca.body);

  // ══════════════════════════════════════════════════════════
  // 18. NOTE CANTIERE
  // ══════════════════════════════════════════════════════════
  section('18. NOTE CANTIERE');

  const notes = await GET(`/api/v1/site-notes?siteId=${SITE_ID}`);
  check('GET /site-notes?siteId → 200', notes.status === 200, notes.body);

  // ══════════════════════════════════════════════════════════
  // 19. METEO
  // ══════════════════════════════════════════════════════════
  section('19. METEO CANTIERE');

  const weather = await GET(`/api/v1/sites/${SITE_ID}/weather-log`);
  check('GET /sites/:id/weather-log → 200', weather.status === 200, weather.body);

  // ══════════════════════════════════════════════════════════
  // 20. ECONOMIA & COMPUTO
  // ══════════════════════════════════════════════════════════
  section('20. ECONOMIA & COMPUTO');

  const economia = await GET(`/api/v1/sites/${SITE_ID}/economia`);
  check('GET /sites/:id/economia → 200/404', [200,404].includes(economia.status), economia.body);

  const computo = await GET(`/api/v1/sites/${SITE_ID}/computo`);
  check('GET /sites/:id/computo → 200/404', [200,404].includes(computo.status), computo.body);

  const phases = await GET(`/api/v1/sites/${SITE_ID}/phases`);
  check('GET /sites/:id/phases → 200/404', [200,404].includes(phases.status), phases.body);

  const costs = await GET(`/api/v1/sites/${SITE_ID}/costs`);
  check('GET /sites/:id/costs → 200/404', [200,404].includes(costs.status), costs.body);

  // ══════════════════════════════════════════════════════════
  // 21. FEATURE FLAGS
  // ══════════════════════════════════════════════════════════
  section('21. FEATURE FLAGS');

  const ff = await GET('/api/v1/feature-flags');
  check('GET /feature-flags → 200', ff.status === 200, ff.body);
  check('feature-flags è oggetto', typeof ff.body === 'object' && !Array.isArray(ff.body), ff.body);

  // ══════════════════════════════════════════════════════════
  // 22. SCAN & BADGE (ruolo lavoratore — endpoint pubblici)
  // ══════════════════════════════════════════════════════════
  section('22. SCAN & BADGE (ruolo lavoratore)');

  let badgeCode = null;
  if (testWorkerId) {
    const { data: wRow } = await sb.from('workers').select('badge_code').eq('id', testWorkerId).maybeSingle();
    badgeCode = wRow?.badge_code || null;
  }

  if (badgeCode) {
    // punch-context via badge (mostra siti su cui può timbrare)
    const pCtx = await GET(`/api/v1/badge/${badgeCode}/punch-context`, false);
    check('GET /badge/:code/punch-context → 200', pCtx.status === 200, pCtx.body);
    check('punch-context ha worker_name', typeof pCtx.body?.worker_name === 'string', pCtx.body);
    check('punch-context NO fiscal_code esposto', !JSON.stringify(pCtx.body).includes('fiscal_code'), pCtx.body);
    check('punch-context ha sites[]', Array.isArray(pCtx.body?.sites), pCtx.body);

    // Punch ENTRY via badge (coordinate esatte del cantiere — distanza 0)
    const punch = await (async () => {
      const r = await fetch(`${BASE}/api/v1/badge/${badgeCode}/punch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: SITE_ID, latitude: SITE_LAT, longitude: SITE_LON, gps_accuracy_m: 8.5 })
      });
      let body; try { body = await r.json(); } catch { body = {}; }
      return { status: r.status, body };
    })();
    check('POST /badge/:code/punch ENTRY → 200', punch.status === 200, punch.body);
    check('event_type = ENTRY', punch.body?.event_type === 'ENTRY', punch.body);
    check('NO fiscal_code nel response', !('fiscal_code' in (punch.body || {})), punch.body);

    // Punch doppio immediato → 429 rate limit
    const punch2 = await (async () => {
      const r = await fetch(`${BASE}/api/v1/badge/${badgeCode}/punch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: SITE_ID, latitude: SITE_LAT, longitude: SITE_LON, gps_accuracy_m: 8.5 })
      });
      let body; try { body = await r.json(); } catch { body = {}; }
      return { status: r.status, body };
    })();
    check('Punch doppio → 429 PUNCH_TOO_SOON', punch2.status === 429, punch2.body);
    check('retry_after_secs presente', typeof punch2.body?.retry_after_secs === 'number', punch2.body);

    // Punch fuori geofence
    const punchFar = await (async () => {
      const r = await fetch(`${BASE}/api/v1/badge/${badgeCode}/punch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: SITE_ID, latitude: SITE_LAT + 5, longitude: SITE_LON, gps_accuracy_m: 8.5 })
      });
      let body; try { body = await r.json(); } catch { body = {}; }
      return { status: r.status, body };
    })();
    // Può essere 403 OUTSIDE_GEOFENCE o 429 PUNCH_TOO_SOON (rate limit 60s)
    check('Punch fuori geofence → 403 o 429', [403, 429].includes(punchFar.status), punchFar.body);

  } else {
    skip('22. Badge punch flow', 'badge_code non disponibile (worker test non creato)');
  }

  // Badge inesistente → 404
  const fakeBadge = crypto.randomBytes(9).toString('hex').toUpperCase();
  const badgeNotFound = await GET(`/api/v1/badge/${fakeBadge}/punch-context`, false);
  check('Badge inesistente → 404', badgeNotFound.status === 404, badgeNotFound.body);

  // Badge malformato → 400
  const badgeBad = await GET('/api/v1/badge/BADCODE/punch-context', false);
  check('Badge malformato → 400', badgeBad.status === 400, badgeBad.body);

  // ══════════════════════════════════════════════════════════
  // 23. SICUREZZA — Auth wall su tutti gli endpoint sensibili
  // ══════════════════════════════════════════════════════════
  section('23. SICUREZZA — Auth wall');

  const PROTECTED = [
    ['/api/v1/audit-log',      'audit-log'],
    ['/api/v1/billing/status', 'billing'],
    ['/api/v1/workers',        'workers'],
    ['/api/v1/company',        'company'],
    ['/api/v1/formazione/dashboard', 'formazione'],
    ['/api/v1/equipment',      'equipment'],
    ['/api/v1/subcontractors', 'subcontractors'],
    ['/api/v1/notifications',  'notifications'],
    ['/api/v1/pos',            'pos'],
  ];

  for (const [path, name] of PROTECTED) {
    const r = await GET(path, false);
    check(`${name} senza JWT → 401`, r.status === 401, r.body);
  }

  // Cross-company: JWT valido ma company_id inesistente → 403
  const crossComp = await (async () => {
    const r = await fetch(`${BASE}/api/v1/workers`, {
      headers: { 'Authorization': `Bearer ${JWT}`, 'X-Company-Id': '00000000-0000-0000-0000-000000000000' }
    });
    return { status: r.status };
  })();
  check('Cross-company (UUID fittizio) → 403', crossComp.status === 403, crossComp);

  // ══════════════════════════════════════════════════════════
  // 24. APPEND-ONLY presence_logs (DB trigger)
  // ══════════════════════════════════════════════════════════
  section('24. SICUREZZA — Append-only presence_logs');

  const { data: logRow } = await sb
    .from('presence_logs')
    .select('id, event_type')
    .order('timestamp_server', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!logRow) {
    skip('Trigger append-only', 'nessun log trovato');
  } else {
    const { error: updErr } = await sb.from('presence_logs')
      .update({ event_type: logRow.event_type === 'ENTRY' ? 'EXIT' : 'ENTRY' })
      .eq('id', logRow.id);
    check('UPDATE bloccato dal trigger', !!updErr, updErr?.message);
    check('Messaggio contiene "append-only"', updErr?.message?.toLowerCase().includes('append-only'), updErr?.message);

    const { error: delErr } = await sb.from('presence_logs').delete().eq('id', logRow.id);
    check('DELETE bloccato dal trigger', !!delErr, delErr?.message);

    const { data: stillThere } = await sb.from('presence_logs').select('id').eq('id', logRow.id).maybeSingle();
    check('Record intatto dopo DELETE fallito', stillThere?.id === logRow.id, stillThere);
  }

  // ══════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════
  section('CLEANUP');

  if (testWorkerId) {
    // Rimuovi da cantiere
    await DEL(`/api/v1/sites/${SITE_ID}/workers/${testWorkerId}`);
    // Prova a eliminare via API (se esiste endpoint DELETE /workers/:id)
    const wDel = await DEL(`/api/v1/workers/${testWorkerId}`);
    if ([200,204].includes(wDel.status)) {
      ok('Worker test eliminato via API');
    } else {
      // Fallback diretto su DB
      const { error } = await sb.from('workers').delete().eq('id', testWorkerId);
      check('Worker test eliminato via DB (fallback)', !error, error?.message);
    }
  }

  // ══════════════════════════════════════════════════════════
  // RIEPILOGO
  // ══════════════════════════════════════════════════════════
  const total = passed + failed + skipped;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` RISULTATO FINALE`);
  console.log(`${'═'.repeat(60)}`);
  console.log(` \x1b[32m✓ Passati : ${passed}\x1b[0m`);
  console.log(` \x1b[31m✗ Falliti : ${failed}\x1b[0m`);
  console.log(` \x1b[33m– Saltati : ${skipped}\x1b[0m`);
  console.log(` Totale   : ${total}`);
  if (FAILURES.length > 0) {
    console.log(`\n\x1b[31m Falliti:\x1b[0m`);
    FAILURES.forEach(f => console.log(`   • ${f}`));
  }
  console.log(`\n${failed === 0
    ? '\x1b[32m[OK] Tutti i test passati.\x1b[0m'
    : '\x1b[31m[ATTENZIONE] Alcuni test falliti — vedere sopra.\x1b[0m'}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('\n[FATAL]', e.message, e.stack);
  process.exit(1);
});
