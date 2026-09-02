#!/usr/bin/env node
/**
 * scripts/selftest_tool_id_validation.js
 *
 * Regressione F-117 (AUDIT.md, LADIA_EVALS 2026-09-02, scenario M02): il
 * modello a volte chiama un tool con site_id/worker_id="placeholder" (o
 * simili, es. "get_from_sites") invece del vero UUID risolto da
 * get_sites/get_workers nello stesso turno — prima di questo fix, il tool
 * lasciava che la query Postgres fallisse con un errore grezzo ("invalid
 * input syntax for type uuid"), un segnale di recupero debole per il
 * modello. Ora executeTool() rifiuta subito, PRIMA di qualunque query, con
 * un messaggio esplicito che dice cosa fare.
 *
 * Comportamento deterministico (non dipende dal modello) — verifica solo
 * che il controllo lato codice scatti per un valore non-UUID e lasci
 * passare un UUID vero o un valore assente.
 *
 * Uso: node scripts/selftest_tool_id_validation.js
 */
'use strict';
require('dotenv').config();

const { executeTool } = require('../routes/v1/chat');

const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== F-117: site_id/worker_id non-UUID rifiutati subito, con istruzione chiara ===\n');

  const placeholderResult = await executeTool('get_sal_history', { site_id: 'placeholder' }, COMPANY_ID, null);
  check('site_id="placeholder" viene rifiutato', !!placeholderResult.error, placeholderResult);
  check('il messaggio indica quale tool chiamare per risolvere il vero id', /get_sites/.test(placeholderResult.error || ''), placeholderResult);
  check('nessun errore Postgres grezzo (invalid input syntax) in risposta', !/invalid input syntax/i.test(placeholderResult.error || ''), placeholderResult);

  const weirdResult = await executeTool('get_sal_history', { site_id: 'get_from_sites' }, COMPANY_ID, null);
  check('anche un placeholder "creativo" (es. "get_from_sites") viene rifiutato', !!weirdResult.error, weirdResult);

  const workerResult = await executeTool('get_worker_hours', { worker_id: 'unknown' }, COMPANY_ID, null);
  check('worker_id non-UUID viene rifiutato con riferimento a get_workers', !!workerResult.error && /get_workers/.test(workerResult.error), workerResult);

  const validResult = await executeTool('get_sites', {}, COMPANY_ID, null);
  check('un tool senza site_id (get_sites stesso) non viene toccato dal controllo', Array.isArray(validResult.sites), validResult);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('Errore fatale:', e); process.exitCode = 1; });
