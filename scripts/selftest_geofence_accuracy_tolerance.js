#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_geofence_accuracy_tolerance.js
 *
 * Regressione per F-170 (AUDIT.md) — il controllo geofence confrontava
 * distanceM col solo raggio del cantiere, ignorando del tutto l'accuracy
 * della lettura GPS. Su iPhone (accuracy tipica 100-150m senza "posizione
 * precisa" attiva) un lavoratore fisicamente dentro il cantiere veniva
 * rifiutato come "troppo lontano" — segnalato più volte dal titolare come
 * "non va assolutamente bene".
 *
 * Fix: tolleranza = min(accuracyM, cap), cap DIVERSO per metodo di
 * timbratura (deciso esplicitamente dal titolare, 2026-09-11): badge
 * personale 200m (GEOFENCE_ACCURACY_TOLERANCE_CAP_M — nessuna prova di
 * presenza oltre al GPS), QR-cantiere 300m (GEOFENCE_ACCURACY_TOLERANCE_CAP_QR_M
 * — secondo fattore: possesso del codice affisso al cantiere).
 *
 * Copre esattamente gli scenari elencati nel piano condiviso in AUDIT.md:
 *  1. POST /badge/:code/punch, cap 200m: distanza appena sopra il raggio ma
 *     accuracy che la coprirebbe (radius=100, distance≈250, accuracy=180)
 *     → PASSA dopo il fix (prima: 403).
 *  2. POST /badge/:code/punch: accuracy alta ma distanza oltre il cap di
 *     200m (radius=100, distance≈350, accuracy=500) → 403 sia prima sia
 *     dopo — il cap più stretto deve tenere.
 *  3. POST /scan/punch, cap 300m: stesso identico scenario del punto 2
 *     (radius=100, distance≈350, accuracy=500) → PASSA dopo il fix — prova
 *     diretta che i due cap sono davvero diversi, non lo stesso valore
 *     duplicato per errore.
 *  4. POST /scan/punch: distanza anche oltre il cap di 300m (radius=100,
 *     distance≈500, accuracy=500) → 403 sia prima sia dopo.
 *  5. distanza già dentro il raggio, qualunque accuracy, su entrambi → 200
 *     invariato (baseline).
 *  6. GET /badge/:code/punch-context con lo stesso scenario borderline del
 *     punto 1 → in_geofence:true solo dopo il fix, coerente col POST.
 *  7. Un rifiuto OUTSIDE_GEOFENCE su /scan/punch scrive ora in
 *     admin_audit_log (gap trovato nello sweep: prima non lo faceva mai, a
 *     differenza di /badge/:code/punch che ce l'ha da F-138).
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { PRIVACY_CONSENT_VERSION } = require('../lib/workerPrivacyConsent');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SITE = { lat: 45.0, lon: 9.0 };
const RADIUS_M = 100;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function metersToLatOffset(m) { return m / 111_320; }
function newBadgeCode() { return crypto.randomBytes(9).toString('hex').toUpperCase(); }
function newSessionToken() { return crypto.randomBytes(32).toString('hex'); } // 64 hex char, richiesto da scan.js
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function badgePunch(code, body) {
  const res = await fetch(`${BASE}/api/v1/badge/${code}/punch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function scanPunch(body) {
  const res = await fetch(`${BASE}/api/v1/scan/punch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function punchContext(code, params) {
  const res = await fetch(`${BASE}/api/v1/badge/${code}/punch-context?${new URLSearchParams(params)}`);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  console.log(`\nGeofence + tolleranza accuracy GPS — F-170 regression — ${BASE}`);

  const { data: company, error: cErr } = await supabase.from('companies')
    .insert([{ name: 'TEST-F170-GeofenceTolerance' }]).select('id').single();
  if (cErr) throw new Error('crea company: ' + cErr.message);
  const companyId = company.id;

  const { data: site, error: sErr } = await supabase.from('sites').insert([{
    company_id: companyId, name: 'TEST-Cantiere-F170', address: 'Via Test 1', status: 'attivo',
    latitude: SITE.lat, longitude: SITE.lon, geofence_radius_m: RADIUS_M,
  }]).select('id').single();
  if (sErr) throw new Error('crea site: ' + sErr.message);
  const siteId = site.id;

  let workerSeq = 0;
  async function makeWorker(label) {
    const badge = newBadgeCode();
    // fiscal_code UNIQUE per company — un prefisso comune troncato a 16 char
    // può collidere tra due label lunghe che condividono lo stesso inizio
    // (es. "BadgeBorderlineOk" e "BadgeBorderlineReject"): uso un contatore
    // invece del nome per garantire unicità indipendentemente dalle label.
    const fiscalCode = `TSTF170W${(workerSeq++).toString().padStart(3, '0')}${Date.now()}`.slice(0, 16).toUpperCase();
    const { data: w, error } = await supabase.from('workers').insert([{
      company_id: companyId, full_name: `TEST-F170-${label}`, fiscal_code: fiscalCode,
      qualification: 'Muratore', is_active: true, badge_code: badge,
      privacy_consent_accepted_at: new Date().toISOString(), privacy_consent_version: PRIVACY_CONSENT_VERSION,
    }]).select('id').single();
    if (error) throw new Error(`crea worker ${label}: ${error.message}`);
    return { id: w.id, badge };
  }

  async function makeSession(workerId) {
    const token = newSessionToken();
    const { error } = await supabase.from('worker_device_sessions').insert([{
      company_id: companyId, worker_id: workerId, token_hash: hashToken(token),
    }]);
    if (error) throw new Error('crea sessione device: ' + error.message);
    return token;
  }

  const workers = {};
  const sessions = {};
  const workerIds = [];
  try {
    for (const label of ['BadgeOk', 'BadgeBorderlineOk', 'BadgeBorderlineReject', 'ScanNear', 'ScanBorderlineOk', 'ScanBorderlineReject']) {
      workers[label] = await makeWorker(label);
      workerIds.push(workers[label].id);
    }
    sessions.ScanNear              = await makeSession(workers.ScanNear.id);
    sessions.ScanBorderlineOk      = await makeSession(workers.ScanBorderlineOk.id);
    sessions.ScanBorderlineReject  = await makeSession(workers.ScanBorderlineReject.id);

    // /scan/punch, a differenza di /badge/:code/punch, non auto-crea
    // l'associazione worker↔cantiere — richiede una riga worksite_workers
    // già attiva, altrimenti 403 WORKER_NOT_AUTHORIZED_ON_SITE prima ancora
    // di arrivare al controllo geofence.
    const { error: assocErr } = await supabase.from('worksite_workers').insert([
      { company_id: companyId, site_id: siteId, worker_id: workers.ScanNear.id,             status: 'active' },
      { company_id: companyId, site_id: siteId, worker_id: workers.ScanBorderlineOk.id,     status: 'active' },
      { company_id: companyId, site_id: siteId, worker_id: workers.ScanBorderlineReject.id, status: 'active' },
    ]);
    if (assocErr) throw new Error('crea worksite_workers per QR: ' + assocErr.message);

    // ── 5. Baseline: dentro il raggio, invariato (badge) ──────────────────────
    const rNear = await badgePunch(workers.BadgeOk.badge, {
      site_id: siteId, latitude: SITE.lat + metersToLatOffset(50), longitude: SITE.lon, gps_accuracy_m: 15,
    });
    check('badge: dentro il raggio (50m/100m) → 200 invariato (baseline)', rNear.status === 200, rNear);

    // ── 1. Badge, borderline coperto dalla tolleranza (200m cap) ──────────────
    const rBorderOk = await badgePunch(workers.BadgeBorderlineOk.badge, {
      site_id: siteId, latitude: SITE.lat + metersToLatOffset(250), longitude: SITE.lon, gps_accuracy_m: 180,
    });
    check('F-170 badge: distance≈250m/radius100m con accuracy=180m (tolleranza 180) → 200, PRIMA era 403',
      rBorderOk.status === 200, rBorderOk);

    // ── 2. Badge, oltre il cap di 200m anche con accuracy alta → resta 403 ────
    const rBorderReject = await badgePunch(workers.BadgeBorderlineReject.badge, {
      site_id: siteId, latitude: SITE.lat + metersToLatOffset(350), longitude: SITE.lon, gps_accuracy_m: 500,
    });
    check('badge: distance≈350m/radius100m con accuracy=500m (cap tiene a 200m) → 403 invariato',
      rBorderReject.status === 403 && rBorderReject.data.error === 'OUTSIDE_GEOFENCE', rBorderReject);
    check('la risposta di rifiuto espone tolerance_m=200 (cap badge)', rBorderReject.data.tolerance_m === 200, rBorderReject.data);

    await new Promise(r => setTimeout(r, 800)); // audit log fire-and-forget
    const { data: auditBadge } = await supabase.from('admin_audit_log')
      .select('payload').eq('company_id', companyId).eq('action', 'punch.rejected_geofence').eq('target_id', workers.BadgeBorderlineReject.id);
    check('F-170: admin_audit_log include gps_accuracy_m e tolerance_m sul rifiuto badge',
      auditBadge?.[0]?.payload?.gps_accuracy_m === 500 && auditBadge?.[0]?.payload?.tolerance_m === 200, auditBadge);

    // ── 6. punch-context con lo stesso scenario borderline → in_geofence:true ──
    const ctx = await punchContext(workers.BadgeBorderlineOk.badge, {
      lat: SITE.lat + metersToLatOffset(250), lon: SITE.lon, accuracy: 180,
    });
    const ctxSite = ctx.data.sites?.find(s => s.site_id === siteId);
    check('F-170: GET punch-context stesso scenario → in_geofence:true (coerente col POST)',
      ctx.status === 200 && ctxSite?.in_geofence === true, ctxSite);

    // ── 3. QR, stesso identico scenario del punto 2 ma PASSA (cap 300m) ───────
    const rQrOk = await scanPunch({
      worksite_id: siteId, session_token: sessions.ScanBorderlineOk,
      latitude: SITE.lat + metersToLatOffset(350), longitude: SITE.lon, gps_accuracy_m: 500,
    });
    check('F-170 PROVA CAP DIVERSI: stesso scenario (distance≈350m, accuracy=500m) su QR (cap 300m) → 200, su badge (cap 200m) era 403',
      rQrOk.status === 200, rQrOk);

    // ── 4. QR, oltre anche il cap di 300m → 403 ────────────────────────────────
    const rQrReject = await scanPunch({
      worksite_id: siteId, session_token: sessions.ScanBorderlineReject,
      latitude: SITE.lat + metersToLatOffset(500), longitude: SITE.lon, gps_accuracy_m: 500,
    });
    check('QR: distance≈500m/radius100m con accuracy=500m (cap 300m tiene) → 403 invariato',
      rQrReject.status === 403 && rQrReject.data.error === 'OUTSIDE_GEOFENCE', rQrReject);
    check('la risposta di rifiuto QR espone tolerance_m=300 (cap QR)', rQrReject.data.tolerance_m === 300, rQrReject.data);

    // ── 5. Baseline QR: dentro il raggio, invariato ───────────────────────────
    const rQrNear = await scanPunch({
      worksite_id: siteId, session_token: sessions.ScanNear,
      latitude: SITE.lat + metersToLatOffset(50), longitude: SITE.lon, gps_accuracy_m: 15,
    });
    check('QR: dentro il raggio (50m/100m) → 200 invariato (baseline)', rQrNear.status === 200, rQrNear);

    // ── 7. Gap dello sweep: /scan/punch ora scrive admin_audit_log sul rifiuto ─
    await new Promise(r => setTimeout(r, 800));
    const { data: auditQr } = await supabase.from('admin_audit_log')
      .select('payload').eq('company_id', companyId).eq('action', 'punch.rejected_geofence').eq('target_id', workers.ScanBorderlineReject.id);
    check('F-170: /scan/punch ora scrive admin_audit_log sul rifiuto geofence (gap trovato nello sweep, prima assente)',
      auditQr?.[0]?.payload?.tolerance_m === 300, auditQr);

  } finally {
    await supabase.from('worker_device_sessions').delete().eq('company_id', companyId);
    await supabase.from('worksite_workers').delete().eq('company_id', companyId);
    await supabase.from('workers').delete().eq('company_id', companyId).then(({ error }) => {
      if (error) console.log(`  (nota: worker non eliminati, referenziati da presence_logs append-only: ${error.message})`);
    });
    await supabase.from('sites').delete().eq('company_id', companyId);
    await supabase.from('companies').delete().eq('id', companyId).then(({ error }) => {
      if (error) console.log(`  (nota: company non eliminata, referenziata da righe append-only: ${error.message})`);
    });
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE FATALE:', e.message, e.stack); process.exitCode = 1; });
