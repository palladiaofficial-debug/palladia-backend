#!/usr/bin/env node
/**
 * scripts/selftest_report_redesign_palette.js
 *
 * Regressione per F-154 (AUDIT.md, 2026-09-08): redesign dei PDF/Excel
 * "Registro Presenze" e "Report Ore Lavorate" nello stile reale di Palladia
 * (Plus Jakarta Sans, palette dell'app — mockup approvato dall'utente) al
 * posto del navy/Arial generico inventato per questi documenti.
 *
 * Test puro (nessuna chiamata DB/rete): genera l'HTML dei due template PDF e
 * un XLSX minimale con dati fittizi, verifica che la palette/font nuovi
 * siano presenti e che i vecchi valori generici siano spariti.
 */
'use strict';
require('dotenv').config();
const { generatePresenceReportHtml } = require('../services/presenceReport');
const { generateWorkerHoursPdfHtml, generateWorkerHoursXlsx } = require('../services/workerHoursReport');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 200)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

console.log('\nPalladia regression — redesign PDF/Excel Registro & Ore Lavorate (F-154)\n');

// ── Registro Presenze ──────────────────────────────────────────────────────
{
  const data = {
    site: { id: 's1', name: 'TEST-Cantiere', address: 'Via Test 1', geofence_radius_m: 120 },
    company: { name: 'TEST-Azienda' },
    period: { from: '2026-09-08', to: '2026-09-08' },
    generated_at: new Date().toISOString(),
    doc_id: 'test-doc-id',
    total_workers: 1, total_hours: 8, total_punches: 2, anomalies_count: 0,
    max_accuracy_m: 80,
    rows: [{
      dateKey: '2026-09-08', date: '08/09/2026', worker_name: 'TEST Worker', fiscal_code: 'TSTWRK00A00A000A',
      first_entry: '08:00', last_exit: '16:00', hours_total: 8, intervals_count: 1,
      avg_distance_m: 5, avg_accuracy_m: 10, methods: ['worker_self_punch'], anomalies: [],
    }],
  };
  const html = generatePresenceReportHtml(data);
  check('usa Plus Jakarta Sans (font reale Palladia)', html.includes('Plus Jakarta Sans'), null);
  check('usa il blu primario reale (#22384F)', html.includes('#22384F'), null);
  check('metodo "worker_self_punch" mostrato come etichetta breve, non grezzo', html.includes('>Badge<') && !/>worker_self_punch</.test(html), null);
  check('nessun residuo del vecchio navy generico (#1B3A5C)', !html.includes('#1B3A5C'), null);
  check('nessun residuo del vecchio cover-sidebar a tutta altezza', !html.includes('cover-sidebar'), null);
}

// ── Report Ore Lavorate ─────────────────────────────────────────────────────
{
  const data = {
    site: { id: 's1', name: 'TEST-Cantiere', address: '' },
    single_site: true,
    company: { name: 'TEST-Azienda' },
    period: { from: '2026-09-08', to: '2026-09-08', formatted: '08/09/2026' },
    workers: [{
      id: 'w1', full_name: 'TEST Worker', fiscal_code: 'TSTWRK00A00A000A',
      total_days: 1, total_minutes: 480, total_hours: 8, total_hours_str: '8h 00m',
      overtime_minutes: 0, overtime_str: null, overtime_days: 0, lunch_break_minutes: 60,
      days: [{
        date_key: '2026-09-08', date_formatted: '08/09/2026', weekday: 'Mar', site_name: 'TEST-Cantiere',
        entries: [{ entry_time: '08:00', exit_time: '17:00', minutes: 480, hours_str: '8h 00m', anomaly: null, lunch_break_minutes: 60, site_name: 'TEST-Cantiere' }],
        day_total_minutes: 480, day_total_str: '8h 00m', has_anomaly: false, is_overtime: false, overtime_minutes: 0,
        lunch_break_minutes: 60, has_lunch_break_deduction: true,
      }],
    }],
    totals: { workers_count: 1, grand_total_minutes: 480, grand_total_str: '8h 00m', grand_overtime_minutes: 0, grand_overtime_str: null, grand_lunch_break_minutes: 60 },
    generated_at: new Date().toISOString(),
  };
  const html = generateWorkerHoursPdfHtml(data);
  check('usa Plus Jakarta Sans (font reale Palladia)', html.includes('Plus Jakarta Sans'), null);
  check('usa il blu primario reale (#22384F)', html.includes('#22384F'), null);
  check('nessun residuo del vecchio nero/grigio generico (#1a1a1a body color)', !html.includes('color:#1a1a1a;'), null);
}

// ── Excel ────────────────────────────────────────────────────────────────
(async () => {
  const data = {
    site: { id: 's1', name: 'TEST-Cantiere', address: '' },
    single_site: true,
    company: { name: 'TEST-Azienda' },
    period: { from: '2026-09-08', to: '2026-09-08', formatted: '08/09/2026' },
    workers: [{
      id: 'w1', full_name: 'TEST Worker', fiscal_code: 'TSTWRK00A00A000A',
      total_days: 1, total_minutes: 480, total_hours: 8, total_hours_str: '8h 00m',
      overtime_minutes: 30, overtime_str: '0h 30m', overtime_days: 1, lunch_break_minutes: 60,
      days: [{
        date_key: '2026-09-08', date_formatted: '08/09/2026', weekday: 'Mar', site_name: 'TEST-Cantiere',
        entries: [{ entry_time: '08:00', exit_time: '17:30', minutes: 510, hours_str: '8h 30m', anomaly: null, lunch_break_minutes: 60, site_name: 'TEST-Cantiere' }],
        day_total_minutes: 510, day_total_str: '8h 30m', has_anomaly: false, is_overtime: true, overtime_minutes: 30,
        lunch_break_minutes: 60, has_lunch_break_deduction: true,
      }],
    }],
    totals: { workers_count: 1, grand_total_minutes: 510, grand_total_str: '8h 30m', grand_overtime_minutes: 30, grand_overtime_str: '0h 30m', grand_lunch_break_minutes: 60 },
    generated_at: new Date().toISOString(),
  };

  try {
    const buf = await generateWorkerHoursXlsx(data);
    check('Excel generato senza errori', Buffer.isBuffer(buf) && buf.length > 0, buf?.length);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws1 = wb.getWorksheet('Riepilogo');
    const title = ws1.getCell('A1');
    check('titolo Excel usa il blu primario reale (#22384F), non il nero generico', title.font.color.argb === '22384F', title.font);
    check('titolo Excel usa Calibri (ExcelJS non incorpora font, Plus Jakarta Sans non è un\'opzione sicura)', title.font.name === 'Calibri', title.font.name);
  } catch (e) {
    fail('Excel generato senza errori', e.message);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
