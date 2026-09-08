#!/usr/bin/env node
/**
 * scripts/selftest_badge_punch_context_stale_assignment.js
 *
 * Test di regressione per F-150 (AUDIT.md) — trovato il primo giorno reale
 * di timbrature (2026-09-08): un lavoratore (Armand Binozi) non riusciva a
 * timbrare su nessuno dei cantieri reali. Root cause: GET
 * /badge/:code/punch-context risolveva i cantieri assegnati in
 * worksite_workers con `.in('id', siteIds)` SENZA filtrare per company_id
 * e senza escludere lo status 'eliminato' (solo 'chiuso'). Una riga
 * worksite_workers residua verso un cantiere di un'ALTRA company (già
 * eliminato) nascondeva quindi tutti i cantieri reali e attivi del
 * lavoratore, auto-selezionando l'unico (sbagliato) disponibile.
 *
 * Scenario riprodotto: worker nella company A con un'assegnazione
 * worksite_workers verso un sito eliminato della company B (mai ripulita
 * dopo un cambio di company, esattamente il caso reale). L'endpoint deve
 * ignorare quell'assegnazione stale e ricadere sui cantieri attivi della
 * company A del lavoratore.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function newBadgeCode() { return crypto.randomBytes(9).toString('hex').toUpperCase(); }

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }

async function punchContext(code, lat, lon) {
  const res = await fetch(`${BASE}/api/v1/badge/${code}/punch-context?lat=${lat}&lon=${lon}`);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log(`\nBadge punch-context — F-150 regression (assegnazione stale cross-company) — ${BASE}`);

  // Company B — cantiere sbagliato, già eliminato (simula la fixture di test
  // pre-disambiguazione, vedi two_mscedilizia_companies_disambiguation)
  const { data: companyB, error: cbErr } = await supabase.from('companies')
    .insert([{ name: 'TEST-F150-CompanyB-Stale' }]).select('id').single();
  if (cbErr) throw new Error('crea company B: ' + cbErr.message);
  const companyBId = companyB.id;

  const { data: staleSite, error: ssErr } = await supabase.from('sites').insert([{
    company_id: companyBId, name: 'TEST-F150-CantiereStale', address: 'Via Stale 1',
    status: 'eliminato', latitude: 41.0, longitude: 12.0, geofence_radius_m: 100,
  }]).select('id').single();
  if (ssErr) throw new Error('crea sito stale: ' + ssErr.message);

  // Company A — cantiere reale del lavoratore
  const { data: companyA, error: caErr } = await supabase.from('companies')
    .insert([{ name: 'TEST-F150-CompanyA-Real' }]).select('id').single();
  if (caErr) throw new Error('crea company A: ' + caErr.message);
  const companyAId = companyA.id;

  const REAL = { lat: 44.412669, lon: 8.955889 };
  const { data: realSite, error: rsErr } = await supabase.from('sites').insert([{
    company_id: companyAId, name: 'TEST-F150-CantiereReale', address: 'Via Reale 1',
    status: 'attivo', latitude: REAL.lat, longitude: REAL.lon, geofence_radius_m: 100,
  }]).select('id').single();
  if (rsErr) throw new Error('crea sito reale: ' + rsErr.message);

  const badge = newBadgeCode();
  const { data: worker, error: wErr } = await supabase.from('workers').insert([{
    company_id: companyAId, full_name: 'TEST-F150-Worker', fiscal_code: 'TSTF1500A01H501Z',
    qualification: 'Muratore', is_active: true, badge_code: badge,
  }]).select('id').single();
  if (wErr) throw new Error('crea worker: ' + wErr.message);

  // Assegnazione residua verso il sito ELIMINATO di un'ALTRA company —
  // esattamente la riga trovata su Armand (F-150).
  const { error: assocErr } = await supabase.from('worksite_workers').insert([{
    company_id: companyBId, site_id: staleSite.id, worker_id: worker.id, status: 'active',
  }]);
  if (assocErr) throw new Error('crea assegnazione stale: ' + assocErr.message);

  try {
    const r = await punchContext(badge, REAL.lat, REAL.lon);

    if (r.status === 200) ok('punch-context risponde 200');
    else fail('punch-context deve rispondere 200', r);

    const siteIds = (r.data.sites || []).map(s => s.site_id);
    if (!siteIds.includes(staleSite.id)) {
      ok('F-150: il cantiere eliminato di un\'altra company NON compare più nella lista');
    } else fail('F-150: il cantiere stale/cross-company compare ancora', r.data.sites);

    if (siteIds.includes(realSite.id)) {
      ok('F-150: il cantiere reale e attivo della company del lavoratore compare nella lista');
    } else fail('F-150: il cantiere reale non compare — fallback alla company non scattato', r.data.sites);

    if (r.data.auto_selected_site_id === realSite.id) {
      ok('F-150: auto-selezionato il cantiere reale (in geofence), non quello stale');
    } else fail('F-150: auto_selected_site_id errato', r.data.auto_selected_site_id);

  } finally {
    await supabase.from('worksite_workers').delete().in('company_id', [companyAId, companyBId]);
    await supabase.from('workers').delete().eq('company_id', companyAId);
    await supabase.from('sites').delete().in('company_id', [companyAId, companyBId]);
    await supabase.from('companies').delete().in('id', [companyAId, companyBId]);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE FATALE:', e.message); process.exitCode = 1; });
