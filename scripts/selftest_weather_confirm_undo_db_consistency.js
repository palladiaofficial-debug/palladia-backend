#!/usr/bin/env node
/**
 * scripts/selftest_weather_confirm_undo_db_consistency.js
 *
 * Regressione per F-202 (AUDIT.md): trovato riguardando confirm/undo dopo
 * aver corretto lo stesso problema su dismiss (F-201) — "bug ripetuto su
 * più endpoint, sweep subito" (vedi memoria feedback_pattern_sweep_over_
 * reactive_fix). Sia POST .../confirm sia POST .../undo scrivevano su
 * site_weather_logs (il flag suspension_confirmed/suspension_id su confirm,
 * il reset completo su undo) senza MAI controllare l'esito dell'update —
 * se quella scrittura secondaria fosse silenziosamente fallita, la risposta
 * sarebbe stata comunque 200 ok, lasciando un'incoerenza reale: su confirm,
 * un giorno con un record legale in site_suspension_days ma ancora "da
 * confermare" nel log (continuerebbe a comparire come pendente e a generare
 * notifiche); su undo, un giorno senza più sospensione ma ancora marcato
 * confermato/ignorato nel log.
 *
 * Nessun test HTTP esisteva finora per questi due endpoint (verificato:
 * nessuno script in scripts/selftest_*.js li chiama) — solo verifica dal
 * vivo, non lettura del codice, colma anche questo gap.
 *
 * Blocco 1 (live HTTP): confirm su un giorno pendente reale — verifica non
 * solo la risposta 200, ma che site_suspension_days abbia davvero la riga E
 * che site_weather_logs.suspension_confirmed/suspension_id siano davvero
 * valorizzati in DB (non solo la risposta HTTP).
 * Blocco 2 (live HTTP): undo dello stesso giorno — verifica che
 * site_suspension_days non abbia più la riga E che tutti e 3 i flag sul log
 * siano davvero azzerati in DB.
 * Blocco 3 (live HTTP): guardie esistenti non regredite — confirm su una
 * data senza log -> 404; undo su un giorno non confermato -> 409.
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

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('confirm/undo coerenza DB', 'fixture Supabase non configurate'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const auth = await getCiTestAuth(admin, anon);
  if (!auth) { skip('confirm/undo coerenza DB', 'utente/company ci-test non trovati'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const { data: site } = await admin.from('sites').insert({
    company_id: auth.companyId, name: `TEST-E2E-F202-ConfirmUndo-${crypto.randomUUID().slice(0, 8)}`,
    address: 'Via Test F-202', status: 'attivo', latitude: 44.4056, longitude: 8.9463,
    start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi',
  }).select('id').single();
  const siteId = site.id;
  const dateISO = '2026-06-20';

  await admin.from('site_weather_logs').insert({
    company_id: auth.companyId, site_id: siteId, log_date: dateISO,
    precipitation_mm: 8, wind_max_kmh: 12, weather_code: 61, weather_desc: 'pioggia',
    threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false,
    data_source: 'arpal_certified', fetched_at: new Date().toISOString(),
  });

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.jwt}`, 'X-Company-Id': auth.companyId };

  try {
    console.log('\nBlocco 1 — confirm scrive DAVVERO su site_suspension_days E su site_weather_logs (live HTTP)\n');

    const confirmRes = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/${dateISO}/confirm`, {
      method: 'POST', headers, body: JSON.stringify({ notes: 'test F-202' }),
    });
    const confirmBody = await confirmRes.json().catch(() => ({}));
    check('confirm -> 200', confirmRes.status === 200, { status: confirmRes.status, body: confirmBody });
    check('risposta include l\'id della sospensione creata', !!confirmBody.suspension?.id, confirmBody);

    const { data: suspRow } = await admin.from('site_suspension_days')
      .select('id, day, reason').eq('site_id', siteId).eq('day', dateISO).maybeSingle();
    check('site_suspension_days ha davvero la riga (non solo la risposta HTTP)', !!suspRow, suspRow);

    const { data: logAfterConfirm } = await admin.from('site_weather_logs')
      .select('suspension_confirmed, suspension_id').eq('site_id', siteId).eq('log_date', dateISO).single();
    check('site_weather_logs.suspension_confirmed è davvero true in DB (non solo la risposta HTTP)', logAfterConfirm?.suspension_confirmed === true, logAfterConfirm);
    check('site_weather_logs.suspension_id punta davvero alla riga creata', logAfterConfirm?.suspension_id === suspRow?.id, { logSuspensionId: logAfterConfirm?.suspension_id, suspRowId: suspRow?.id });

    console.log('\nBlocco 2 — undo elimina DAVVERO site_suspension_days E azzera tutti i flag sul log (live HTTP)\n');

    const undoRes = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/${dateISO}/undo`, { method: 'POST', headers });
    const undoBody = await undoRes.json().catch(() => ({}));
    check('undo -> 200', undoRes.status === 200, { status: undoRes.status, body: undoBody });

    const { data: suspRowAfterUndo } = await admin.from('site_suspension_days')
      .select('id').eq('site_id', siteId).eq('day', dateISO).maybeSingle();
    check('site_suspension_days non ha più la riga dopo undo', !suspRowAfterUndo, suspRowAfterUndo);

    const { data: logAfterUndo } = await admin.from('site_weather_logs')
      .select('suspension_confirmed, suspension_dismissed, suspension_id').eq('site_id', siteId).eq('log_date', dateISO).single();
    check('suspension_confirmed azzerato a false', logAfterUndo?.suspension_confirmed === false, logAfterUndo);
    check('suspension_dismissed azzerato a false', logAfterUndo?.suspension_dismissed === false, logAfterUndo);
    check('suspension_id azzerato a null', logAfterUndo?.suspension_id === null, logAfterUndo);

    console.log('\nBlocco 3 — guardie esistenti non regredite (live HTTP)\n');

    const confirmMissing = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/2099-01-01/confirm`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    check('confirm su data senza log -> 404 LOG_NOT_FOUND', confirmMissing.status === 404, confirmMissing.status);

    const undoNotConfirmed = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/${dateISO}/undo`, { method: 'POST', headers });
    check('undo su giorno non confermato (già annullato sopra) -> 409 NOT_CONFIRMED', undoNotConfirmed.status === 409, undoNotConfirmed.status);
  } finally {
    await admin.from('site_suspension_days').delete().eq('site_id', siteId);
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
