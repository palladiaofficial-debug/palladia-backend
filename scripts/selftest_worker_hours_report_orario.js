#!/usr/bin/env node
/**
 * scripts/selftest_worker_hours_report_orario.js — F-335 (AUDIT.md del frontend).
 *
 * Il report "Ore lavorate" (PDF/Excel da Presenze e dal cantiere, riepilogo e
 * squadra del cantiere) conta le ore come il foglio per il commercialista:
 * sull'orario di lavoro, non sui minuti timbrati. Prima: 7:38–17:02 valeva
 * 8 h 24 e 7:00–18:00 dava 2 h di straordinario; il portale Studio CDL non
 * toglieva nemmeno la pausa.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const { buildWorkerHoursReport, generateWorkerHoursPdfHtml } = require('../services/workerHoursReport');
const { buildOreMese } = require('../lib/oreMese');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F335R-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-335 — Report "Ore lavorate" sull\'orario di lavoro\x1b[0m');
  const company = await ins('companies', { name: T });
  const stamp = String(Date.now()).slice(-8);
  const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: '', status: 'attivo' });
  const w = await ins('workers', { company_id: company.id, full_name: `${T} Mario`, is_active: true, fiscal_code: `F335RMAR${stamp}`, badge_code: `F335R${stamp}` });
  const log = (type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });
  // Febbraio 2026 (ora solare, +01:00): lun 2, mar 3, sab 7
  await log('ENTRY', '2026-02-02T07:38:00+01:00'); await log('EXIT', '2026-02-02T17:02:00+01:00');
  await log('ENTRY', '2026-02-03T07:00:00+01:00'); await log('EXIT', '2026-02-03T18:00:00+01:00');
  await log('ENTRY', '2026-02-07T07:50:00+01:00'); await log('EXIT', '2026-02-07T12:05:00+01:00');

  const r = await buildWorkerHoursReport(null, company.id, '2026-02-01', '2026-02-28', null, true);
  const W = r.workers.find(x => x.id === w.id);
  const d = (k) => W.days.find(x => x.date_key === k);
  check('2/2 7:38–17:02: 8 h, non 8 h 24; tempo timbrato conservato a parte', d('2026-02-02').day_total_minutes === 480 && d('2026-02-02').day_timbrato_minutes === 504 && d('2026-02-02').overtime_minutes === 0, d('2026-02-02'));
  check('3/2 7:00–18:00: 8 h + 1 h di straordinario (non 10 h con 2 di straordinario)', d('2026-02-03').day_total_minutes === 540 && d('2026-02-03').overtime_minutes === 60 && d('2026-02-03').ordinarie_minutes === 480, d('2026-02-03'));
  check('sabato 7/2 7:50–12:05: 4 h tutte straordinario', d('2026-02-07').day_total_minutes === 240 && d('2026-02-07').overtime_minutes === 240 && d('2026-02-07').ordinarie_minutes === 0, d('2026-02-07'));
  check('totali del lavoratore: 21 h contate (8 + 9 + 4), di cui 5 h di straordinario', W.total_minutes === 1260 && W.overtime_minutes === 300 && W.ordinarie_minutes === 960, { tot: W.total_minutes, ot: W.overtime_minutes });

  const m = await buildOreMese(company.id, '2026-02', { today: '2026-03-01' });
  const L = m.lavoratori.find(x => x.id === w.id);
  check('stessi numeri del foglio per il commercialista', L.tot.ordinarieMin === W.ordinarie_minutes && L.tot.straordMin === W.overtime_minutes, { foglio: [L.tot.ordinarieMin, L.tot.straordMin], report: [W.ordinarie_minutes, W.overtime_minutes] });

  const { oreMensiliPerStudio } = require('../lib/oreMese');
  const st = (await oreMensiliPerStudio(company.id, '2026-02')).find(x => x.worker_id === w.id);
  check('portale Studio CDL: stesse ore (21 h = 16 ordinarie + 5 straordinarie), non i minuti timbrati senza pausa', st?.total_hours === 21 && st.ore_ordinarie === 16 && st.ore_straordinarie === 5 && st.days.find(x => x.date === '2026-02-02')?.hours === 8, st);

  const html = generateWorkerHoursPdfHtml({ ...r, include_overtime: true });
  check('PDF: regole di conteggio scritte e totale 21h', html.includes('Si conta dalle 08:00') && html.includes('21h 00m') && !html.includes('detratti per ritardo'), html.slice(html.indexOf('Si conta'), html.indexOf('Si conta') + 200));
  check('PDF: entrata delle 7:38 segnata come "conta dalle 08:00"', html.includes('conta dalle 08:00'));

  // Orario personale: con 7:30–16:30, 7:38 è un ritardo di 8 minuti
  await supabase.from('workers').update({ orario_inizio: '07:30', orario_fine: '16:30' }).eq('id', w.id);
  const r2 = await buildWorkerHoursReport(null, company.id, '2026-02-02', '2026-02-02', null, true);
  const d2 = r2.workers[0].days[0];
  check('orario personale 7:30–16:30: 7:38–17:02 = 7 h 52 (ritardo 8 min) + 30 min di straordinario (32 min oltre le 16:30)', d2.ordinarie_minutes === 472 && d2.overtime_minutes === 30 && d2.conteggio.conto.ritardo === 8, d2.conteggio.conto);

  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
