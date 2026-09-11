#!/usr/bin/env node
/**
 * scripts/selftest_lunch_break_override.js
 *
 * Regressione per F-169 (AUDIT.md, 2026-09-11): la detrazione automatica
 * pausa pranzo (F-152) presume sempre che un turno unico continuo sopra
 * soglia includa una pausa non timbrata — penalizza chi ha davvero
 * lavorato senza sosta e lasciato prima invece di prolungare il turno.
 * Richiesta esplicita dell'utente: un modo per l'admin di segnalare
 * "niente pausa oggi" da Presenze & Report (migrations/200,
 * presence_lunch_overrides) — da quel momento nessuna detrazione per quel
 * lavoratore/giorno, in tutti e 3 i generatori di report.
 *
 * Copre: (1) POST/DELETE /reports/lunch-override — ruolo tech negato 403,
 * ruolo owner riesce; (2) l'override cambia davvero le ore restituite da
 * buildWorkerHoursReport() e buildDailyPresenceSummary(), non solo un flag
 * silente.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (o SUPABASE_KEY), SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { buildDailyPresenceSummary } = require('../services/presenceReport');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function log(eventType, hhmm, day) {
  return { event_type: eventType, timestamp_server: `${day}T${hhmm}:00+02:00`, method: 'worker_self_punch' };
}

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function main() {
  console.log('\nPalladia regression — override "niente pausa oggi" (F-169)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('lunch break override', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonTech  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonOwner = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies')
    .insert([{ name: 'TEST-F169-LunchOverride', lunch_break_minutes: 60, lunch_break_threshold_hours: 6 }])
    .select('id').single();
  const companyId = company.id;

  const { data: site } = await admin.from('sites').insert([{
    company_id: companyId, name: 'TEST-Cantiere-F169', address: 'Via Test', status: 'attivo',
  }]).select('id').single();

  const { data: worker } = await admin.from('workers').insert([{
    company_id: companyId, full_name: 'TEST-F169-Worker', fiscal_code: `F169${Date.now()}`.slice(0, 16).toUpperCase(),
    qualification: 'Muratore', is_active: true, badge_code: `F169${Date.now()}`.slice(0, 18).toUpperCase(),
  }]).select('id').single();

  const techEmail  = `test-f169-tech-${Date.now()}@palladia-test.local`;
  const ownerEmail = `test-f169-owner-${Date.now()}@palladia-test.local`;
  const { data: techUser }  = await admin.auth.admin.createUser({ email: techEmail,  email_confirm: true });
  const { data: ownerUser } = await admin.auth.admin.createUser({ email: ownerEmail, email_confirm: true });
  await admin.from('company_users').insert([
    { company_id: companyId, user_id: techUser.user.id,  role: 'tech'  },
    { company_id: companyId, user_id: ownerUser.user.id, role: 'owner' },
  ]);
  const techJwt  = await sessionFor(admin, anonTech, techEmail);
  const ownerJwt = await sessionFor(admin, anonOwner, ownerEmail);

  const DAY = '2026-06-22';
  // 8:00 -> 16:00, singola coppia continua (8h, sopra soglia 6h) — esatto
  // scenario segnalato dall'utente: ha saltato la pausa ed è uscito prima.
  await admin.from('presence_logs').insert([
    { company_id: companyId, site_id: site.id, worker_id: worker.id, ...log('ENTRY', '08:00', DAY) },
    { company_id: companyId, site_id: site.id, worker_id: worker.id, ...log('EXIT',  '16:00', DAY) },
  ]);

  try {
    // ── Prima dell'override: comportamento originale, detrae 60m ──
    const before = await buildWorkerHoursReport(site.id, companyId, DAY, DAY, worker.id, false);
    const dayBefore = before.workers?.[0]?.days?.find(d => d.date_key === DAY);
    check('senza override: il report Ore Lavorate detrae 60m (7h pagate su 8h reali)',
      dayBefore?.day_total_minutes === 420 && dayBefore?.lunch_break_minutes === 60, dayBefore);

    // ── Ruolo tech: POST /lunch-override negato ──
    const techRes = await fetch(`${BASE}/api/v1/reports/lunch-override`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${techJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: worker.id, work_date: DAY, note: 'test' }),
    });
    check('ruolo tech: POST /reports/lunch-override negato con 403', techRes.status === 403, { status: techRes.status });

    const { data: noRowYet } = await admin.from('presence_lunch_overrides')
      .select('id').eq('worker_id', worker.id).eq('work_date', DAY).maybeSingle();
    check('nessuna riga creata dal tentativo negato', !noRowYet, noRowYet);

    // ── Ruolo owner: POST riesce davvero ──
    const ownerRes = await fetch(`${BASE}/api/v1/reports/lunch-override`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: worker.id, work_date: DAY, note: 'Segnalato dal titolare — pausa saltata' }),
    });
    const ownerBody = await ownerRes.json().catch(() => null);
    check('ruolo owner: POST /reports/lunch-override riesce (200)', ownerRes.status === 200, { status: ownerRes.status, body: ownerBody });

    const { data: rowNow } = await admin.from('presence_lunch_overrides')
      .select('id, worker_id, work_date, note').eq('worker_id', worker.id).eq('work_date', DAY).maybeSingle();
    check('la riga esiste davvero in DB dopo il POST owner', !!rowNow, rowNow);

    // ── Dopo l'override: buildWorkerHoursReport paga le 8h intere ──
    const after = await buildWorkerHoursReport(site.id, companyId, DAY, DAY, worker.id, false);
    const dayAfter = after.workers?.[0]?.days?.find(d => d.date_key === DAY);
    check('F-169: con override buildWorkerHoursReport paga le 8h intere, nessuna detrazione',
      dayAfter?.day_total_minutes === 480 && dayAfter?.lunch_break_minutes === 0, dayAfter);
    check('F-169: il giorno è marcato no_lunch_override per la UI', dayAfter?.no_lunch_override === true, dayAfter);

    // ── GET elenca la segnalazione, per la UI ──
    const listRes = await fetch(`${BASE}/api/v1/reports/lunch-override?from=${DAY}&to=${DAY}`, {
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId },
    });
    const listBody = await listRes.json().catch(() => null);
    check('GET /reports/lunch-override elenca la segnalazione creata',
      listRes.status === 200 && (listBody?.overrides || []).some(o => o.worker_id === worker.id && o.work_date === DAY),
      listBody);

    // ── Stesso effetto su buildDailyPresenceSummary (Registro Presenze) ──
    const summary = await buildDailyPresenceSummary(site.id, companyId, DAY, DAY);
    const summaryRow = summary.rows?.find(r => r.dateKey === DAY);
    check('F-169: anche il Registro Presenze paga le 8h intere con l\'override attivo',
      summaryRow?.hours_total === 8, summaryRow);

    // ── DELETE rimuove l'override, torna al comportamento originale ──
    const delRes = await fetch(`${BASE}/api/v1/reports/lunch-override`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: worker.id, work_date: DAY }),
    });
    check('DELETE /reports/lunch-override riesce (200)', delRes.status === 200, { status: delRes.status });

    const afterDelete = await buildWorkerHoursReport(site.id, companyId, DAY, DAY, worker.id, false);
    const dayAfterDelete = afterDelete.workers?.[0]?.days?.find(d => d.date_key === DAY);
    check('dopo la DELETE, la detrazione automatica torna attiva (7h)',
      dayAfterDelete?.day_total_minutes === 420 && dayAfterDelete?.lunch_break_minutes === 60, dayAfterDelete);
  } finally {
    await admin.from('presence_lunch_overrides').delete().eq('company_id', companyId);
    await admin.from('presence_logs').delete().eq('company_id', companyId);
    await admin.from('company_users').delete().eq('company_id', companyId);
    await admin.auth.admin.deleteUser(techUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(ownerUser.user.id).catch(() => {});
    await admin.from('workers').delete().eq('company_id', companyId);
    await admin.from('sites').delete().eq('company_id', companyId);
    await admin.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
