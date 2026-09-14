#!/usr/bin/env node
/**
 * scripts/selftest_badge_punch_idempotent_retry.js
 *
 * Regressione per F-184 (AUDIT.md, 2026-09-14): il client di
 * public/badge-punch.html non distingue "la richiesta non è mai
 * arrivata al server" da "è arrivata ed è stata processata, ma la
 * risposta si è persa" — su un errore di fetch ambiguo (VPN che si
 * riconnette, rete instabile) mette il tentativo in coda e lo
 * rispedisce quando la rete torna. Se la prima richiesta era invece
 * riuscita, il retry ripete lo stesso payload contro un endpoint che
 * è un TOGGLE — capovolgendo lo stato: un'ENTRY reale seguita, minuti
 * dopo, da un'EXIT fantasma mentre il lavoratore non si è mai mosso.
 * Osservato dal vivo su Canameti Ibrahim e Raksasoi Suriya (company
 * MSCedilizia S.r.l.) il 2026-09-14 — GPS identico e dentro il
 * geofence su entrambi gli eventi, quindi non un tentativo fuori zona.
 *
 * Fix (migrations/208): il client genera un UUID per TENTATIVO di
 * timbratura (non per richiesta HTTP, colonna dedicata
 * `client_request_id` — `session_id` esisteva già ma è una FK reale
 * verso worker_device_sessions, non riusabile per questo scopo) e lo
 * riusa identico se deve rimettere in coda/rispedire lo stesso
 * tentativo. punch_atomic, se riceve un client_request_id già visto
 * per quel lavoratore, restituisce l'evento già scritto invece di
 * deciderne uno nuovo.
 *
 * Chiama punch_atomic DIRETTAMENTE via RPC (non attraverso le route
 * HTTP) per isolare la funzione SQL — stesso pattern di
 * selftest_punch_atomic_global_exit.js (F-172). Il primo evento viene
 * inserito DIRETTAMENTE con `directLog` per rappresentare "il retry
 * arriva minuti dopo", evitando sia il debounce PUNCH_TOO_SOON (60s)
 * sia una seconda chiamata reale a punch_atomic per crearlo.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — punch_atomic: replay idempotente via client_request_id (F-184)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('punch_atomic idempotent retry', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F184-PunchIdempotent' }]).select('id').single();
  const companyId = company.id;
  const { data: site, error: siteErr } = await admin.from('sites').insert([{ company_id: companyId, name: 'TEST-F184-Site', address: 'Via Test', status: 'attivo' }]).select('id').single();
  if (siteErr) throw new Error(`site: ${siteErr.message}`);

  const workerIds = [];
  let workerSeq = 0;
  async function makeWorker(label) {
    workerSeq++;
    const uniq = `${Date.now()}${workerSeq}`;
    const { data: w, error } = await admin.from('workers').insert([{
      company_id: companyId, full_name: `TEST-F184-${label}`,
      fiscal_code: `F184${uniq}`.slice(0, 16).toUpperCase(),
      qualification: 'Muratore', is_active: true,
      badge_code: `F184${uniq}${label}`.slice(0, 18).toUpperCase(),
    }]).select('id').single();
    if (error) throw new Error(`makeWorker(${label}): ${error.message}`);
    workerIds.push(w.id);
    return w.id;
  }

  function directLog(workerId, siteId, eventType, tsIso, clientRequestId) {
    return admin.from('presence_logs').insert([{
      company_id: companyId, site_id: siteId, worker_id: workerId, event_type: eventType,
      timestamp_server: tsIso, method: 'worker_self_punch', client_request_id: clientRequestId || null,
    }]);
  }

  function punch(workerId, siteId, clientRequestId) {
    return admin.rpc('punch_atomic', {
      p_site_id: siteId, p_worker_id: workerId, p_company_id: companyId, p_session_id: null,
      p_lat: 44.4, p_lon: 8.9, p_distance_m: 0, p_accuracy_m: 10,
      p_ip: '127.0.0.1', p_ua: 'selftest', p_method: 'worker_self_punch',
      p_client_request_id: clientRequestId || null,
    });
  }

  try {
    // ── 1. ENTRY reale con client_request_id, poi il client "ritenta" lo
    //       stesso tentativo minuti dopo (stesso id): deve tornare l'ENTRY
    //       già scritta, NON generare un'EXIT ──
    const w1 = await makeWorker('W1');
    const crid1 = crypto.randomUUID();
    await directLog(w1, site.id, 'ENTRY', new Date(Date.now() - 5 * 60_000).toISOString(), crid1);
    const r1 = await punch(w1, site.id, crid1);
    check('F-184: retry con lo stesso client_request_id → risponde con l\'ENTRY già scritta, non un\'EXIT nuova',
      r1.data?.ok === true && r1.data?.event_type === 'ENTRY' && r1.data?.replayed === true, r1.data);

    const { data: w1Logs } = await admin.from('presence_logs')
      .select('event_type, client_request_id').eq('worker_id', w1).order('timestamp_server');
    check('F-184: nessuna riga aggiuntiva scritta dal replay — resta una sola ENTRY',
      w1Logs.length === 1 && w1Logs[0].event_type === 'ENTRY', w1Logs);

    // ── 2. Stesso scenario ma client_request_id NULL (client vecchio, senza
    //       id) → comportamento invariato: il retry vale come nuovo tocco
    //       reale, genera davvero un'EXIT (nessuna rottura di compatibilità) ──
    const w2 = await makeWorker('W2');
    await directLog(w2, site.id, 'ENTRY', new Date(Date.now() - 5 * 60_000).toISOString(), null);
    const r2 = await punch(w2, site.id, null);
    check('senza client_request_id (client non aggiornato) → comportamento invariato: nuovo tocco è una vera EXIT',
      r2.data?.ok === true && r2.data?.event_type === 'EXIT' && r2.data?.replayed === false, r2.data);

    // ── 3. client_request_id nuovo (mai visto) su un lavoratore già aperto →
    //       non è un replay, è un tocco reale: chiude normalmente ──
    const w3 = await makeWorker('W3');
    await directLog(w3, site.id, 'ENTRY', new Date(Date.now() - 5 * 60_000).toISOString(), crypto.randomUUID());
    const r3 = await punch(w3, site.id, crypto.randomUUID());
    check('client_request_id nuovo e mai visto → tocco reale, non un replay',
      r3.data?.ok === true && r3.data?.event_type === 'EXIT' && r3.data?.replayed === false, r3.data);

    // ── 4. Indice unico: due INSERT diretti con lo stesso worker_id+
    //       client_request_id devono essere respinti dal DB, seconda
    //       barriera oltre al check applicativo (race tra connessioni
    //       concorrenti) ──
    const w4 = await makeWorker('W4');
    const crid4 = crypto.randomUUID();
    const first = await directLog(w4, site.id, 'ENTRY', new Date().toISOString(), crid4);
    check('F-184: primo insert con client_request_id nuovo riesce', !first.error, first.error);
    const second = await directLog(w4, site.id, 'EXIT', new Date().toISOString(), crid4);
    check('F-184: indice unico (worker_id, client_request_id) respinge un secondo insert con lo stesso id',
      !!second.error && second.error.code === '23505', second.error);

  } finally {
    // presence_logs è append-only anche per il service role (migrations/003)
    // — non tentare DELETE/UPDATE, i lavoratori/company di test restano
    // (stesso limite già accettato dagli altri selftest presence).
    for (const wid of workerIds) {
      await admin.from('workers').update({ is_active: false }).eq('id', wid);
    }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
