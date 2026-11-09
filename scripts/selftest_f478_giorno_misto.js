#!/usr/bin/env node
/**
 * scripts/selftest_f478_giorno_misto.js — F-477/F-478/F-479 (AUDIT.md del frontend).
 *
 * Il titolare (9/11/2026), sulla tabella delle ore di ottobre:
 *  - «4 ore di lavoro e 4 ore di permesso. Ad esempio Carlo il 28 ottobre»;
 *  - «Petriccione molte volte inizia alle 7… il sistema lo conta solo dalle 8»,
 *    anche per i giorni passati;
 *  - «segnare una pausa pranzo saltata… direttamente da questa schermata»;
 *  - «quando è pioggia dove esce?… sembra solo che sia uscito prima»;
 *  - riepilogo completo (pioggia, permessi, straordinario) e Excel con formule.
 *
 * Contro il DB vero (febbraio 2026, azienda di prova creata e cancellata qui),
 * orario predefinito 08:00–17:00, pausa 12–13.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { contaGiorno, ORARIO_PREDEFINITO } = require('../lib/oreContrattuali');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const m = (t) => { const [h, mm] = t.split(':').map(Number); return h * 60 + mm; };
const g = (a, b, extra = {}) => contaGiorno({ coppie: [{ in: m(a), out: m(b), siteId: 's1' }], orario: ORARIO_PREDEFINITO, lavorativo: true, ...extra });
const T = `TEST-F478-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-478 — conta dall\'entrata (partito prima su richiesta)\x1b[0m');
  let r = g('07:00', '16:00');
  check('senza segno: 07:00–16:00 = 7 h, uscito 1 h prima (regola F-335 invariata)', r.ordinarie === 420 && r.uscitoPrima === 60, r);
  r = g('07:00', '16:00', { daEntrata: true });
  check('partito prima: 07:00–16:00 = 8 h, non è uscito prima', r.ordinarie === 480 && r.uscitoPrima === 0 && r.straordinario === 0, r);
  check('partito prima: segnato quanto prima (60 min), entratoPrima a 0', r.inizioAnticipato === 60 && r.entratoPrima === 0, r);
  r = g('07:00', '17:00', { daEntrata: true });
  check('partito prima: 07:00–17:00 = 8 h + 1 h di straordinario', r.ordinarie === 480 && r.straordinario === 60, r);
  r = g('08:20', '17:00', { daEntrata: true });
  check('segno su un giorno entrato tardi: nessun effetto (ritardo 20)', r.ordinarie === 460 && r.ritardo === 20 && !r.inizioAnticipato, r);
  r = g('07:00', '16:00', { pausaSaltata: true });
  check('pausa saltata: 07:00–16:00 = 8 h (dalle 8 alle 16 senza pausa)', r.ordinarie === 480 && r.uscitoPrima === 0, r);

  console.log('\n\x1b[1mF-478 — rotte\x1b[0m');
  const { validaAssenza } = require('../routes/v1/oreAssenze');
  check('assenze: «pioggia» a ore accettata (maltempo + ore_min)', typeof validaAssenza === 'function' && validaAssenza({ tipo: 'maltempo', dal: '2026-02-05', ore_min: 120 }).row?.ore_min === 120, typeof validaAssenza === 'function' ? validaAssenza({ tipo: 'maltempo', dal: '2026-02-05', ore_min: 120 }) : 'validaAssenza non esportata');
  check('assenze: pioggia su più giorni a ore rifiutata', typeof validaAssenza === 'function' && !!validaAssenza({ tipo: 'maltempo', dal: '2026-02-05', al: '2026-02-06', ore_min: 120 }).error);
  let vi = null;
  try { ({ validaInizioAnticipato: vi } = require('../routes/v1/oreCorrezioni')); } catch { vi = null; }
  check('inizio anticipato: rotta con validazione (giorno passato sì, futuro no)', typeof vi === 'function'
    && !vi({ worker_id: '11111111-2222-3333-4444-555555555555', giorno: '2026-02-03' }, '2026-03-01').error
    && !!vi({ worker_id: '11111111-2222-3333-4444-555555555555', giorno: '2026-03-02' }, '2026-03-01').error);

  console.log('\n\x1b[1mF-478 — il mese con i giorni misti (DB)\x1b[0m');
  const { buildOreMese } = require('../lib/oreMese');
  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Balbi`, address: 'Via Test 478', status: 'attivo' });
    const w = await ins('workers', { company_id: company.id, full_name: `${T} Carlo`, is_active: true, fiscal_code: `F478AAAA${stamp}`, badge_code: `F478A${stamp}` });
    const log = (type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });
    // lun 2: come Carlo il 28/10 — 06:52→12:00, poi permesso fino alle 17
    await log('ENTRY', '2026-02-02T06:52:00+01:00'); await log('EXIT', '2026-02-02T12:00:00+01:00');
    await ins('worker_absences', { company_id: company.id, worker_id: w.id, tipo: 'permesso', date_from: '2026-02-02', date_to: '2026-02-02', ora_dalle: '12:00', ora_alle: '17:00' });
    // mar 3: come Petriccione — 07:00→16:00, partito prima su richiesta
    await log('ENTRY', '2026-02-03T07:00:00+01:00'); await log('EXIT', '2026-02-03T16:00:00+01:00');
    let tabellaOk = true;
    try { await ins('ore_inizio_anticipato', { company_id: company.id, worker_id: w.id, giorno: '2026-02-03' }); } catch (e) { tabellaOk = false; console.error(`    (ore_inizio_anticipato: ${e.message})`); }
    check('tabella ore_inizio_anticipato presente (migrazione 274)', tabellaOk);
    // mer 4: nessuna timbratura, corretto 07:00→16:00 e pausa saltata (trasportatore)
    await ins('ore_correzioni', { company_id: company.id, worker_id: w.id, site_id: site.id, giorno: '2026-02-04', entrata: '07:00', uscita: '16:00' });
    await ins('presence_lunch_overrides', { company_id: company.id, worker_id: w.id, work_date: '2026-02-04' });
    // gio 5: 08:00→15:00, poi pioggia confermata (2 h)
    await log('ENTRY', '2026-02-05T08:00:00+01:00'); await log('EXIT', '2026-02-05T15:00:00+01:00');
    await ins('worker_absences', { company_id: company.id, worker_id: w.id, tipo: 'maltempo', date_from: '2026-02-05', date_to: '2026-02-05', ore_min: 120 });
    // ven 6: 08:00→15:00 senza motivo
    await log('ENTRY', '2026-02-06T08:00:00+01:00'); await log('EXIT', '2026-02-06T15:00:00+01:00');

    const mese = await buildOreMese(company.id, '2026-02', { today: '2026-03-01' });
    const L = mese.lavoratori.find(l => l.id === w.id);
    const c = (d) => L.cells.find(x => x.date === `2026-02-${d}`);
    check('lun 2: 4 h di lavoro + 4 h di permesso, non «uscito prima», niente che manca', c('02').ore === 240 && c('02').permessoMin === 240 && c('02').uscitoPrima === 0 && c('02').mancantiMin === 0, c('02'));
    check('lun 2: le ore che mancherebbero sono esposte (mancantiMin) — mar 6 senza motivo = 2 h', c('06').mancantiMin === 120 && c('06').uscitoPrima === 120, c('06'));
    check('mar 3: partito prima → 8 h, non uscito prima, segnato (daEntrata, inizioAnticipato 60)', c('03').ore === 480 && c('03').uscitoPrima === 0 && c('03').daEntrata === true && c('03').inizioAnticipato === 60, c('03'));
    check('mer 4: giorno corretto senza timbrature + pausa saltata → 8 h, pausaSaltata esposta', c('04').ore === 480 && c('04').pausaSaltata === true && c('04').uscitoPrima === 0, c('04'));
    check('gio 5: 08–15 con pioggia → 6 h + 2 h di pioggia, non «uscito prima», «uscitoPer» = pioggia', c('05').ore === 360 && c('05').maltempoMin === 120 && c('05').uscitoPrima === 0 && c('05').uscitoPer === 'pioggia', c('05'));
    check('totali: permessi 4 h, pioggia 2 h', L.tot.permessoMin === 240 && L.tot.maltempoMin === 120, L.tot);

    console.log('\n\x1b[1mF-479 — foglio per il commercialista\x1b[0m');
    const { generateFoglioHtml, generateFoglioXlsx } = require('../lib/oreMeseFoglio');
    const html = generateFoglioHtml(mese, T);
    check('PDF: «Riepilogo del mese» con colonne Pioggia, Permessi, Ferie, Malattia', /data-sez="riepilogo"/.test(html) && /Pioggia/.test(html) && /Permessi/.test(html) && /Ferie/.test(html) && /Malattia/.test(html));
    check('PDF: «Note sui giorni» spiega permesso, pioggia, partito prima e pausa saltata',
      ((sez) => /permesso 12:00–17:00/i.test(sez) && /pioggia/i.test(sez) && /partito prima su richiesta/i.test(sez) && /pausa pranzo saltata/i.test(sez))(html.match(/data-sez="note-giorni"[\s\S]*?<\/table>/)?.[0] || ''), html.match(/data-sez="note-giorni"[\s\S]*?<\/table>/)?.[0]);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await generateFoglioXlsx(mese, T)));
    const s0 = wb.getWorksheet('Ore del mese');
    let rigaOrd = null;
    s0.eachRow((row, n) => { if (String(row.getCell(1).value || '').includes(`${T} Carlo`)) rigaOrd = rigaOrd || n; });
    const nG = mese.days.length;
    const giorno2 = rigaOrd ? s0.getRow(rigaOrd).getCell(2 + 2).value : null; // A lavoratore, B voce, C = giorno 1 → D = 2 febbraio
    const totOrd = rigaOrd ? s0.getRow(rigaOrd).getCell(nG + 3).value : null;
    check('Excel: le ore del giorno sono numeri (2 feb = 4), non testo', giorno2 === 4, giorno2);
    check('Excel: il totale del lavoratore è una formula SUM sulla sua riga', !!totOrd && typeof totOrd === 'object' && /^SUM\(/i.test(totOrd.formula || ''), totOrd);
    const rTipi = rigaOrd ? [1, 2, 3, 4].map(i => String(s0.getRow(rigaOrd + i - 1).getCell(2).value || '')) : [];
    check('Excel: per ogni lavoratore righe Ordinarie, Straordinario, Pioggia, Permesso', rTipi.join('|') === 'Ordinarie|Straordinario|Pioggia|Permesso', rTipi);
    const s1 = wb.getWorksheet('Riepilogo');
    let fRiep = null;
    s1.eachRow((row) => { if (String(row.getCell(1).value || '').includes(`${T} Carlo`)) row.eachCell((cell) => { if (!fRiep && cell.value && cell.value.formula && /Ore del mese/.test(cell.value.formula)) fRiep = cell.value.formula; }); });
    check('Excel: il Riepilogo prende i numeri dal foglio «Ore del mese» con formule', !!fRiep, fRiep);
    // F-480: in CONTA.SE «?» è un jolly (= qualsiasi lettera): contava anche M e S come «da giustificare»
    const formule = []; s1.eachRow((row) => row.eachCell((cell) => { if (cell.value && cell.value.formula) formule.push(cell.value.formula); }));
    check('Excel: «da giustificare» conta il punto di domanda vero ("~?"), non ogni lettera', formule.some(f => f.includes('"~?"')) && !formule.some(f => /COUNTIF\([^)]*,"\?"\)/.test(f)), formule.filter(f => /COUNTIF/.test(f)).slice(-3));
    const intest = []; s1.getRow(5).eachCell((c) => intest.push(String(c.value)));
    check('Excel: intestazioni corte, che non si spezzano a metà parola', intest.every(t => t.split(/\s+/).every(p => p.length <= 13)), intest);
    check('Excel: gli zeri non si stampano come «0,00»', s1.getColumn(4).numFmt && /;.*;/.test(s1.getColumn(4).numFmt), s1.getColumn(4).numFmt);

    console.log('\n\x1b[1mF-480 — «partito prima» per tutto il mese, con un tocco\x1b[0m');
    let seg = null;
    try { ({ segnaInizioAnticipatoMese: seg } = require('../routes/v1/oreCorrezioni')); } catch { seg = null; }
    check('esiste segnaInizioAnticipatoMese', typeof seg === 'function');
    if (typeof seg === 'function') {
      // lun 9 entra alle 07:00 → con il segno del mese conta dall'entrata
      await log('ENTRY', '2026-02-09T07:00:00+01:00'); await log('EXIT', '2026-02-09T16:00:00+01:00');
      const r1 = await seg({ companyId: company.id, workerId: w.id, month: '2026-02', on: true, oggi: '2026-03-01' });
      const { count } = await supabase.from('ore_inizio_anticipato').select('id', { count: 'exact', head: true }).eq('worker_id', w.id);
      check('mese segnato: una riga per ogni giorno lavorativo passato di febbraio (20)', count === 20 && r1.giorni === 20, { count, r1 });
      const m2 = await buildOreMese(company.id, '2026-02', { today: '2026-03-01' });
      const c9 = m2.lavoratori.find(l => l.id === w.id).cells.find(x => x.date === '2026-02-09');
      check('lun 9 (07:00–16:00) conta 8 h grazie al segno del mese', c9.ore === 480 && c9.daEntrata && c9.inizioAnticipato === 60, c9);
      const c5 = m2.lavoratori.find(l => l.id === w.id).cells.find(x => x.date === '2026-02-05');
      check('gio 5 (entrato alle 08:00) non cambia', c5.ore === 360 && !c5.inizioAnticipato, c5);
      const r2 = await seg({ companyId: company.id, workerId: w.id, month: '2026-02', on: false, oggi: '2026-03-01' });
      const { count: dopo } = await supabase.from('ore_inizio_anticipato').select('id', { count: 'exact', head: true }).eq('worker_id', w.id);
      check('tolto dal mese: nessuna riga rimasta', dopo === 0 && r2.ok, { dopo, r2 });
      const futuro = await seg({ companyId: company.id, workerId: w.id, month: '2026-02', on: true, oggi: '2026-02-10' });
      check('mese in corso: solo fino a oggi (7 giorni lavorativi fino al 10/2)', futuro.giorni === 7, futuro);
      await seg({ companyId: company.id, workerId: w.id, month: '2026-02', on: false, oggi: '2026-03-01' });
    }
  } finally {
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
