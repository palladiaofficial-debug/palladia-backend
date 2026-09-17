#!/usr/bin/env node
/**
 * scripts/selftest_missing_exit_detection.js
 *
 * Test di regressione per F-206 (AUDIT.md) — il rilevamento delle uscite
 * mancanti era MORTO in produzione, in silenzio.
 *
 * Causa: `checkCompany()` (services/missingExitCron.js) e il check intra-day
 * interrogavano presence_logs con un embed PostgREST `site:sites(...)`, ma la
 * FK presence_logs.site_id → sites(id) NON esiste più nel DB di produzione
 * (droppata a mano — 872 site_id in presence_logs puntano a cantieri ormai
 * cancellati, la FK non è ripristinabile senza rompere l'append-only).
 * PostgREST rispondeva "Could not find a relationship between 'presence_logs'
 * and 'sites' in the schema cache" e il codice faceva `if (error || !logs)
 * return []` → "nessuna uscita mancante", ogni giorno, per ogni azienda.
 *
 * Questo test fallisce se il bug torna, in due modi distinti:
 *   1. un ENTRY senza EXIT DEVE essere rilevato (prima: 0 rilevati);
 *   2. un errore di query NON deve mai degradare a lista vuota (deve alzare
 *      un'eccezione) — è il difetto che ha reso il bug invisibile.
 *
 * Nessun server richiesto per i controlli 1-5 (solo DB). Il controllo 6
 * (GET /presence/open-sessions, stesso bug, stessa causa) gira solo se
 * E2E_EMAIL/E2E_PASSWORD sono configurati.
 *
 * Env: E2E_COMPANY_ID, opzionali TEST_BASE_URL, E2E_EMAIL, E2E_PASSWORD.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { createClient } = require('@supabase/supabase-js');
const { checkCompany } = require('../services/missingExitCron');
const { findStaleOpenEntries } = require('../services/missingExitIntraDayCron');

const BASE       = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const EMAIL      = process.env.E2E_EMAIL || '';
const PASSWORD   = process.env.E2E_PASSWORD || '';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

const todayRome = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const hoursAgo  = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

async function main() {
  console.log('\n\x1b[1mRilevamento uscite mancanti (F-206)\x1b[0m');

  const stamp = Date.now();
  const { data: site, error: siteErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: `TEST-F206 Cantiere ${stamp}`, status: 'attivo', address: 'Via Test 206, Genova',
  }).select('id, name').single();
  if (siteErr) { fail('crea cantiere di test', siteErr.message); return report(); }

  const mkWorker = (suffix) => supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: `TEST-F206 ${suffix}`,
    fiscal_code: `F206${suffix}${stamp}`.slice(0, 16).toUpperCase(),
    is_active: true, badge_code: `F206${suffix}${stamp}`.slice(0, 20),
  }).select('id, full_name').single();

  const { data: aperto, error: e1 } = await mkWorker('A');
  const { data: chiuso, error: e2 } = await mkWorker('B');
  if (e1 || e2) { fail('crea lavoratori di test', e1?.message || e2?.message); await cleanup(site.id, [aperto, chiuso]); return report(); }

  // A: entrato 10h fa, mai uscito → uscita mancante.
  // B: entrato 10h fa e uscito 1h fa → nulla da rilevare.
  const { error: insErr } = await supabase.from('presence_logs').insert([
    { company_id: COMPANY_ID, site_id: site.id, worker_id: aperto.id, event_type: 'ENTRY', timestamp_server: hoursAgo(10), method: 'worker_self_punch' },
    { company_id: COMPANY_ID, site_id: site.id, worker_id: chiuso.id, event_type: 'ENTRY', timestamp_server: hoursAgo(10), method: 'worker_self_punch' },
    { company_id: COMPANY_ID, site_id: site.id, worker_id: chiuso.id, event_type: 'EXIT',  timestamp_server: hoursAgo(1),  method: 'worker_self_punch' },
  ]);
  if (insErr) { fail('inserisci timbrature di test', insErr.message); await cleanup(site.id, [aperto, chiuso]); return report(); }

  try {
    // 1. Il cron delle 20:00 deve VEDERE l'uscita mancante.
    let missing = [];
    try {
      missing = await checkCompany(COMPANY_ID, todayRome());
    } catch (e) {
      fail('checkCompany non solleva errori sui dati reali', e.message);
    }
    const trovato = missing.find(m => m.worker_id === aperto.id);
    if (trovato) ok('un ENTRY senza EXIT viene rilevato come uscita mancante');
    else fail('un ENTRY senza EXIT viene rilevato come uscita mancante', { rilevati: missing.length });

    // 2. Il nome del cantiere deve arrivare valorizzato (serve all'email e a
    //    Telegram): è il pezzo che l'embed rotto forniva.
    if (trovato?.site_name === site.name) ok('il nome del cantiere è risolto senza dipendere dalla FK verso sites');
    else fail('il nome del cantiere è risolto senza dipendere dalla FK verso sites', trovato);

    // 3. Chi ha già timbrato l'uscita non deve mai comparire.
    if (!missing.some(m => m.worker_id === chiuso.id)) ok('chi ha gia timbrato l uscita non viene segnalato');
    else fail('chi ha gia timbrato l uscita non viene segnalato', missing);

    // 4. Il check intra-day (alert 12/14/16/18) vede la stessa apertura.
    const stale = await findStaleOpenEntries(COMPANY_ID, todayRome(), 8);
    if (stale.some(m => m.worker_id === aperto.id)) ok('il check intra-day rileva l apertura oltre soglia');
    else fail('il check intra-day rileva l apertura oltre soglia', { rilevati: stale.length });

    // 5. Un errore di query NON deve degradare a "nessuna uscita mancante":
    //    è esattamente così che il bug è rimasto invisibile.
    let sollevato = false;
    try {
      await checkCompany('non-un-uuid', todayRome());
    } catch { sollevato = true; }
    if (sollevato) ok('una query fallita solleva un errore invece di restituire lista vuota');
    else fail('una query fallita solleva un errore invece di restituire lista vuota');

    // 6. Stesso bug, stesso endpoint admin (solo con credenziali E2E).
    if (EMAIL && PASSWORD) {
      const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
      const { data: sess, error: authErr } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
      if (authErr) {
        fail('login bot E2E', authErr.message);
      } else {
        const res = await fetch(`${BASE}/api/v1/presence/open-sessions`, {
          headers: { Authorization: `Bearer ${sess.session.access_token}`, 'X-Company-Id': COMPANY_ID },
        }).catch(e => ({ status: 0, json: async () => ({ error: e.message }) }));
        const body = await res.json().catch(() => null);
        const riga = body?.open_sessions?.find(s => s.worker_id === aperto.id);
        if (res.status === 200 && riga && riga.site_name === site.name) ok('GET /presence/open-sessions risponde 200 con la sessione aperta e il nome cantiere');
        else fail('GET /presence/open-sessions risponde 200 con la sessione aperta e il nome cantiere', { status: res.status, body });
      }
    } else {
      console.log('  \x1b[33m-\x1b[0m GET /presence/open-sessions saltato (E2E_EMAIL/E2E_PASSWORD non configurati)');
    }
  } finally {
    await cleanup(site.id, [aperto, chiuso]);
  }

  report();
}

async function cleanup(siteId, workers) {
  if (siteId) {
    await supabase.from('presence_logs').delete().eq('site_id', siteId);
    await supabase.from('sites').delete().eq('id', siteId);
  }
  for (const w of workers || []) if (w?.id) await supabase.from('workers').delete().eq('id', w.id);
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_missing_exit_detection:', e.message);
  process.exit(1);
});
