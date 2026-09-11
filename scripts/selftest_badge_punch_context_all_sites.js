#!/usr/bin/env node
/**
 * scripts/selftest_badge_punch_context_all_sites.js
 *
 * Test di regressione per F-16x (AUDIT.md) — 2026-09-11. Incidente reale:
 * Raksasoi Suriya (MSCedilizia S.r.l.) non riusciva a timbrare l'ingresso
 * dal "Magazzino MSCedilizia" — GET /badge/:code/punch-context mostrava
 * solo i due cantieri a cui risultava assegnato in worksite_workers ("Via
 * Riboli 4b", "Via San Nazaro 34"), mai il resto dei cantieri attivi
 * dell'azienda.
 *
 * Root cause: il fallback alla lista completa dei cantieri della company
 * scattava SOLO quando le assegnazioni valide erano ZERO (introdotto da
 * F-150 per il solo caso di riga stale cross-company/eliminata). Un
 * lavoratore con 2+ assegnazioni legittime ma che si sposta su un cantiere
 * NON assegnato restava bloccato — stesso bug già diagnosticato il
 * 2026-09-10 su Dervishaj/Suriya ("Via San Nazaro 34" mancante), "risolto"
 * allora solo rimuovendo a mano la riga worksite_workers (palliativo dati),
 * non la causa nel codice — e infatti si è ripresentato.
 *
 * Richiesta esplicita e ripetuta dell'utente: ogni lavoratore deve vedere e
 * poter timbrare su QUALSIASI cantiere attivo dell'azienda, indipendente da
 * `worksite_workers`. Scenario riprodotto: worker con 2 assegnazioni attive
 * verso 2 cantieri reali, azienda con un terzo cantiere attivo a cui il
 * worker NON è assegnato — deve comunque comparire nella lista.
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

async function punchContext(code) {
  const res = await fetch(`${BASE}/api/v1/badge/${code}/punch-context`);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log(`\nBadge punch-context — F-16x regression (cantiere non assegnato mancante) — ${BASE}`);

  const { data: company, error: cErr } = await supabase.from('companies')
    .insert([{ name: 'TEST-F16x-Company' }]).select('id').single();
  if (cErr) throw new Error('crea company: ' + cErr.message);
  const companyId = company.id;

  const mkSite = (name) => supabase.from('sites').insert([{
    company_id: companyId, name, address: 'Via Test 1',
    status: 'attivo', latitude: 44.4, longitude: 8.9, geofence_radius_m: 100,
  }]).select('id').single();

  const { data: siteA, error: saErr } = await mkSite('TEST-F16x-CantiereA-Assegnato');
  if (saErr) throw new Error('crea sito A: ' + saErr.message);
  const { data: siteB, error: sbErr } = await mkSite('TEST-F16x-CantiereB-Assegnato');
  if (sbErr) throw new Error('crea sito B: ' + sbErr.message);
  const { data: siteC, error: scErr } = await mkSite('TEST-F16x-CantiereC-NonAssegnato-Magazzino');
  if (scErr) throw new Error('crea sito C: ' + scErr.message);

  const badge = newBadgeCode();
  const { data: worker, error: wErr } = await supabase.from('workers').insert([{
    company_id: companyId, full_name: 'TEST-F16x-Worker', fiscal_code: 'TSTF16X0A01H501Z',
    qualification: 'Muratore', is_active: true, badge_code: badge,
  }]).select('id').single();
  if (wErr) throw new Error('crea worker: ' + wErr.message);

  // Il worker ha 2 assegnazioni ATTIVE e LEGITTIME (non stale, non
  // cross-company) — esattamente il caso reale di Suriya.
  const { error: assocErr } = await supabase.from('worksite_workers').insert([
    { company_id: companyId, site_id: siteA.id, worker_id: worker.id, status: 'active' },
    { company_id: companyId, site_id: siteB.id, worker_id: worker.id, status: 'active' },
  ]);
  if (assocErr) throw new Error('crea assegnazioni: ' + assocErr.message);

  try {
    const r = await punchContext(badge);

    if (r.status === 200) ok('punch-context risponde 200');
    else fail('punch-context deve rispondere 200', r);

    const siteIds = (r.data.sites || []).map(s => s.site_id);

    if (siteIds.includes(siteA.id) && siteIds.includes(siteB.id)) {
      ok('i due cantieri assegnati compaiono nella lista');
    } else fail('i cantieri assegnati non compaiono', r.data.sites);

    if (siteIds.includes(siteC.id)) {
      ok('F-16x: il cantiere NON assegnato (es. magazzino) compare comunque nella lista');
    } else fail('F-16x: il cantiere non assegnato manca — bug ripresentato', r.data.sites);

    if (siteIds.length === 3) {
      ok('la lista contiene tutti e 3 i cantieri attivi dell\'azienda, nessuno in più o in meno');
    } else fail('numero di cantieri in lista inatteso', siteIds);

  } finally {
    await supabase.from('worksite_workers').delete().eq('company_id', companyId);
    await supabase.from('workers').delete().eq('company_id', companyId);
    await supabase.from('sites').delete().eq('company_id', companyId);
    await supabase.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE FATALE:', e.message); process.exitCode = 1; });
