#!/usr/bin/env node
/**
 * scripts/selftest_late_entry_deduction.js
 *
 * Regressione per la nuova regola ritardo ingresso (2026-09-10, migrations/199):
 * un ingresso oltre una soglia di tolleranza rispetto all'orario di inizio
 * turno previsto comporta una detrazione forfettaria dalle ore lavorate del
 * giorno — sempre annotata nel resoconto (mai una detrazione silenziosa).
 *
 * A differenza della pausa pranzo (sempre attiva con un default, F-152), la
 * regola parte SPENTA per ogni azienda: shift_start_time null = nessuna
 * detrazione possibile, a prescindere da soglia/detrazione — un default
 * "silenzioso" rischierebbe di detrarre stipendio reale a chi non ha mai
 * deciso di attivare la regola.
 *
 * lib/presencePairing.js::applyLateEntryDeduction è l'unico punto che la
 * implementa, usato da tutti i generatori di report (services/workerHoursReport.js,
 * services/presenceReport.js, routes/v1/reports.js) — stesso principio già
 * stabilito per applyLunchBreak (F-148/F-152, AUDIT.md).
 *
 * Test puri, nessuna dipendenza da rete/DB — girano sempre.
 */
'use strict';
const { resolveLateEntryConfig, applyLateEntryDeduction } = require('../lib/presencePairing');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function log(eventType, hhmm, day = '2026-09-10') {
  return { event_type: eventType, timestamp_server: `${day}T${hhmm}:00+02:00` };
}
function pairWithMinutes(entryHHMM, exitHHMM, rawMinutes, day = '2026-09-10') {
  return { entry: log('ENTRY', entryHHMM, day), exit: log('EXIT', exitHHMM, day), minutes: rawMinutes };
}

console.log('\nPalladia regression — detrazione ritardo ingresso (migrations/199)\n');

// ── resolveLateEntryConfig ─────────────────────────────────────────────────
{
  const cfg = resolveLateEntryConfig({ shift_start_time: null, late_entry_threshold_minutes: 5, late_entry_deduction_minutes: 30 }, null);
  check('shift_start_time NULL a livello azienda → regola disattivata (shiftStart null)', cfg.shiftStart === null, cfg);
}
{
  const cfg = resolveLateEntryConfig({ shift_start_time: '08:00:00', late_entry_threshold_minutes: 5, late_entry_deduction_minutes: 30 }, null);
  check('nessun override sito → usa il default azienda (08:00, normalizzato da HH:MM:SS)', cfg.shiftStart === '08:00' && cfg.thresholdMinutes === 5 && cfg.deductionMinutes === 30, cfg);
}
{
  const cfg = resolveLateEntryConfig(
    { shift_start_time: '08:00:00', late_entry_threshold_minutes: 5, late_entry_deduction_minutes: 30 },
    { shift_start_time: '07:30:00', late_entry_threshold_minutes: 10, late_entry_deduction_minutes: 15 }
  );
  check('override sito impostato → vince sul default azienda', cfg.shiftStart === '07:30' && cfg.thresholdMinutes === 10 && cfg.deductionMinutes === 15, cfg);
}
{
  const cfg = resolveLateEntryConfig(
    { shift_start_time: '08:00:00', late_entry_threshold_minutes: 5, late_entry_deduction_minutes: 30 },
    { shift_start_time: null, late_entry_threshold_minutes: null, late_entry_deduction_minutes: null }
  );
  check('override sito NULL → eredita comunque il default azienda (non disattiva la regola)', cfg.shiftStart === '08:00' && cfg.thresholdMinutes === 5, cfg);
}
{
  const cfg = resolveLateEntryConfig(undefined, undefined);
  check('nessuna company/site (fallback estremo) → regola disattivata, soglia/detrazione ai default 5/30', cfg.shiftStart === null && cfg.thresholdMinutes === 5 && cfg.deductionMinutes === 30, cfg);
}

