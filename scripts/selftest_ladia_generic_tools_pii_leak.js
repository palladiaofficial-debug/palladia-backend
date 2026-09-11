#!/usr/bin/env node
/**
 * scripts/selftest_ladia_generic_tools_pii_leak.js
 *
 * Test di regressione per F-174 (AUDIT.md, 2026-09-11): createRecord/
 * updateRecord in lib/ladiaGenericTools.js rileggono la riga scritta con
 * `.select().single()` — nessuna whitelist — e restituiscono l'intera riga
 * come `record` nella risposta del tool. Per `workers` questo espone nel
 * `tool_result` (che rientra nella conversazione mandata all'API Anthropic
 * a runChatLoop, chat.js:5883-5889) campi mai richiesti dal chiamante:
 * badge_code (credenziale a 72 bit del badge digitale anticontraffazione,
 * generata server-side proprio nello stesso momento), birth_date,
 * birth_place, photo_url, tariffa_oraria.
 *
 * Verifica diretta sulla funzione (non via API Anthropic, non via HTTP) —
 * chiama createRecord/updateRecord esattamente come fa executeTool() in
 * chat.js per i tool create_record/update_record, e ispeziona l'oggetto
 * `record` letteralmente restituito.
 *
 * Usa la company E2E dedicata (stessa di selftest_ladia_write_executor.js) —
 * crea ed elimina il proprio worker di test, non tocca nulla di preesistente.
 *
 * Env:
 *   E2E_COMPANY_ID   Default: fda73bf5-403a-4a0e-be6d-501e3f3c5c4d
 *   E2E_USER_ID      Owner della company E2E — nessun default, obbligatorio
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { createRecord, updateRecord } = require('../lib/ladiaGenericTools');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const USER_ID    = process.env.E2E_USER_ID || '';

// Campi che non hanno alcuna ragione di comparire nel tool_result mandato a
// Ladia per una create/update generica — non richiesti dal chiamante, non
// necessari al riepilogo, e in almeno un caso (badge_code) una credenziale.
const FORBIDDEN_FIELDS = ['badge_code', 'birth_date', 'birth_place', 'photo_url', 'tariffa_oraria', 'area_pin_hash'];

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

function leakedFields(record) {
  if (!record || typeof record !== 'object') return [];
  return FORBIDDEN_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(record, f) && record[f] !== null && record[f] !== undefined);
}

function randomFiscalCode() {
  // 16 char alfanumerici — formato accettato da isValidFiscalCode, non un CF
  // reale di nessuno (fixture di test).
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 'TST';
  for (let i = 0; i < 13; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function main() {
  if (!USER_ID) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_ladia_generic_tools_pii_leak: E2E_USER_ID non configurato.');
    return;
  }

  console.log('\n\x1b[1mladiaGenericTools — F-174: dati non richiesti nel tool_result di create/update workers\x1b[0m');

  const fiscalCode = randomFiscalCode();
  let workerId = null;

  // 1. createRecord('workers', ...) — solo full_name/fiscal_code in input,
  // come farebbe Ladia per "aggiungi un lavoratore". badge_code viene
  // generato server-side (ladiaSchemaRegistry.js:39-43) nello stesso identico
  // giro — la riga letta indietro con select().single() lo include sempre.
  const r1 = await createRecord('workers', {
    full_name: 'TEST-E2E-F174 Worker', fiscal_code: fiscalCode,
  }, COMPANY_ID, USER_ID, null, {});

  if (!r1.success) { fail('createRecord(workers) esegue con successo', r1); return report(); }
  workerId = r1.record?.id;

  const leak1 = leakedFields(r1.record);
  if (leak1.length === 0) {
    ok('createRecord(workers): record restituito NON contiene badge_code/birth_date/birth_place/photo_url/tariffa_oraria');
  } else {
    fail(`createRecord(workers): record restituito espone campi non richiesti [${leak1.join(', ')}]`, r1.record);
  }

  // 2. updateRecord('workers', ..., {safety_training_expiry}) — un solo campo
  // cambiato, sensitivity 'medium' quindi richiede confirmed:true (stesso
  // gate che affronterebbe Ladia dopo la conferma dell'utente). La riga letta
  // indietro con select().single() include comunque l'intera riga workers,
  // non solo il campo appena scritto.
  if (workerId) {
    const r2 = await updateRecord('workers', workerId, {
      safety_training_expiry: '2099-01-01',
    }, COMPANY_ID, USER_ID, null, { confirmed: true });

    if (!r2.success) { fail('updateRecord(workers) esegue con successo', r2); }
    else {
      const leak2 = leakedFields(r2.record);
      if (leak2.length === 0) {
        ok('updateRecord(workers): record restituito NON contiene badge_code/birth_date/birth_place/photo_url/tariffa_oraria');
      } else {
        fail(`updateRecord(workers): record restituito espone campi non richiesti [${leak2.join(', ')}]`, r2.record);
      }
    }
  }

  // 3. Conferma indipendente sul DB: badge_code esiste davvero sulla riga
  // (non è che il campo è vuoto per questo worker fixture) — altrimenti il
  // test 1 passerebbe per il motivo sbagliato (campo assente, non filtrato).
  if (workerId) {
    const { data: dbRow } = await supabase.from('workers').select('badge_code').eq('id', workerId).maybeSingle();
    if (dbRow?.badge_code) {
      ok('verifica DB: badge_code è stato davvero generato sulla riga (il test 1/2 non passa per assenza del dato)');
    } else {
      fail('verifica DB: badge_code è stato davvero generato sulla riga', dbRow);
    }
  }

  // Cleanup
  if (workerId) await supabase.from('workers').delete().eq('id', workerId);

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_ladia_generic_tools_pii_leak:', e.message);
  process.exit(1);
});
