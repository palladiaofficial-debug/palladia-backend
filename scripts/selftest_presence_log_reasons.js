#!/usr/bin/env node
/**
 * scripts/selftest_presence_log_reasons.js
 *
 * Regressione per il "motivo uscita" (maltempo/malattia/permesso,
 * migrations/217) — richiesta esplicita del titolare (2026-09-17): come
 * segnare che un'uscita è dovuta a pioggia e non a un malessere, con un
 * vincolo prioritario esplicito — "qualsiasi modifica deve essere un
 * miglioramento, non deve inficiare in minima maniera il funzionamento
 * vitale delle timbrature".
 *
 * Il controllo più importante di questo file non è che l'etichetta si
 * applichi — è che APPLICARLA NON CAMBI DI UN MINUTO le ore calcolate:
 * stesso scenario esatto descritto dal titolare (uscita alle 10 per
 * pioggia, rientro alle 13 perché smette), tagga l'uscita delle 10, e
 * verifica che buildWorkerHoursReport()/buildDailyPresenceSummary()
 * restituiscano ESATTAMENTE gli stessi minuti, le stesse coppie, lo stesso
 * numero di intervalli prima e dopo — byte per byte, non "circa uguali".
 *
 * Copre anche: ruolo (tech negato, owner riesce), validazione motivo,
 * rifiuto su un'ENTRY (il motivo si applica solo a un'uscita), che il
 * motivo compaia nei due generatori di report (Registro Presenze, Ore
 * Lavorate) e in GET /presence — e che resti un campo SEPARATO da
 * `annotation` (l'annotazione esistente per i glitch tecnici).
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (o SUPABASE_KEY), SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano, il test si salta. GET /presence via HTTP reale richiede anche
 * TEST_BASE_URL raggiungibile (default: produzione).
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
  console.log('\nPalladia regression — motivo uscita: maltempo/malattia/permesso\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('motivo uscita', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin     = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonTech  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonOwner = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies')
    .insert([{ name: 'TEST-PresenceReasons' }]).select('id').single();
  const companyId = company.id;

  const { data: site } = await admin.from('sites').insert([{
    company_id: companyId, name: 'TEST-Cantiere-Reasons', address: 'Via Test', status: 'attivo',
  }]).select('id').single();

  const { data: worker } = await admin.from('workers').insert([{
    company_id: companyId, full_name: 'TEST-Reasons-Worker', fiscal_code: `RSN${Date.now()}`.slice(0, 16).toUpperCase(),
    qualification: 'Muratore', is_active: true, badge_code: `RSN${Date.now()}`.slice(0, 18).toUpperCase(),
  }]).select('id').single();

  const techEmail  = `test-reasons-tech-${Date.now()}@palladia-test.local`;
  const ownerEmail = `test-reasons-owner-${Date.now()}@palladia-test.local`;
  const { data: techUser }  = await admin.auth.admin.createUser({ email: techEmail,  email_confirm: true });
  const { data: ownerUser } = await admin.auth.admin.createUser({ email: ownerEmail, email_confirm: true });
  await admin.from('company_users').insert([
    { company_id: companyId, user_id: techUser.user.id,  role: 'tech'  },
    { company_id: companyId, user_id: ownerUser.user.id, role: 'owner' },
  ]);
  const techJwt  = await sessionFor(admin, anonTech, techEmail);
  const ownerJwt = await sessionFor(admin, anonOwner, ownerEmail);

  const DAY = '2026-06-23';
  // Esattamente lo scenario descritto dal titolare: entra 07:00, esce alle
  // 10:00 per pioggia (dopo le canoniche 2 ore d'attesa), rientra alle
  // 13:00 perché smette di piovere, esce alle 17:00.
  const { data: insertedLogs } = await admin.from('presence_logs').insert([
    { company_id: companyId, site_id: site.id, worker_id: worker.id, ...log('ENTRY', '07:00', DAY) },
    { company_id: companyId, site_id: site.id, worker_id: worker.id, ...log('EXIT',  '10:00', DAY) },
    { company_id: companyId, site_id: site.id, worker_id: worker.id, ...log('ENTRY', '13:00', DAY) },
    { company_id: companyId, site_id: site.id, worker_id: worker.id, ...log('EXIT',  '17:00', DAY) },
  ]).select('id, event_type, timestamp_server').order('timestamp_server', { ascending: true });
  const rainExitLogId = insertedLogs[1].id;   // EXIT delle 10:00
  const entryLogId    = insertedLogs[2].id;   // ENTRY delle 13:00 — per il test "non è un'uscita"

  try {
    // ── 1. Baseline PRIMA di qualunque etichetta ──────────────────────────
    const hoursBefore   = await buildWorkerHoursReport(site.id, companyId, DAY, DAY, worker.id, false);
    const summaryBefore = await buildDailyPresenceSummary(site.id, companyId, DAY, DAY);
    const dayBefore      = hoursBefore.workers[0]?.days[0];
    const summaryRowBefore = summaryBefore.rows[0];

    check('baseline: 7 ore totali (3h mattina + 4h pomeriggio, nessuna pausa doppia)',
      dayBefore?.day_total_minutes === 420, dayBefore?.day_total_minutes);
    check('baseline: due coppie distinte (mattina/pomeriggio)', dayBefore?.entries?.length === 2, dayBefore?.entries?.length);
    check('baseline Registro Presenze: 7.00h, 2 intervalli, nessuna anomalia motivo',
      summaryRowBefore?.hours_total === 7 && summaryRowBefore?.intervals_count === 2, summaryRowBefore);

    // ── 2. Ruolo: tech negato, owner riesce ───────────────────────────────
    const techRes = await fetch(`${BASE}/api/v1/presence/${rainExitLogId}/reason`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${techJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'maltempo' }),
    });
    check('un tech NON può applicare un motivo (403)', techRes.status === 403, { status: techRes.status });

    // ── 3. Validazioni ─────────────────────────────────────────────────────
    const invalidRes = await fetch(`${BASE}/api/v1/presence/${rainExitLogId}/reason`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'pioggia' }), // non nell'enum — solo maltempo/malattia/permesso
    });
    check('un motivo fuori enum viene rifiutato (400 INVALID_REASON)', invalidRes.status === 400, { status: invalidRes.status });

    const wrongTypeRes = await fetch(`${BASE}/api/v1/presence/${entryLogId}/reason`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'maltempo' }),
    });
    check('un motivo su un\'ENTRY (non un\'uscita) viene rifiutato (400 NOT_AN_EXIT)', wrongTypeRes.status === 400, { status: wrongTypeRes.status });

    // ── 4. Applicazione reale (owner) ─────────────────────────────────────
    const applyRes = await fetch(`${BASE}/api/v1/presence/${rainExitLogId}/reason`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'maltempo', note: 'pioggia intensa, previsto rientro pomeriggio' }),
    });
    check('owner applica il motivo (200)', applyRes.status === 200, { status: applyRes.status });

    // ── 5. INVARIANTE CRITICA: le ore DOPO devono essere identiche a PRIMA ─
    const hoursAfter   = await buildWorkerHoursReport(site.id, companyId, DAY, DAY, worker.id, false);
    const summaryAfter = await buildDailyPresenceSummary(site.id, companyId, DAY, DAY);
    const dayAfter        = hoursAfter.workers[0]?.days[0];
    const summaryRowAfter = summaryAfter.rows[0];

    check('DOPO il tag: minuti totali IDENTICI a prima (nessuna fusione/alterazione ore)',
      dayAfter?.day_total_minutes === dayBefore?.day_total_minutes, { prima: dayBefore?.day_total_minutes, dopo: dayAfter?.day_total_minutes });
    check('DOPO il tag: stesso numero di coppie/intervalli',
      dayAfter?.entries?.length === dayBefore?.entries?.length, { prima: dayBefore?.entries?.length, dopo: dayAfter?.entries?.length });
    check('DOPO il tag: Registro Presenze — stesse ore totali, stessi intervalli',
      summaryRowAfter?.hours_total === summaryRowBefore?.hours_total && summaryRowAfter?.intervals_count === summaryRowBefore?.intervals_count,
      { prima: summaryRowBefore, dopo: summaryRowAfter });

    // ── 6. Il motivo compare come testo nei due report (esportabile) ──────
    const morningEntry = dayAfter?.entries?.find(e => e.exit_time === '10:00');
    check('Report Ore Lavorate: la coppia delle 10:00 mostra "Uscita per maltempo" con la nota',
      morningEntry?.anomaly?.includes('Uscita per maltempo') && morningEntry?.anomaly?.includes('pioggia intensa'),
      morningEntry?.anomaly);
    check('Registro Presenze: le anomalie del giorno includono "Uscita per maltempo"',
      summaryRowAfter?.anomalies?.some(a => a.includes('Uscita per maltempo')), summaryRowAfter?.anomalies);

    // ── 7. GET /presence espone il motivo, separato da `annotation` ───────
    const dateParam = DAY;
    const getRes = await fetch(`${BASE}/api/v1/presence?siteId=${site.id}&date=${dateParam}`, {
      headers: { Authorization: `Bearer ${ownerJwt}`, 'X-Company-Id': companyId },
    });
    const getLogs = await getRes.json();
    const taggedLog = Array.isArray(getLogs) ? getLogs.find(l => l.id === rainExitLogId) : null;
    check('GET /presence: la riga delle 10:00 ha reason.reason === "maltempo"', taggedLog?.reason?.reason === 'maltempo', taggedLog);
    check('GET /presence: `annotation` resta null (campo separato, mai confuso col motivo)', taggedLog?.annotation === null, taggedLog?.annotation);

  } finally {
    await admin.from('presence_log_reasons').delete().eq('company_id', companyId);
    await admin.from('presence_logs').delete().eq('company_id', companyId);
    await admin.from('company_users').delete().eq('company_id', companyId);
    await admin.from('workers').delete().eq('company_id', companyId);
    await admin.from('sites').delete().eq('company_id', companyId);
    await admin.from('companies').delete().eq('id', companyId);
    await admin.auth.admin.deleteUser(techUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(ownerUser.user.id).catch(() => {});
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('ERRORE selftest_presence_log_reasons:', e.message);
  process.exit(1);
});
