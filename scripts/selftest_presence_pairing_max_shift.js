#!/usr/bin/env node
/**
 * scripts/selftest_presence_pairing_max_shift.js
 *
 * Regressione per F-153 (AUDIT.md): pairLogsByDay() accoppiava sequenzialmente
 * qualunque ENTRY seguita da un EXIT, senza alcun controllo sulla durata —
 * dati vecchi/corrotti (un ENTRY mai chiusa + un EXIT lontano, es. una
 * correzione manuale con la data sbagliata) venivano sommati come un unico
 * "turno" di giorni interi nelle ore lavorate/straordinari di TUTTI i report
 * (PDF Registro, PDF/XLSX Ore Lavorate, CSV, badge in pagina).
 *
 * Caso reale osservato in produzione (MSCedilizia S.r.l., Di Leonardo
 * Giuseppe, stesso worker già flagato in F-043/migrations/161 per lo stesso
 * pattern lato punch_atomic, mai risolto lato report): ENTRY 04/08 09:41 →
 * EXIT 10/08 05:21 (5g19h40m) e ENTRY 10/08 05:24 → EXIT 14/08 08:30/admin
 * (4g03h06m) venivano sommati come ~150h lavorate in un giorno solo,
 * gonfiando "Ore Totali" e "Straordinari" del report Ore Lavorate.
 *
 * Fix: pairLogsByDay() ora rifiuta un accoppiamento ENTRY→EXIT la cui durata
 * supera 16h (stesso limite di punch_atomic, migrations/161) — l'ENTRY
 * diventa orfana sul proprio giorno, l'EXIT orfana sul suo.
 *
 * Test puro, nessuna dipendenza da rete/DB — gira sempre.
 */
'use strict';
const { pairLogsByDay } = require('../lib/presencePairing');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function log(eventType, iso, method = 'worker_self_punch') {
  return { event_type: eventType, timestamp_server: iso, method };
}

console.log('\nPalladia regression — pairLogsByDay rifiuta accoppiamenti oltre 16h (F-153)\n');

// ── Caso reale: turno "fantasma" di più giorni ─────────────────────────────
{
  const logs = [
    log('ENTRY', '2026-08-04T09:41:00+00:00'),
    log('EXIT',  '2026-08-10T05:21:00+00:00'),                      // 5g19h40m dopo — implausibile
    log('ENTRY', '2026-08-10T05:24:00+00:00'),
    log('EXIT',  '2026-08-14T08:30:00+00:00', 'admin_manual_correction'), // 4g03h06m dopo — implausibile
  ];
  const dayMap = pairLogsByDay(logs);

  let totalPairs = 0, totalOrphanEntries = 0, totalOrphanExits = 0;
  for (const bucket of dayMap.values()) {
    totalPairs += bucket.pairs.length;
    totalOrphanEntries += bucket.orphanEntries.length;
    totalOrphanExits += bucket.orphanExits.length;
  }
  check('nessuna coppia valida creata (entrambi gli accoppiamenti superano 16h)', totalPairs === 0, { totalPairs, dayMap: [...dayMap.entries()] });
  check('entrambi gli ENTRY diventano orfani (nessuna EXIT abbinata a un turno impossibile)', totalOrphanEntries === 2, totalOrphanEntries);
  check('entrambi gli EXIT diventano orfani (mai sommati come chiusura di un turno lontano)', totalOrphanExits === 2, totalOrphanExits);

  const day0804 = dayMap.get('2026-08-04');
  check('ENTRY del 04/08 è orfana sul proprio giorno (04/08), non spostata al giorno dell\'EXIT lontana', day0804?.orphanEntries.length === 1, day0804);

  const day0814 = dayMap.get('2026-08-14');
  check('EXIT del 14/08 è orfana sul proprio giorno (14/08)', day0814?.orphanExits.length === 1, day0814);
}

// ── Turno normale (entro 16h) resta una coppia valida ──────────────────────
{
  const logs = [
    log('ENTRY', '2026-09-08T07:37:00+02:00'),
    log('EXIT',  '2026-09-08T17:01:00+02:00'), // 9h24m — plausibile
  ];
  const dayMap = pairLogsByDay(logs);
  const day = dayMap.get('2026-09-08');
  check('turno normale (9h24m) resta una coppia valida', day?.pairs.length === 1 && day.orphanEntries.length === 0 && day.orphanExits.length === 0, day);
}

// ── Turno lungo ma plausibile (es. straordinario notturno, 15h) resta valido ──
{
  const logs = [
    log('ENTRY', '2026-09-08T06:00:00+02:00'),
    log('EXIT',  '2026-09-08T21:00:00+02:00'), // 15h — sotto soglia
  ];
  const dayMap = pairLogsByDay(logs);
  const day = dayMap.get('2026-09-08');
  check('turno lungo ma sotto soglia (15h) resta una coppia valida', day?.pairs.length === 1, day);
}

// ── Esattamente al limite (16h) resta valido; appena sopra no ──────────────
{
  const exactly16h = pairLogsByDay([
    log('ENTRY', '2026-09-08T06:00:00+02:00'),
    log('EXIT',  '2026-09-08T22:00:00+02:00'), // esattamente 16h
  ]);
  check('esattamente 16h → ancora una coppia valida (soglia inclusiva)', exactly16h.get('2026-09-08')?.pairs.length === 1, [...exactly16h.entries()]);

  const over16h = pairLogsByDay([
    log('ENTRY', '2026-09-08T06:00:00+02:00'),
    log('EXIT',  '2026-09-08T22:00:01+02:00'), // 16h e 1 secondo
  ]);
  const b = over16h.get('2026-09-08');
  check('16h e 1 secondo → NON una coppia (sopra soglia)', b?.pairs.length === 0 && b?.orphanEntries.length === 1, b);
}

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exitCode = failed > 0 ? 1 : 0;
