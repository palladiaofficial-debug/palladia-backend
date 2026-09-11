#!/usr/bin/env node
/**
 * scripts/selftest_get_worker_detail_fiscal_code_leak.js
 *
 * Test di regressione per F-173 (AUDIT.md, 2026-09-11): il tool
 * get_worker_detail (routes/v1/chat.js) includeva `codice_fiscale:
 * w.fiscal_code` nell'oggetto restituito — che diventa il `content` di un
 * blocco tool_result rimandato dentro la conversazione con l'API Anthropic
 * (runChatLoop, chat.js:5883-5889) ogni volta che qualcuno chiede il
 * dettaglio di un lavoratore. Nessuna minimizzazione: il tool non ha bisogno
 * del codice fiscale per rispondere a scadenze/compliance/cantieri assegnati.
 *
 * Verifica diretta chiamando executeTool('get_worker_detail', ...) — lo
 * stesso percorso usato dal loop agentico — su un worker fixture con un
 * fiscal_code noto, e ispeziona l'oggetto letteralmente restituito (non solo
 * la chiave `codice_fiscale`: cerca la stringa del codice fiscale ovunque
 * nella risposta, per non passare per il motivo sbagliato se il campo venisse
 * solo rinominato).
 *
 * Env:
 *   E2E_COMPANY_ID   Default: fda73bf5-403a-4a0e-be6d-501e3f3c5c4d
 *   E2E_USER_ID      Owner della company E2E — nessun default, obbligatorio
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { executeTool } = require('../routes/v1/chat');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const USER_ID    = process.env.E2E_USER_ID || '';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

function randomFiscalCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 'TST';
  for (let i = 0; i < 13; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function main() {
  if (!USER_ID) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_get_worker_detail_fiscal_code_leak: E2E_USER_ID non configurato.');
    return;
  }

  console.log('\n\x1b[1mget_worker_detail — F-173: il codice fiscale non deve comparire nel tool_result\x1b[0m');

  const fiscalCode = randomFiscalCode();
  const { data: worker, error: wErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-E2E-F173 Worker', fiscal_code: fiscalCode, is_active: true,
    badge_code: require('crypto').randomBytes(9).toString('hex').toUpperCase(),
  }).select('id').single();
  if (wErr) { fail('setup worker fixture con fiscal_code noto', wErr.message); return report(); }

  const result = await executeTool('get_worker_detail', { worker_id: worker.id }, COMPANY_ID, USER_ID, null, null);
  const serialized = JSON.stringify(result);

  if (!serialized.includes(fiscalCode)) {
    ok('il tool_result di get_worker_detail NON contiene il codice fiscale in nessun campo');
  } else {
    fail('il tool_result di get_worker_detail NON contiene il codice fiscale in nessun campo', result);
  }

  if (result?.nome === 'TEST-E2E-F173 Worker') {
    ok('il resto del profilo (nome) resta presente — non un fallimento del tool intero');
  } else {
    fail('il resto del profilo (nome) resta presente — non un fallimento del tool intero', result);
  }

  await supabase.from('workers').delete().eq('id', worker.id);
  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_get_worker_detail_fiscal_code_leak:', e.message);
  process.exit(1);
});
