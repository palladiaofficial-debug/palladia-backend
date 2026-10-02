#!/usr/bin/env node
/**
 * scripts/selftest_ore_mese.js — F-265 (AUDIT.md del frontend).
 *
 * Riepilogo del mese per le buste paga, contro il DB vero (gennaio 2026,
 * azienda di prova creata e cancellata qui):
 *  - le ore sono IDENTICHE a buildWorkerHoursReport (stesso calcolo dei report);
 *  - pausa automatica (turno continuo) e pausa timbrata (motivo "pausa");
 *  - straordinario oltre 8 h; uscita per maltempo → ore maltempo;
 *  - ferie, permesso a ore, malattia; richieste in attesa (anche di altri mesi);
 *    rifiutate ignorate;
 *  - festività (Epifania) e weekend non sono "da giustificare"; un giorno
 *    feriale senza nulla lo è; chi ha solo un'assenza non ha giorni da giustificare;
 *  - validazione delle assenze; foglio PDF (HTML) ed Excel.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { buildOreMese } = require('../lib/oreMese');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { validaAssenza } = require('../routes/v1/oreAssenze');
const { generateFoglioHtml, generateFoglioXlsx } = require('../lib/oreMeseFoglio');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F265-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-265 — ore e assenze del mese\x1b[0m');

  check('valida: tipo sconosciuto rifiutato', !!validaAssenza({ tipo: 'vacanza', dal: '2026-01-01' }).error);
  check('valida: al prima di dal rifiutato', !!validaAssenza({ tipo: 'ferie', dal: '2026-01-10', al: '2026-01-09' }).error);
  check('valida: permesso a ore su più giorni rifiutato', !!validaAssenza({ tipo: 'permesso', dal: '2026-01-10', al: '2026-01-11', dalle: '08:00', alle: '10:00' }).error);
  check('valida: permesso con alle prima di dalle rifiutato', !!validaAssenza({ tipo: 'permesso', dal: '2026-01-10', dalle: '10:00', alle: '08:00' }).error);
  check('valida: malattia con protocollo, al = dal se manca', JSON.stringify(validaAssenza({ tipo: 'malattia', dal: '2026-01-20', protocollo: ' 123 ' }).row) === JSON.stringify({ tipo: 'malattia', date_from: '2026-01-20', date_to: '2026-01-20', ora_dalle: null, ora_alle: null, protocollo: '123', note: null }));

  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via Test 265', status: 'attivo' });
    const wA = await ins('workers', { company_id: company.id, full_name: `${T} Anna`, is_active: true, fiscal_code: `F265AAAA${stamp}`, badge_code: `F265A${stamp}` });
    const wB = await ins('workers', { company_id: company.id, full_name: `${T} Bruno`, is_active: true, fiscal_code: `F265BBBB${stamp}`, badge_code: `F265B${stamp}` });
    const log = async (worker, type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: worker.id, event_type: type, timestamp_server: ts, method: 'scan' });
    const day = async (d, pairs) => { const out = []; for (const [a, b] of pairs) { await log(wA, 'ENTRY', `2026-01-${d}T${a}:00+01:00`); out.push(await log(wA, 'EXIT', `2026-01-${d}T${b}:00+01:00`)); } return out; };

    await day('07', [['08:00', '17:00']]);                     // 9 h - 60 pausa automatica = 8 h
    await day('08', [['07:00', '18:00']]);                     // 11 h - 60 = 10 h → 2 h straordinario
    const [mal] = await day('09', [['08:00', '12:00']]);       // uscita per maltempo → 4 h maltempo
    await supabase.from('presence_log_reasons').insert({ company_id: company.id, presence_log_id: mal.id, reason: 'maltempo' });
    const [pausa] = await day('12', [['08:00', '12:00'], ['13:00', '17:00']]); // pausa timbrata → 8 h, nessuna detrazione
    const pz = await supabase.from('presence_log_reasons').insert({ company_id: company.id, presence_log_id: pausa.id, reason: 'pausa' });
    check('il motivo "pausa" è accettato dal DB (migrazione 233)', !pz.error, pz.error);
    const bad = await supabase.from('presence_log_reasons').insert({ company_id: company.id, presence_log_id: pausa.id, reason: 'inventato' });
    check('un motivo non previsto resta rifiutato dal DB', !!bad.error);
    await day('15', [['08:00', '12:00']]);                     // + permesso 12–16

    const abs = (w, row) => ins('worker_absences', { company_id: company.id, worker_id: w.id, ...row });
    await abs(wA, { tipo: 'ferie', date_from: '2026-01-13', date_to: '2026-01-14' });
    await abs(wA, { tipo: 'permesso', date_from: '2026-01-15', date_to: '2026-01-15', ora_dalle: '12:00', ora_alle: '16:00' });
    await abs(wA, { tipo: 'ferie', date_from: '2026-01-27', date_to: '2026-01-27', stato: 'rifiutata' });
    await abs(wA, { tipo: 'ferie', date_from: '2026-03-02', date_to: '2026-03-06', stato: 'richiesta', da_lavoratore: true });
    await abs(wB, { tipo: 'malattia', date_from: '2026-01-20', date_to: '2026-01-21', protocollo: 'PROT-F265' });

    const r = await buildOreMese(company.id, '2026-01', { today: '2026-02-01' });
    const A = r.lavoratori.find(l => l.id === wA.id);
    const B = r.lavoratori.find(l => l.id === wB.id);
    const c = (l, d) => l.cells.find(x => x.date === `2026-01-${d}`);

    const rep = await buildWorkerHoursReport(null, company.id, '2026-01-01', '2026-01-31', null, true);
    const repA = rep.workers.find(w => w.id === wA.id);
    check('ore del mese identiche al report ore esistente', A.cells.reduce((s, x) => s + x.ore, 0) === repA.total_minutes, { mese: A.cells.reduce((s, x) => s + x.ore, 0), report: repA.total_minutes });
    check('7/1: turno continuo, pausa automatica 60 min → 8 h', c(A, '07').ore === 480 && c(A, '07').pausaMin === 60 && c(A, '07').straord === 0, c(A, '07'));
    check('8/1: 10 h → 2 h di straordinario', c(A, '08').ore === 600 && c(A, '08').straord === 120, c(A, '08'));
    check('9/1: uscita per maltempo dopo 4 h → 4 h maltempo', c(A, '09').ore === 240 && c(A, '09').maltempoMin === 240, c(A, '09'));
    check('12/1: pausa timbrata → 8 h, nessuna detrazione, niente maltempo/permesso', c(A, '12').ore === 480 && c(A, '12').pausaMin === 0 && c(A, '12').maltempoMin === 0 && c(A, '12').permessoMin === 0, c(A, '12'));
    check('13–14/1: ferie', c(A, '13').tipo === 'ferie' && c(A, '14').tipo === 'ferie');
    check('15/1: 4 h lavorate + permesso 12–16 (4 h)', c(A, '15').ore === 240 && c(A, '15').permessoMin === 240, c(A, '15'));
    check('6/1 Epifania: festivo, non da giustificare', c(A, '06').tipo === 'festivo');
    check('10/1 sabato: weekend', c(A, '10').tipo === 'weekend');
    check('16/1 venerdì senza nulla: da giustificare', c(A, '16').tipo === 'giustificare');
    check('27/1 ferie rifiutate: resta da giustificare', c(A, '27').tipo === 'giustificare');
    const oggi = await buildOreMese(company.id, '2026-01', { today: '2026-01-16' });
    const Ao = oggi.lavoratori.find(l => l.id === wA.id);
    check('oggi non è ancora da giustificare (la giornata non è finita), ieri sì', Ao.cells.find(x => x.date === '2026-01-16').tipo === null && Ao.cells.find(x => x.date === '2026-01-15').tipo === 'lavoro' && Ao.cells.find(x => x.date === '2026-01-02').tipo === 'giustificare', Ao.cells.slice(0, 16).map(x => x.tipo));
    check('totali Anna: 2 gg ferie, 4 h permesso, 4 h maltempo, 2 h straordinario',
      A.tot.ferieGiorni === 2 && A.tot.permessoMin === 240 && A.tot.maltempoMin === 240 && A.tot.straordMin === 120, A.tot);
    check('Bruno (solo malattia): 2 gg malattia, nessun giorno da giustificare', B && B.tot.malattiaGiorni === 2 && B.tot.daGiustificare === 0, B && B.tot);
    check('richiesta di marzo in attesa visibile anche guardando gennaio', r.richieste.length === 1 && r.richieste[0].date_from === '2026-03-02' && r.richieste[0].nome === wA.full_name, r.richieste);
    check('giorni lavorativi di gennaio 2026: 20 (Capodanno ed Epifania esclusi)', r.giorniLavorativi === 20, r.giorniLavorativi);

    const html = generateFoglioHtml(r, T);
    check('foglio PDF: lavoratori, protocollo malattia, giorni da giustificare', html.includes(wA.full_name) && html.includes('PROT-F265') && html.includes('Giorni da giustificare'));
    const xbuf = await generateFoglioXlsx(r, T);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xbuf);
    check('foglio Excel: 3 fogli, ore permesso di Anna = 4', wb.worksheets.length === 3 && wb.getWorksheet('Riepilogo').getRow(4).getCell(5).value === 4, wb.worksheets.map(s => s.name));
  } finally {
    await supabase.from('worker_absences').delete().eq('company_id', company.id);
    const { data: logs } = await supabase.from('presence_logs').select('id').eq('company_id', company.id);
    if (logs?.length) await supabase.from('presence_log_reasons').delete().in('presence_log_id', logs.map(l => l.id));
    await supabase.from('presence_logs').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
    const { count } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
    if (count) console.log(`  (nota: ${count} timbrature di prova restano, presence_logs è append-only)`);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
