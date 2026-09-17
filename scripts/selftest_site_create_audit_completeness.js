#!/usr/bin/env node
/**
 * scripts/selftest_site_create_audit_completeness.js
 *
 * Test di regressione per F-208 (AUDIT.md) — POST /sites (creazione
 * cantiere) registrava in admin_audit_log SOLO {name, address}, mai
 * start_date/end_date/contract_days/days_type/client anche quando venivano
 * davvero impostati alla creazione. Stesso difetto in POST /sites/:id/
 * duplicate (solo {source_id, name}).
 *
 * Non un bug di dato inventato (i valori in DB sono reali e verificabili),
 * ma un buco nell'audit trail: senza il payload completo, non c'è modo di
 * dimostrare chi ha inserito inizio/fine lavori/giorni contratto di un
 * cantiere — esattamente il tipo di garanzia che i documenti "prova per
 * richieste di proroga" (Registro Meteo, D.Lgs. 36/2023 art. 107) devono
 * poter offrire. Segnalato dal titolare il 2026-09-17 osservando un PDF
 * reale con inizio/fine lavori che sembravano "apparsi dal nulla".
 *
 * Chiamate HTTP reali contro il server (come selftest_presence_closure.js).
 * Env: TEST_BASE_URL, E2E_COMPANY_ID, E2E_EMAIL/E2E_PASSWORD.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { createClient } = require('@supabase/supabase-js');

const BASE       = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const EMAIL      = process.env.E2E_EMAIL || '';
const PASSWORD   = process.env.E2E_PASSWORD || '';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

async function latestAuditPayload(targetId, action) {
  // admin_audit_log è scritto in modo fire-and-forget (auditLog() non è
  // awaited dalla route) — piccola attesa per lasciarlo atterrare prima di
  // rileggerlo, stesso margine usato altrove in questo repo per lo stesso
  // motivo (vedi selftest_archive_actions_auth.js).
  await new Promise(r => setTimeout(r, 1500));
  const { data } = await supabase.from('admin_audit_log')
    .select('payload').eq('target_id', targetId).eq('action', action)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.payload || null;
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_site_create_audit_completeness: E2E_EMAIL/E2E_PASSWORD non configurati.');
    return;
  }
  console.log('\n\x1b[1mCompletezza audit log — creazione/duplicazione cantiere (F-208)\x1b[0m');

  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: sess, error: authErr } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) { fail('login bot E2E', authErr.message); return report(); }
  const jwt = sess.session.access_token;
  const headers = { Authorization: `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID, 'Content-Type': 'application/json' };

  let siteId = null, dupId = null;
  try {
    // 1. Creazione con campi contrattuali reali — esattamente quello che
    //    un titolare compila nel form "Nuovo cantiere".
    const createRes = await fetch(`${BASE}/api/v1/sites`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: `TEST-F208 ${Date.now()}`, address: 'Via Test 208, Genova',
        client: 'TEST-F208 Committente', start_date: '2026-01-15',
        contract_days: 72, days_type: 'lavorativi',
      }),
    });
    const created = await createRes.json();
    if (createRes.status !== 201 || !created.id) { fail('crea cantiere di test', { status: createRes.status, created }); return report(); }
    siteId = created.id;

    const createPayload = await latestAuditPayload(siteId, 'site.create');
    if (createPayload && ['start_date', 'contract_days', 'client'].every(k => k in createPayload)) {
      ok('il payload di site.create contiene start_date/contract_days/client, non solo name/address');
    } else {
      fail('il payload di site.create contiene start_date/contract_days/client, non solo name/address', createPayload);
    }
    if (createPayload?.start_date === '2026-01-15' && Number(createPayload?.contract_days) === 72) {
      ok('i valori registrati nel log coincidono con quelli davvero inviati');
    } else {
      fail('i valori registrati nel log coincidono con quelli davvero inviati', createPayload);
    }

    // 2. Duplicazione — i campi contrattuali COPIATI devono comparire nel
    //    log, non solo il nome del nuovo cantiere.
    const dupRes = await fetch(`${BASE}/api/v1/sites/${siteId}/duplicate`, { method: 'POST', headers, body: '{}' });
    const dup = await dupRes.json();
    if (dupRes.status !== 201 || !dup.id) { fail('duplica cantiere di test', { status: dupRes.status, dup }); }
    else {
      dupId = dup.id;
      const dupPayload = await latestAuditPayload(dupId, 'site.duplicate');
      if (dupPayload && 'start_date' in dupPayload && 'contract_days' in dupPayload) {
        ok('il payload di site.duplicate contiene i campi contrattuali copiati, non solo il nome');
      } else {
        fail('il payload di site.duplicate contiene i campi contrattuali copiati, non solo il nome', dupPayload);
      }
    }
  } finally {
    for (const id of [siteId, dupId].filter(Boolean)) {
      await fetch(`${BASE}/api/v1/sites/${id}`, { method: 'DELETE', headers }).catch(() => {});
    }
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_site_create_audit_completeness:', e.message);
  process.exit(1);
});
