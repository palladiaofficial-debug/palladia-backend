#!/usr/bin/env node
/**
 * scripts/selftest_badge_geofence_and_compliance_visibility.js
 *
 * Test di regressione per F-138 e F-139 (AUDIT.md) — trovati durante una
 * verifica dal vivo del flusso badge/QR (5 scenari richiesti dall'utente
 * prima di un test reale con gli operai, 2026-09-06):
 *
 *  F-138: un tentativo di timbratura fuori dal geofence viene rifiutato
 *    (403 OUTSIDE_GEOFENCE) ma prima del fix non lasciava NESSUNA traccia
 *    — né in presence_logs (corretto, non deve scriverci) né in nessun
 *    log di audit. Invisibile all'amministratore.
 *
 *  F-139: un lavoratore con formazione sicurezza/idoneità sanitaria
 *    scaduta poteva timbrare esattamente come uno in regola — nessun
 *    blocco, nessun avviso, nessuna traccia. Policy scelta dall'utente:
 *    permettere la timbratura ma avvisare sia l'operaio (risposta API,
 *    poi banner in AreaTimbra.tsx) sia l'amministratore (audit log).
 *
 * Chiamate DAL VIVO contro l'API reale (routes/v1/badgePunch.js), stesso
 * endpoint usato da AreaTimbra.tsx. Fixture dedicate, isolate.
 *
 * Nota: presence_logs e admin_audit_log sono append-only (trigger DB) —
 * la company/site/worker di test vengono ripulite a fine test, le righe
 * scritte in quelle due tabelle restano (stesso pattern accettato altrove
 * in questa suite, vedi feedback_npm_test_accumulates_prod_fixtures).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SITE = { lat: 41.9028, lon: 12.4964 };
const RADIUS_M = 100;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

function metersToLatOffset(m) { return m / 111_320; }
function newBadgeCode() { return crypto.randomBytes(9).toString('hex').toUpperCase(); }

async function punch(code, body) {
  const res = await fetch(`${BASE}/api/v1/badge/${code}/punch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log(`\nBadge punch — F-138/F-139 regression — ${BASE}`);

  const { data: company, error: cErr } = await supabase.from('companies')
    .insert([{ name: 'TEST-F138F139-BadgeVisibility' }]).select('id').single();
  if (cErr) throw new Error('crea company: ' + cErr.message);
  const companyId = company.id;

  const { data: site, error: sErr } = await supabase.from('sites').insert([{
    company_id: companyId, name: 'TEST-Cantiere', address: 'Via Test 1', status: 'attivo',
    latitude: SITE.lat, longitude: SITE.lon, geofence_radius_m: RADIUS_M,
  }]).select('id').single();
  if (sErr) throw new Error('crea site: ' + sErr.message);
  const siteId = site.id;

  const workers = {};
  for (const [key, expiry] of [['inRegola', null], ['scaduto', '2020-01-01']]) {
    const badge = newBadgeCode();
    const { data: w, error } = await supabase.from('workers').insert([{
      company_id: companyId, full_name: `TEST-F138F139-${key}`, fiscal_code: `TSTF13${key === 'scaduto' ? '9' : '8'}0A01H501Z`,
      qualification: 'Muratore', is_active: true, badge_code: badge, safety_training_expiry: expiry,
    }]).select('id').single();
    if (error) throw new Error(`crea worker ${key}: ${error.message}`);
    workers[key] = { id: w.id, badge };
  }

  try {
    // ── F-138: tentativo fuori geofence → 403 + audit log ─────────────────
    const farLat = SITE.lat + metersToLatOffset(600);
    const rGeo = await punch(workers.inRegola.badge, { site_id: siteId, latitude: farLat, longitude: SITE.lon, gps_accuracy_m: 15 });
    if (rGeo.status === 403 && rGeo.data.error === 'OUTSIDE_GEOFENCE') ok('fuori geofence → 403 OUTSIDE_GEOFENCE (invariato)');
    else fail('fuori geofence → 403 OUTSIDE_GEOFENCE', rGeo);

    const { data: auditGeo } = await supabase.from('admin_audit_log')
      .select('*').eq('company_id', companyId).eq('action', 'punch.rejected_geofence').eq('target_id', workers.inRegola.id);
    if (auditGeo && auditGeo.length === 1 && auditGeo[0].payload?.distance_m === 599) {
      ok('F-138: tentativo rifiutato scritto in admin_audit_log (distance_m corretto)');
    } else fail('F-138: admin_audit_log punch.rejected_geofence', auditGeo);

    const { data: presenceGeo } = await supabase.from('presence_logs').select('id').eq('worker_id', workers.inRegola.id);
    if (!presenceGeo || presenceGeo.length === 0) ok('nessuna riga presence_logs per il tentativo rifiutato (corretto, invariato)');
    else fail('presence_logs NON deve avere righe per un tentativo fuori geofence', presenceGeo);

    // ── F-139: worker con formazione scaduta timbra in-geofence ──────────
    const rExpired = await punch(workers.scaduto.badge, { site_id: siteId, latitude: SITE.lat, longitude: SITE.lon, gps_accuracy_m: 15 });
    if (rExpired.status === 200 && rExpired.data.event_type === 'ENTRY') ok('lavoratore con formazione scaduta: ENTRY comunque registrata (policy scelta: permetti+avvisa)');
    else fail('ENTRY con formazione scaduta', rExpired);

    if (rExpired.data.compliance_warning?.expired?.includes('safety_training')) {
      ok('F-139: risposta API include compliance_warning.expired=["safety_training"] (visibile all\'operaio)');
    } else fail('F-139: compliance_warning nella risposta', rExpired.data);

    const { data: auditExp } = await supabase.from('admin_audit_log')
      .select('*').eq('company_id', companyId).eq('action', 'punch.expired_compliance').eq('target_id', workers.scaduto.id);
    if (auditExp && auditExp.length === 1 && auditExp[0].payload?.expired?.includes('safety_training')) {
      ok('F-139: timbratura con documento scaduto scritta in admin_audit_log');
    } else fail('F-139: admin_audit_log punch.expired_compliance', auditExp);

    // ── Regressione: worker in regola NON deve mai ricevere l'avviso ─────
    await new Promise(r => setTimeout(r, 61_000)); // guardia PUNCH_TOO_SOON — stesso worker, stesso cantiere del tentativo geofence sopra
    const rOk = await punch(workers.inRegola.badge, { site_id: siteId, latitude: SITE.lat, longitude: SITE.lon, gps_accuracy_m: 15 });
    if (rOk.status === 200 && rOk.data.compliance_warning === null) {
      ok('lavoratore in regola: compliance_warning resta null (nessun falso positivo)');
    } else fail('lavoratore in regola non deve avere compliance_warning', rOk.data);

  } finally {
    // Cleanup — presence_logs/admin_audit_log sono append-only, restano
    // (dati TEST- riconoscibili, stesso pattern già in uso in questa suite).
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

main().catch(e => { console.error('ERRORE FATALE:', e.message); process.exitCode = 1; });
