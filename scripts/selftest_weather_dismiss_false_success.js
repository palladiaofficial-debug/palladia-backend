#!/usr/bin/env node
/**
 * scripts/selftest_weather_dismiss_false_success.js
 *
 * Regressione per F-201 (AUDIT.md): trovato continuando lo sweep del modulo
 * meteo ("vai avanti col prossimo miglioramento"), non segnalato dal
 * titolare. POST /weather-log/:date/dismiss (routes/v1/siteWeather.js) era
 * l'unico dei 4 endpoint di stato (confirm/dismiss/undo/fetch) che non
 * verificava se l'update avesse davvero toccato una riga — rispondeva
 * sempre 200 {ok:true}, anche su una data/cantiere senza nessun log meteo.
 * Stessa classe di "falso successo" già vista su annulla/crea (F-020/F-021).
 *
 * Blocco 1 (live HTTP, Supabase + backend reali): dismiss su una data SENZA
 * nessun log seminato -> deve rispondere 404, non più 200 {ok:true}.
 * Blocco 2 (live HTTP): dismiss su un log reale con soglia superata -> 200,
 * suspension_dismissed davvero true in DB, notifica pulita se non restano
 * giorni pendenti (comportamento esistente, non regredito dal fix).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function getCiTestAuth(admin, anon) {
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) return null;
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships || []).map(m => m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  if (!companyId) return null;
  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  return { jwt: session?.session?.access_token, companyId };
}

async function block1NoLogReturns404() {
  console.log('\nBlocco 1 — dismiss su una data senza log risponde 404, non più un falso 200 (live HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('dismiss senza log', 'fixture Supabase non configurate'); return; }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const auth = await getCiTestAuth(admin, anon);
  if (!auth) { skip('dismiss senza log', 'utente/company ci-test non trovati'); return; }

  const { data: site } = await admin.from('sites').insert({
    company_id: auth.companyId, name: `TEST-E2E-F201-DismissNoLog-${crypto.randomUUID().slice(0, 8)}`,
    address: 'Via Test F-201', status: 'attivo', latitude: 44.4056, longitude: 8.9463,
  }).select('id').single();
  const siteId = site.id;

  try {
    // Nessuna riga site_weather_logs seminata per questa data -> il log non esiste.
    const res = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/2099-01-01/dismiss`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.jwt}`, 'X-Company-Id': auth.companyId },
    });
    const body = await res.json().catch(() => ({}));
    check('dismiss su data senza log -> 404 (non più 200 {ok:true})', res.status === 404, { status: res.status, body });
    check('errore riporta LOG_NOT_FOUND', body.error === 'LOG_NOT_FOUND', body);
  } finally {
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function block2RealLogStillWorks() {
  console.log('\nBlocco 2 — dismiss su un log reale continua a funzionare (nessuna regressione, live HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('dismiss su log reale', 'fixture Supabase non configurate'); return; }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const auth = await getCiTestAuth(admin, anon);
  if (!auth) { skip('dismiss su log reale', 'utente/company ci-test non trovati'); return; }

  const { data: site } = await admin.from('sites').insert({
    company_id: auth.companyId, name: `TEST-E2E-F201-DismissRealLog-${crypto.randomUUID().slice(0, 8)}`,
    address: 'Via Test F-201', status: 'attivo', latitude: 44.4056, longitude: 8.9463,
  }).select('id').single();
  const siteId = site.id;
  const dateISO = '2026-06-15';

  await admin.from('site_weather_logs').insert({
    company_id: auth.companyId, site_id: siteId, log_date: dateISO,
    precipitation_mm: 5, wind_max_kmh: 10, weather_code: 61, weather_desc: 'pioggia',
    threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false,
    data_source: 'arpal_certified', fetched_at: new Date().toISOString(),
  });
  await admin.from('notifications').insert({
    company_id: auth.companyId, entity_type: 'site', entity_id: siteId, type: 'weather_suspension',
    severity: 'warning', title: 'Test', body: 'Test', updated_at: new Date().toISOString(),
  });

  try {
    const res = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/${dateISO}/dismiss`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.jwt}`, 'X-Company-Id': auth.companyId },
    });
    const body = await res.json().catch(() => ({}));
    check('dismiss su log reale -> 200 {ok:true} (nessuna regressione)', res.status === 200 && body.ok === true, { status: res.status, body });

    const { data: row } = await admin.from('site_weather_logs')
      .select('suspension_dismissed').eq('site_id', siteId).eq('log_date', dateISO).single();
    check('suspension_dismissed è davvero true in DB', row?.suspension_dismissed === true, row);

    const { data: notif } = await admin.from('notifications')
      .select('id').eq('company_id', auth.companyId).eq('entity_type', 'site')
      .eq('entity_id', siteId).eq('type', 'weather_suspension');
    check('notifica pulita: nessun giorno pendente rimasto per questo cantiere', (notif || []).length === 0, notif);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('notifications').delete().eq('entity_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function main() {
  console.log('\nPalladia regression — "Ignora giorno" non finge più successo su un update a vuoto (F-201)');
  await block1NoLogReturns404();
  await block2RealLogStillWorks();
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
