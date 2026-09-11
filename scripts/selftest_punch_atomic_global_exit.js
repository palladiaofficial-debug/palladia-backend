#!/usr/bin/env node
/**
 * scripts/selftest_punch_atomic_global_exit.js
 *
 * Regressione per F-172 (AUDIT.md, 2026-09-11, sweep completo timbrature):
 * la funzione SQL `punch_atomic` decideva ENTRY/EXIT guardando SOLO
 * l'ultimo evento sullo STESSO cantiere. Un lavoratore entrato al
 * cantiere A e poi in uscita da un cantiere B mai toccato prima (es.
 * magazzino, o qualunque cantiere diverso entro il proprio raggio)
 * otteneva: ENTRY fantasma a B (mai richiesta) + EXIT automatico
 * corretto ad A — l'ENTRY a B restava "in corso" finché la guardia
 * anti-turno-fantasma (16h) non la chiudeva da sola con 9h FABBRICATE
 * su un cantiere dove il lavoratore non ha mai lavorato.
 *
 * Fix (migrations/201): la decisione è ora GLOBALE per lavoratore — un
 * tocco su QUALUNQUE cantiere mentre si è aperti altrove chiude sempre
 * quell'apertura (mai una nuova ENTRY altrove).
 *
 * Chiama punch_atomic DIRETTAMENTE via RPC (non attraverso le route
 * HTTP) per isolare la funzione SQL. Uno scenario = un worker nuovo,
 * con lo stato di partenza inserito DIRETTAMENTE (mai tramite un'altra
 * chiamata a punch_atomic) per evitare sia il debounce PUNCH_TOO_SOON
 * (60s) sia UPDATE su presence_logs — la tabella è append-only anche
 * per il service role (migrations/003), quindi anche la pulizia finale
 * NON tenta di cancellare le righe scritte (stesso limite accettato
 * dagli altri selftest di questo repo — "npm test accumula fixture
 * TEST- in produzione", normale, non un errore).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — punch_atomic: decisione ENTRY/EXIT globale per lavoratore (F-172)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('punch_atomic global exit', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F172-PunchAtomic' }]).select('id').single();
  const companyId = company.id;
  const { data: siteA, error: siteAErr } = await admin.from('sites').insert([{ company_id: companyId, name: 'TEST-F172-SiteA', address: 'Via Test A', status: 'attivo' }]).select('id').single();
  if (siteAErr) throw new Error(`siteA: ${siteAErr.message}`);
  const { data: siteB, error: siteBErr } = await admin.from('sites').insert([{ company_id: companyId, name: 'TEST-F172-SiteB', address: 'Via Test B', status: 'attivo' }]).select('id').single();
  if (siteBErr) throw new Error(`siteB: ${siteBErr.message}`);

  const workerIds = [];
  let workerSeq = 0;
  async function makeWorker(label) {
    workerSeq++;
    const uniq = `${Date.now()}${workerSeq}`;
    const { data: w, error } = await admin.from('workers').insert([{
      company_id: companyId, full_name: `TEST-F172-${label}`,
      fiscal_code: `F172${uniq}`.slice(0, 16).toUpperCase(),
      qualification: 'Muratore', is_active: true,
      badge_code: `F172${uniq}${label}`.slice(0, 18).toUpperCase(),
    }]).select('id').single();
    if (error) throw new Error(`makeWorker(${label}): ${error.message}`);
    workerIds.push(w.id);
    return w.id;
  }

  function directLog(workerId, siteId, eventType, tsIso, method) {
    return admin.from('presence_logs').insert([{
      company_id: companyId, site_id: siteId, worker_id: workerId, event_type: eventType,
      timestamp_server: tsIso, method: method || 'worker_self_punch',
    }]);
  }

  function punch(workerId, siteId) {
    return admin.rpc('punch_atomic', {
      p_site_id: siteId, p_worker_id: workerId, p_company_id: companyId, p_session_id: null,
      p_lat: 44.4, p_lon: 8.9, p_distance_m: 0, p_accuracy_m: 10,
      p_ip: '127.0.0.1', p_ua: 'selftest', p_method: 'worker_self_punch',
    });
  }

  try {
    // ── 1. Nessuno stato precedente → prima timbratura è ENTRY ──
    const w1 = await makeWorker('W1');
    const r1 = await punch(w1, siteA.id);
    check('nessuna storia → ENTRY al cantiere toccato', r1.data?.ok === true && r1.data?.event_type === 'ENTRY', r1.data);

    // ── 2. Aperto ad A, tocca B (MAI visitato) → deve chiudere A, non aprire B ──
    const w2 = await makeWorker('W2');
    await directLog(w2, siteA.id, 'ENTRY', new Date(Date.now() - 3600_000).toISOString());
    const r2 = await punch(w2, siteB.id);
    check('F-172: aperto ad A, tocca B mai visitato → EXIT (non ENTRY)',
      r2.data?.ok === true && r2.data?.event_type === 'EXIT', r2.data);
    check('F-172: closed_site_id riporta il cantiere ORIGINALE (A), non quello toccato (B)',
      r2.data?.closed_site_id === siteA.id, r2.data);
    check('F-172: il punch_atomic risponde con site_id = A (dove ha davvero scritto), non B',
      r2.data?.site_id === siteA.id, r2.data);

    const { data: w2Logs } = await admin.from('presence_logs')
      .select('site_id, event_type').eq('worker_id', w2).order('timestamp_server');
    check('F-172: nessuna riga scritta sul cantiere B — solo ENTRY+EXIT su A',
      w2Logs.length === 2 && w2Logs.every(l => l.site_id === siteA.id), w2Logs);

    // ── 3. Già chiuso globalmente (ultimo evento = EXIT) → toccare B è una vera nuova ENTRY ──
    const w3 = await makeWorker('W3');
    await directLog(w3, siteA.id, 'ENTRY', new Date(Date.now() - 7200_000).toISOString());
    await directLog(w3, siteA.id, 'EXIT',  new Date(Date.now() - 3600_000).toISOString());
    const r3 = await punch(w3, siteB.id);
    check('già chiuso globalmente → toccare un nuovo cantiere è una vera ENTRY, senza closed_site_id',
      r3.data?.ok === true && r3.data?.event_type === 'ENTRY' && !r3.data?.closed_site_id, r3.data);

    // ── 4. Uscita normale sullo STESSO cantiere dove si è aperti → comportamento invariato ──
    const w4 = await makeWorker('W4');
    await directLog(w4, siteB.id, 'ENTRY', new Date(Date.now() - 3600_000).toISOString());
    const r4 = await punch(w4, siteB.id);
    check('uscita normale sullo stesso cantiere → EXIT, closed_site_id assente (non "altrove")',
      r4.data?.ok === true && r4.data?.event_type === 'EXIT' && !r4.data?.closed_site_id, r4.data);

    // ── 5. PUNCH_TOO_SOON invariato (debounce 60s), ora globale ──
    const w5 = await makeWorker('W5');
    await directLog(w5, siteA.id, 'ENTRY', new Date(Date.now() - 10_000).toISOString());
    const r5 = await punch(w5, siteB.id);
    check('ultimo evento (su un ALTRO cantiere) a meno di 60s → PUNCH_TOO_SOON anche qui',
      r5.data?.ok === false && r5.data?.error === 'PUNCH_TOO_SOON', r5.data);

    // ── 6. Guardia anti-turno-fantasma (16h) — ora globale, non per-sito ──
    const w6 = await makeWorker('W6');
    await directLog(w6, siteA.id, 'ENTRY', new Date(Date.now() - 20 * 3600_000).toISOString());
    const r6 = await punch(w6, siteB.id);
    check('F-172: ENTRY vecchia (20h, altro cantiere) → chiusa come stale, il tocco è una nuova ENTRY a B',
      r6.data?.ok === true && r6.data?.event_type === 'ENTRY' && r6.data?.auto_closed_stale === true, r6.data);

    const { data: w6Logs } = await admin.from('presence_logs')
      .select('site_id, event_type, method').eq('worker_id', w6).order('timestamp_server');
    check('la vecchia ENTRY su A è stata chiusa con auto_exit_stale_before_reopen, sullo stesso cantiere A',
      w6Logs.some(l => l.site_id === siteA.id && l.event_type === 'EXIT' && l.method === 'auto_exit_stale_before_reopen'), w6Logs);
    check('la nuova ENTRY è davvero su B',
      w6Logs.some(l => l.site_id === siteB.id && l.event_type === 'ENTRY'), w6Logs);

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
