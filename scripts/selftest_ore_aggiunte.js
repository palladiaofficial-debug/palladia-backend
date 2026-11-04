#!/usr/bin/env node
/**
 * scripts/selftest_ore_aggiunte.js — F-432 (AUDIT.md del frontend).
 *
 * «Serve poter mettere ore in più di straordinario direttamente dalla
 * piattaforma. Anche dei giorni scorsi.» Contro il DB vero (gennaio 2026,
 * azienda di prova creata e cancellata qui):
 *  - validazione (giorno futuro, minuti, uuid);
 *  - giorno timbrato 8–17 + 2 h aggiunte → 8 h ordinarie e 2 h di straordinario;
 *  - sabato senza timbrature + 3 h → giorno lavorato, straordinario festivo;
 *  - feriale senza timbrature + 1 h → non più «da giustificare», 1 h di straordinario;
 *  - giorno di ferie: le ore aggiunte non contano;
 *  - totali del mese, ore per cantiere, foglio PDF (HTML) ed Excel, export Studio;
 *  - le timbrature non cambiano (stesso numero di righe in presence_logs).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { buildOreMese, oreMensiliPerStudio } = require('../lib/oreMese');
const { validaOreAggiunte } = require('../routes/v1/oreAggiunte');
const { generateFoglioHtml, generateFoglioXlsx, oreAggiunteRighe, movimenti } = require('../lib/oreMeseFoglio');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F432-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-432 — ore in più aggiunte dall\'ufficio\x1b[0m');
  const W = '11111111-2222-3333-4444-555555555555';
  check('valida: giorno futuro rifiutato', !!validaOreAggiunte({ worker_id: W, giorno: '2026-01-10', minuti: 60 }, '2026-01-09').error);
  check('valida: oggi accettato', !validaOreAggiunte({ worker_id: W, giorno: '2026-01-09', minuti: 60 }, '2026-01-09').error);
  check('valida: minuti zero o decimali rifiutati', !!validaOreAggiunte({ worker_id: W, giorno: '2026-01-05', minuti: 0 }).error && !!validaOreAggiunte({ worker_id: W, giorno: '2026-01-05', minuti: 1.5 }).error);
  check('valida: più di 16 ore rifiutate', !!validaOreAggiunte({ worker_id: W, giorno: '2026-01-05', minuti: 961 }).error);
  check('valida: worker_id non uuid rifiutato', !!validaOreAggiunte({ worker_id: 'x', giorno: '2026-01-05', minuti: 60 }).error);
  check('valida: nota ripulita', validaOreAggiunte({ worker_id: W, giorno: '2026-01-05', minuti: 90, note: '  getto solaio ' }).row?.note === 'getto solaio');

  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via Test 432', status: 'attivo' });
    const w = await ins('workers', { company_id: company.id, full_name: `${T} Anna`, is_active: true, fiscal_code: `F432AAAA${stamp}`, badge_code: `F432A${stamp}` });
    const log = (type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });
    await log('ENTRY', '2026-01-07T08:00:00+01:00'); await log('EXIT', '2026-01-07T17:00:00+01:00'); // mercoledì 8 h
    await log('ENTRY', '2026-01-08T08:00:00+01:00'); await log('EXIT', '2026-01-08T17:00:00+01:00'); // giovedì 8 h
    await ins('worker_absences', { company_id: company.id, worker_id: w.id, tipo: 'ferie', date_from: '2026-01-13', date_to: '2026-01-13' });

    const prima = await buildOreMese(company.id, '2026-01', { today: '2026-02-01' });
    const A0 = prima.lavoratori.find(l => l.id === w.id);
    const c0 = (d) => A0.cells.find(x => x.date === `2026-01-${d}`);
    check('prima: il 9 gennaio è da giustificare', c0('09').tipo === 'giustificare', c0('09'));

    const agg = (row) => ins('ore_aggiunte', { company_id: company.id, worker_id: w.id, ...row });
    await agg({ giorno: '2026-01-07', minuti: 120, note: 'getto solaio' });
    await agg({ giorno: '2026-01-10', minuti: 180, site_id: site.id });  // sabato
    await agg({ giorno: '2026-01-09', minuti: 60 });                       // venerdì senza timbrature
    await agg({ giorno: '2026-01-13', minuti: 60 });                       // ferie: non conta
    const { count: logsPrima } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', company.id);

    const r = await buildOreMese(company.id, '2026-01', { today: '2026-02-01' });
    const A = r.lavoratori.find(l => l.id === w.id);
    const c = (d) => A.cells.find(x => x.date === `2026-01-${d}`);
    check('7/1: 8 h ordinarie + 2 h di straordinario', c('07').ore === 480 && c('07').straord === 120 && c('07').aggiunteMin === 120, c('07'));
    check('7/1: la voce aggiunta ha la nota', c('07').aggiunte?.[0]?.note === 'getto solaio', c('07').aggiunte);
    check('8/1 senza aggiunte non cambia', c('08').ore === 480 && c('08').straord === 0 && !c('08').aggiunteMin, c('08'));
    check('sabato 10/1: giorno lavorato, 3 h straordinario festivo', c('10').tipo === 'lavoro' && c('10').straord === 180 && c('10').festivo === true, c('10'));
    check('9/1: non più da giustificare, 1 h di straordinario', c('09').tipo === 'lavoro' && c('09').straord === 60, c('09'));
    check('13/1 ferie: le ore aggiunte non contano', c('13').tipo === 'ferie' && c('13').straord === 0 && !c('13').aggiunteMin && c('13').aggiunte?.length === 1, c('13'));
    check('totale straordinario del mese = 6 h', A.tot.straordMin === 360, A.tot);
    check('di cui festivo = 3 h', A.tot.straordFestivoMin === 180, A.tot);
    check('totale ordinarie invariato = 16 h', A.tot.ordinarieMin === 960, A.tot);
    check('ore aggiunte del mese = 6 h', A.tot.aggiunteMin === 360, A.tot);
    check('giorni lavorati = 4 (7, 8, 9, 10)', A.tot.giorniLavorati === 4, A.tot);
    check('nessuna domanda «giustificare» per il 9', !r.domande.some(d => d.tipo === 'giustificare' && d.giorni?.includes('2026-01-09')), r.domande);
    check('ore per cantiere: il sabato va sul cantiere scelto', (A.tot.perCantiere[site.id] || 0) >= 960 + 120 + 180, A.tot.perCantiere);

    const righe = oreAggiunteRighe(r);
    check('foglio: 3 righe di straordinario aggiunto (le ferie no)', righe.length === 3, righe);
    const mov = movimenti(r).filter(m => m.cf === `F432AAAA${stamp}`);
    const str = mov.filter(m => m.causale === 'STR').reduce((n, m) => n + m.min, 0);
    const stf = mov.filter(m => m.causale === 'STF').reduce((n, m) => n + m.min, 0);
    check('Excel movimenti: STR 3 h, STF 3 h', str === 180 && stf === 180, { str, stf });
    const html = generateFoglioHtml(r);
    check('PDF: sezione «Straordinario aggiunto dall\'ufficio» con il motivo', html.includes("Straordinario aggiunto dall'ufficio") && html.includes('getto solaio'));
    const xlsx = await generateFoglioXlsx(r);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx);
    check('Excel: foglio «Straordinario aggiunto» con 3 righe', wb.getWorksheet('Straordinario aggiunto')?.rowCount === 4);
    const studio = await oreMensiliPerStudio(company.id, '2026-01');
    const sA = studio.find(x => x.worker_id === w.id);
    check('export Studio: 6 h di straordinario e la nota sul 7', sA?.ore_straordinarie === 6 && /aggiunto dall'ufficio/.test(sA.days.find(d => d.date === '2026-01-07')?.note || ''), sA);

    const { count: logsDopo } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
    check('le timbrature non cambiano', logsPrima === 4 && logsDopo === 4, { logsPrima, logsDopo });
  } finally {
    await supabase.from('ore_aggiunte').delete().eq('company_id', company.id);
    await supabase.from('worker_absences').delete().eq('company_id', company.id);
    await supabase.from('presence_logs').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
