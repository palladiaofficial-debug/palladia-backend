#!/usr/bin/env node
/**
 * scripts/selftest_lunch_break_deduction.js
 *
 * Regressione per F-152 (AUDIT.md): un turno unico ENTRY->EXIT continuo (es.
 * 07:37->17:01 = 9h24m) veniva conteggiato per intero nelle ore lavorate —
 * l'unico modo per escludere la pausa pranzo era che il lavoratore timbrasse
 * davvero un'uscita/rientro. Migrazione 195 aggiunge una detrazione forfettaria
 * configurabile per azienda/cantiere; lib/presencePairing.js::applyLunchBreak
 * è l'unico punto che la implementa, usato da tutti i generatori di report
 * (services/workerHoursReport.js, services/presenceReport.js, routes/v1/reports.js).
 *
 * Test puri, nessuna dipendenza da rete/DB — girano sempre.
 */
'use strict';
const { resolveLunchBreakConfig, applyLunchBreak } = require('../lib/presencePairing');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function log(eventType, hhmm, day = '2026-09-08') {
  return { event_type: eventType, timestamp_server: `${day}T${hhmm}:00+02:00` };
}

console.log('\nPalladia regression — detrazione pausa pranzo automatica (F-152)\n');

// ── resolveLunchBreakConfig ────────────────────────────────────────────────
{
  const cfg = resolveLunchBreakConfig({ lunch_break_minutes: 30, lunch_break_threshold_hours: 6 }, null);
  check('nessun override sito → usa il default azienda', cfg.minutes === 30 && cfg.thresholdMinutes === 360, cfg);
}
{
  const cfg = resolveLunchBreakConfig(
    { lunch_break_minutes: 30, lunch_break_threshold_hours: 6 },
    { lunch_break_minutes: 45, lunch_break_threshold_hours: 5 }
  );
  check('override sito impostato → vince sul default azienda', cfg.minutes === 45 && cfg.thresholdMinutes === 300, cfg);
}
{
  const cfg = resolveLunchBreakConfig(
    { lunch_break_minutes: 30, lunch_break_threshold_hours: 6 },
    { lunch_break_minutes: null, lunch_break_threshold_hours: null }
  );
  check('override sito NULL → eredita comunque il default azienda', cfg.minutes === 30 && cfg.thresholdMinutes === 360, cfg);
}
{
  const cfg = resolveLunchBreakConfig(undefined, undefined);
  check('nessuna company/site (fallback estremo) → default 60min/6h', cfg.minutes === 60 && cfg.thresholdMinutes === 360, cfg);
}

// ── applyLunchBreak — il caso del bug reale ────────────────────────────────
const CFG_STANDARD = { minutes: 30, thresholdMinutes: 360 }; // 30m sopra 6h

{
  // Esatto scenario segnalato dall'utente: 07:37 -> 17:01, singola coppia.
  const pairs = [{ entry: log('ENTRY', '07:37'), exit: log('EXIT', '17:01') }];
  const result = applyLunchBreak(pairs, CFG_STANDARD);
  check('turno singolo continuo sopra soglia (9h24m) → detratti 30m',
    result.length === 1 && result[0].minutes === 534 && result[0].lunchBreakMinutes === 30, result);
}

{
  // Turno breve, sotto soglia: nessuna detrazione.
  const pairs = [{ entry: log('ENTRY', '08:00'), exit: log('EXIT', '13:30') }]; // 5h30m < 6h
  const result = applyLunchBreak(pairs, CFG_STANDARD);
  check('turno singolo sotto soglia (5h30m) → nessuna detrazione',
    result[0].minutes === 330 && result[0].lunchBreakMinutes === 0, result);
}

{
  // Turno esattamente alla soglia: nessuna detrazione (soglia esclusiva).
  const pairs = [{ entry: log('ENTRY', '08:00'), exit: log('EXIT', '14:00') }]; // esattamente 6h
  const result = applyLunchBreak(pairs, CFG_STANDARD);
  check('turno esattamente alla soglia (6h) → nessuna detrazione',
    result[0].minutes === 360 && result[0].lunchBreakMinutes === 0, result);
}

{
  // Lavoratore ha GIÀ timbrato una pausa reale (2 coppie): nessuna doppia detrazione.
  const pairs = [
    { entry: log('ENTRY', '07:37'), exit: log('EXIT', '12:30') },
    { entry: log('ENTRY', '13:00'), exit: log('EXIT', '17:01') },
  ];
  const result = applyLunchBreak(pairs, CFG_STANDARD);
  const totalMin = result.reduce((s, r) => s + r.minutes, 0);
  check('2 coppie (pausa reale già timbrata) → nessuna detrazione automatica aggiuntiva',
    result.every(r => r.lunchBreakMinutes === 0) && totalMin === 293 + 241, { result, totalMin });
}

{
  // Detrazione disattivata (minutes=0): comportamento invariato (grezzo).
  const pairs = [{ entry: log('ENTRY', '07:37'), exit: log('EXIT', '17:01') }];
  const result = applyLunchBreak(pairs, { minutes: 0, thresholdMinutes: 360 });
  check('lunch_break_minutes=0 (disattivato) → ore grezze invariate',
    result[0].minutes === 564 && result[0].lunchBreakMinutes === 0, result);
}

{
  // Deduzione mai superiore al turno grezzo (turno appena sopra soglia).
  const pairs = [{ entry: log('ENTRY', '08:00'), exit: log('EXIT', '14:05') }]; // 6h05m
  const result = applyLunchBreak(pairs, { minutes: 30, thresholdMinutes: 360 });
  check('turno di poco sopra soglia (6h05m, detrazione 30m) → non va sotto zero',
    result[0].minutes === 335 && result[0].lunchBreakMinutes === 30, result);
}

{
  // Nessuna coppia nel giorno: non deve esplodere.
  const result = applyLunchBreak([], CFG_STANDARD);
  check('nessuna coppia → array vuoto, nessun errore', Array.isArray(result) && result.length === 0, result);
}

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exitCode = failed > 0 ? 1 : 0;