// ── applyLateEntryDeduction ────────────────────────────────────────────────
const CFG_OFF      = { shiftStart: null, thresholdMinutes: 5, deductionMinutes: 30 };
const CFG_STANDARD = { shiftStart: '08:00', thresholdMinutes: 5, deductionMinutes: 30 };

{
  const pairs = [pairWithMinutes('08:20', '17:00', 520)];
  const result = applyLateEntryDeduction(pairs, CFG_OFF);
  check('regola disattivata (shiftStart null) → nessuna detrazione anche con ingresso molto in ritardo',
    result[0].minutes === 520 && result[0].lateDeductionMinutes === 0, result);
}
{
  // Ingresso alle 08:04, soglia 5 minuti → entro tolleranza, nessuna detrazione.
  const pairs = [pairWithMinutes('08:04', '17:00', 536)];
  const result = applyLateEntryDeduction(pairs, CFG_STANDARD);
  check('ingresso 4min dopo l\'orario previsto (soglia 5min) → entro tolleranza, nessuna detrazione',
    result[0].minutes === 536 && result[0].lateDeductionMinutes === 0 && result[0].lateMinutes === 4, result);
}
{
  // Esattamente alla soglia (5min): non oltre, nessuna detrazione (soglia inclusiva/non superata).
  const pairs = [pairWithMinutes('08:05', '17:00', 535)];
  const result = applyLateEntryDeduction(pairs, CFG_STANDARD);
  check('ingresso esattamente alla soglia (5min) → nessuna detrazione (va OLTRE la soglia per scattare)',
    result[0].lateDeductionMinutes === 0, result);
}
{
  // Oltre soglia: 08:12, 7 minuti oltre i 5 di tolleranza → detratti 30min.
  const pairs = [pairWithMinutes('08:12', '17:00', 528)];
  const result = applyLateEntryDeduction(pairs, CFG_STANDARD);
  check('ingresso 12min dopo (7min oltre soglia) → detratti 30min, lateMinutes=12',
    result[0].minutes === 498 && result[0].lateDeductionMinutes === 30 && result[0].lateMinutes === 12, result);
}
{
  // La detrazione si applica SOLO alla prima coppia del giorno, non alle successive.
  const pairs = [
    pairWithMinutes('08:20', '12:00', 220),
    pairWithMinutes('13:00', '17:00', 240),
  ];
  const result = applyLateEntryDeduction(pairs, CFG_STANDARD);
  check('2 coppie: detrazione solo sulla prima (arrivo del giorno), la seconda resta intatta',
    result[0].lateDeductionMinutes === 30 && result[0].minutes === 190
    && result[1].lateDeductionMinutes === 0 && result[1].minutes === 240, result);
}
{
  // Deduzione mai superiore al turno grezzo (turno cortissimo, appena sopra la soglia).
  const pairs = [pairWithMinutes('08:20', '08:35', 15)];
  const result = applyLateEntryDeduction(pairs, CFG_STANDARD);
  check('turno cortissimo (15min) con ritardo → detrazione clampata a 15min, mai sotto zero',
    result[0].minutes === 0 && result[0].lateDeductionMinutes === 15, result);
}
{
  // Ingresso PRIMA dell'orario previsto: lateMinutes negativo, nessuna detrazione.
  const pairs = [pairWithMinutes('07:45', '17:00', 555)];
  const result = applyLateEntryDeduction(pairs, CFG_STANDARD);
  check('ingresso in anticipo → nessuna detrazione, lateMinutes riportato a 0 (mai negativo)',
    result[0].lateDeductionMinutes === 0 && result[0].lateMinutes === 0, result);
}
{
  const result = applyLateEntryDeduction([], CFG_STANDARD);
  check('nessuna coppia → array vuoto, nessun errore', Array.isArray(result) && result.length === 0, result);
}

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exitCode = failed > 0 ? 1 : 0;
