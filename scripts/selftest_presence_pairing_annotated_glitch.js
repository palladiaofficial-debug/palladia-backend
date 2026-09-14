#!/usr/bin/env node
/**
 * scripts/selftest_presence_pairing_annotated_glitch.js
 *
 * Regressione per F-184 (AUDIT.md, 2026-09-14): dopo il fix dell'uscita
 * fantasma (retry di rete su un endpoint a toggle), lo storico di
 * presence_logs resta per sempre con l'evento anomalo — append-only per
 * design (migrations/003). Il titolare ha segnalato che sia il registro
 * presenze sia la pagina "Ore Lavorate"/Storico timbrature mostravano
 * Canameti Ibrahim e Raksasoi Suriya come "usciti" pochi minuti dopo
 * l'ingresso, spezzando la giornata in due sessioni invece di una continua
 * ("in corso").
 *
 * Fix: un admin può annotare la riga anomala (POST /presence/:logId/annotate,
 * senza toccare la riga originale). pairLogsByDay() ora ignora un EXIT
 * annotato insieme all'ENTRY di autocorrezione che lo segue immediatamente,
 * così la sessione resta un'unica ENTRY continua invece di frammentarsi.
 * Effetto ZERO se `log.annotation` non è presente — i chiamanti che non
 * arricchiscono la query con le annotazioni si comportano esattamente come
 * prima (opt-in, non un cambio di default).
 *
 * Test puro, nessuna dipendenza da rete/DB — gira sempre.
 */
'use strict';
const { pairLogsByDay } = require('../lib/presencePairing');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function log(eventType, iso, annotation) {
  return { event_type: eventType, timestamp_server: iso, method: 'worker_self_punch', annotation: annotation || null };
}

console.log('\nPalladia regression — pairLogsByDay ignora un EXIT annotato + l\'ENTRY di autocorrezione (F-184)\n');

// ── Caso reale: Canameti Ibrahim, 2026-09-14 ────────────────────────────────
{
  const logs = [
    log('ENTRY', '2026-09-14T05:39:32+00:00'),
    log('EXIT',  '2026-09-14T05:52:55+00:00', { text: 'Falsa uscita per un errore tecnico di rete', annotated_at: '2026-09-14T07:32:32+00:00' }),
    log('ENTRY', '2026-09-14T05:54:01+00:00'),
  ];
  const dayMap = pairLogsByDay(logs);
  const day = dayMap.get('2026-09-14');

  check('nessuna coppia chiusa (l\'EXIT annotata non spezza la sessione)', day?.pairs.length === 0, day);
  check('una sola ENTRY orfana ("in corso"), quella ORIGINALE delle 05:39 — non quella di autocorrezione delle 05:54',
    day?.orphanEntries.length === 1 && day.orphanEntries[0].timestamp_server === '2026-09-14T05:39:32+00:00', day);
  check('nessun EXIT orfano residuo', (day?.orphanExits.length ?? -1) === 0, day);
}

// ── Stesso pattern ma SENZA annotazione → comportamento invariato (il bug com'era) ──
{
  const logs = [
    log('ENTRY', '2026-09-14T05:51:30+00:00'),
    log('EXIT',  '2026-09-14T05:56:14+00:00'), // non annotata
    log('ENTRY', '2026-09-14T05:57:19+00:00'),
  ];
  const dayMap = pairLogsByDay(logs);
  const day = dayMap.get('2026-09-14');

  check('senza annotazione: la sessione resta frammentata come prima — 1 coppia chiusa + 1 ENTRY orfana',
    day?.pairs.length === 1 && day?.orphanEntries.length === 1, day);
  check('la coppia chiusa è quella reale (05:51→05:56)',
    day?.pairs[0]?.entry.timestamp_server === '2026-09-14T05:51:30+00:00' && day.pairs[0]?.exit.timestamp_server === '2026-09-14T05:56:14+00:00', day);
}

// ── EXIT annotata ma SENZA un'ENTRY di autocorrezione subito dopo (giorno finisce lì) →
//    si ignora solo l'EXIT, l'ENTRY originale resta orfana "in corso" ──
{
  const logs = [
    log('ENTRY', '2026-09-14T05:39:32+00:00'),
    log('EXIT',  '2026-09-14T05:52:55+00:00', { text: 'glitch', annotated_at: '2026-09-14T07:32:32+00:00' }),
  ];
  const dayMap = pairLogsByDay(logs);
  const day = dayMap.get('2026-09-14');
  check('EXIT annotata senza ENTRY successiva → l\'ENTRY originale resta orfana ("in corso")',
    day?.pairs.length === 0 && day?.orphanEntries.length === 1 && day.orphanEntries[0].timestamp_server === '2026-09-14T05:39:32+00:00', day);
}

// ── Un'EXIT annotata NON deve mai sopprimere una coppia REALE e distinta più avanti ──
{
  const logs = [
    log('ENTRY', '2026-09-14T05:39:32+00:00'),
    log('EXIT',  '2026-09-14T05:52:55+00:00', { text: 'glitch', annotated_at: '2026-09-14T07:32:32+00:00' }),
    log('ENTRY', '2026-09-14T05:54:01+00:00'), // autocorrezione, soppressa insieme all'EXIT sopra
    log('EXIT',  '2026-09-14T15:00:00+00:00'), // uscita VERA di fine giornata, non annotata
  ];
  const dayMap = pairLogsByDay(logs);
  const day = dayMap.get('2026-09-14');
  check('la giornata risulta un\'unica coppia continua: ENTRY originale (05:39) → EXIT vera di fine giornata (15:00)',
    day?.pairs.length === 1 && day.pairs[0].entry.timestamp_server === '2026-09-14T05:39:32+00:00' && day.pairs[0].exit.timestamp_server === '2026-09-14T15:00:00+00:00', day);
  check('nessuna ENTRY/EXIT orfana residua', day?.orphanEntries.length === 0 && day?.orphanExits.length === 0, day);
}

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exitCode = failed > 0 ? 1 : 0;
