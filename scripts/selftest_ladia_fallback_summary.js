#!/usr/bin/env node
/**
 * scripts/selftest_ladia_fallback_summary.js
 *
 * Regressione per F-080 (AUDIT.md): quando il loop agentico di Ladia esaurisce
 * il tetto di 6 round di tool-use prima che il modello emetta un blocco di
 * testo finale, il fallback generico "non sono riuscito a elaborare la
 * risposta" nascondeva scritture già riuscite — riprodotto dal vivo il
 * 25/08/2026 (gate di lancio, giorno 3): un lavoratore creato con successo
 * (confermato via query diretta al DB), poi Ladia lo ha negato nel turno
 * successivo. Test puro sulla funzione di estrazione, nessuna rete/DB.
 */
'use strict';
const { extractSuccessfulWriteSummaries } = require('../lib/ladiaFallbackSummary');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function main() {
  console.log('\nPalladia regression — F-080: scritture riuscite non nascoste dal fallback del loop agentico\n');

  // Forma esatta osservata riproducendo dal vivo (createRecord reale su
  // 'workers', vedi lib/ladiaGenericTools.js:115).
  const createWorkerResult = JSON.stringify({
    success: true, record: { id: 'abc', full_name: 'TEST-Mario Rossi' },
    actionHistoryId: 'hist-1', undoSummary: 'Creato lavoratore TEST-Mario Rossi',
    resource: 'workers', action: 'create', undoable: false,
  });
  const readOnlyResult = JSON.stringify({ workers: [{ id: 'x' }] }); // tool di lettura, nessun success/summary
  const failedWriteResult = JSON.stringify({ error: 'VALIDATION_ERROR' });
  const malformed = 'non è json valido {{{';

  check(
    'una scrittura riuscita viene estratta con il suo riepilogo',
    JSON.stringify(extractSuccessfulWriteSummaries([createWorkerResult])) === JSON.stringify(['Creato lavoratore TEST-Mario Rossi'])
  );
  check(
    'un tool di sola lettura (nessun success/summary) non produce falsi positivi',
    extractSuccessfulWriteSummaries([readOnlyResult]).length === 0
  );
  check(
    'un tool fallito non produce un riepilogo',
    extractSuccessfulWriteSummaries([failedWriteResult]).length === 0
  );
  check(
    'contenuto non-JSON gestito senza eccezioni, non un falso positivo',
    extractSuccessfulWriteSummaries([malformed]).length === 0
  );
  check(
    'input vuoto/mancante gestito senza eccezioni',
    extractSuccessfulWriteSummaries([]).length === 0 && extractSuccessfulWriteSummaries(undefined).length === 0
  );
  check(
    'più scritture riuscite nello stesso turno vengono tutte raccolte, in ordine',
    JSON.stringify(extractSuccessfulWriteSummaries([createWorkerResult, readOnlyResult, createWorkerResult])) ===
      JSON.stringify(['Creato lavoratore TEST-Mario Rossi', 'Creato lavoratore TEST-Mario Rossi'])
  );
  check(
    'un undo riuscito (summary invece di undoSummary) viene comunque estratto',
    JSON.stringify(extractSuccessfulWriteSummaries([JSON.stringify({ success: true, undone: 'create', summary: 'Annullato — Creato lavoratore X' })])) ===
      JSON.stringify(['Annullato — Creato lavoratore X'])
  );

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
