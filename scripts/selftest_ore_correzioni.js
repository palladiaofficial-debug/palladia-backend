#!/usr/bin/env node
/**
 * scripts/selftest_ore_correzioni.js — F-435 (AUDIT.md del frontend).
 *
 * «La tabella deve essere editabile perché magari un operaio ha timbrato male
 * o in ritardo.» Contro il DB vero (febbraio 2026, azienda di prova creata e
 * cancellata qui), orario predefinito 08:00–17:00, pausa 12–13, tolleranza 5,
 * straordinario da 30 min a blocchi di 30:
 *  - validazione (orari, giorno futuro, uuid, cantiere obbligatorio);
 *  - lun 2: badge 08:31–17:02 → ritardo 31; corretto 08:00–17:02 → 8 h, niente ritardo;
 *  - mar 3: solo entrata 07:58 → corretto 07:58–17:00 → 8 h, niente anomalia;
 *  - mer 4: nessuna timbratura (da giustificare) → corretto 08:00–17:00 → 8 h sul cantiere scelto;
 *  - gio 5: corretto 08:00–19:00 → 8 h + 2 h straordinario;
 *  - ven 6: corretto 08:00–17:40 → 8 h + 30 min (40 min a blocchi di 30);
 *  - sab 7: corretto 08:00–12:00 → 4 h tutte straordinario festivo;
 *  - lun 9: ferie → la correzione non conta, resta ferie;
 *  - mar 10: turno di notte 22:00–06:00 → uscita il giorno dopo, tutto fuori orario;
 *  - la timbratura originale resta nella cella (corretto.prima) e in presence_logs;
 *  - foglio PDF: una tabella sola con «Cantieri», legenda e «Correzioni dell'ufficio»;
 *  - Excel: primo foglio «Ore del mese» con giorni e cantieri.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { buildOreMese, contaCorrezione } = require('../lib/oreMese');
const { validaCorrezione } = require('../routes/v1/oreCorrezioni');
const { generateFoglioHtml, generateFoglioXlsx } = require('../lib/oreMeseFoglio');
const ExcelJS = require('exceljs');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F435-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-435 — correggere l\'orario di un giorno dalla tabella delle ore\x1b[0m');
  const W = '11111111-2222-3333-4444-555555555555', S = '66666666-7777-8888-9999-000000000000';
  const ok = { worker_id: W, site_id: S, giorno: '2026-02-02', entrata: '08:00', uscita: '17:00' };
  check('valida: corpo giusto accettato', !validaCorrezione(ok, '2026-03-01').error, validaCorrezione(ok, '2026-03-01'));
  check('valida: giorno futuro rifiutato', !!validaCorrezione({ ...ok, giorno: '2026-03-02' }, '2026-03-01').error);
  check('valida: orario sbagliato rifiutato', !!validaCorrezione({ ...ok, entrata: '8' }, '2026-03-01').error && !!validaCorrezione({ ...ok, uscita: '25:00' }, '2026-03-01').error);
  check('valida: entrata uguale all\'uscita rifiutata', !!validaCorrezione({ ...ok, uscita: '08:00' }, '2026-03-01').error);
  check('valida: senza cantiere rifiutato', !!validaCorrezione({ ...ok, site_id: null }, '2026-03-01').error);
  check('valida: nota ripulita', validaCorrezione({ ...ok, nota: '  badge scarico ' }, '2026-03-01').row?.nota === 'badge scarico');

  // Anteprima pura: stesse regole del conteggio
  const ant = contaCorrezione({ entrata: '08:00', uscita: '19:00', lavorativo: true });
  check('anteprima: 08:00–19:00 → 8 h + 2 h straordinario', ant.ordinarie === 480 && ant.straordinario === 120, ant);
  const antSab = contaCorrezione({ entrata: '08:00', uscita: '12:00', lavorativo: false });
  check('anteprima: sabato 08:00–12:00 → 4 h di straordinario', antSab.ordinarie === 0 && antSab.straordinario === 240, antSab);

  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Balbi`, address: 'Via Test 435', status: 'attivo' });
    const w = await ins('workers', { company_id: company.id, full_name: `${T} Luca`, is_active: true, fiscal_code: `F435AAAA${stamp}`, badge_code: `F435A${stamp}` });
    const log = (type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });
    await log('ENTRY', '2026-02-02T08:31:00+01:00'); await log('EXIT', '2026-02-02T17:02:00+01:00');
    await log('ENTRY', '2026-02-03T07:58:00+01:00');
    await log('ENTRY', '2026-02-05T08:00:00+01:00'); await log('EXIT', '2026-02-05T17:00:00+01:00');
    await log('ENTRY', '2026-02-06T08:00:00+01:00'); await log('EXIT', '2026-02-06T17:00:00+01:00');
    await log('ENTRY', '2026-02-12T08:00:00+01:00'); await log('EXIT', '2026-02-12T17:00:00+01:00');
    await ins('worker_absences', { company_id: company.id, worker_id: w.id, tipo: 'ferie', date_from: '2026-02-09', date_to: '2026-02-09' });
    const { count: logsPrima } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('worker_id', w.id);

    const prima = await buildOreMese(company.id, '2026-02', { today: '2026-03-01' });
    const c0 = (d) => prima.lavoratori.find(l => l.id === w.id).cells.find(x => x.date === `2026-02-${d}`);
    check('prima: lun 2 ritardo 31 min', c0('02').ritardo === 31, c0('02'));
    check('prima: mer 4 da giustificare', c0('04').tipo === 'giustificare', c0('04'));

    const corr = (giorno, entrata, uscita, extra = {}) => ins('ore_correzioni', { company_id: company.id, worker_id: w.id, site_id: site.id, giorno, entrata, uscita, ...extra });
    await corr('2026-02-02', '08:00', '17:02', { orig_entrata: '08:31', orig_uscita: '17:02', nota: 'badge scarico' });
    await corr('2026-02-03', '07:58', '17:00', { orig_entrata: '07:58' });
    await corr('2026-02-04', '08:00', '17:00');
    await corr('2026-02-05', '08:00', '19:00');
    await corr('2026-02-06', '08:00', '17:40');
    await corr('2026-02-07', '08:00', '12:00');
    await corr('2026-02-09', '08:00', '17:00');
    await corr('2026-02-10', '22:00', '06:00');

    const dopo = await buildOreMese(company.id, '2026-02', { today: '2026-03-01' });
    const L = dopo.lavoratori.find(l => l.id === w.id);
    const c = (d) => L.cells.find(x => x.date === `2026-02-${d}`);
    check('lun 2: 8 h, niente ritardo', c('02').ore === 480 && !c('02').ritardo && c('02').tipo === 'lavoro', c('02'));
    check('lun 2: la cella dice che è corretta e com\'era', c('02').corretto?.entrata === '08:00' && c('02').corretto?.prima?.entrata === '08:31' && c('02').corretto?.nota === 'badge scarico', c('02').corretto);
    check('mar 3: uscita mancante corretta → 8 h, niente anomalia', c('03').ore === 480 && !c('03').anomalia, c('03'));
    check('mer 4: non più da giustificare, 8 h sul cantiere', c('04').tipo === 'lavoro' && c('04').ore === 480 && c('04').perCantiere?.[site.id] === 480, c('04'));
    check('gio 5: 8 h + 2 h straordinario', c('05').ore === 480 && c('05').straord === 120, c('05'));
    check('ven 6: 40 min dopo le 17 → 30 min di straordinario', c('06').ore === 480 && c('06').straord === 30, c('06'));
    check('sab 7: 4 h di straordinario festivo', c('07').ore === 0 && c('07').straord === 240 && c('07').festivo === true && c('07').tipo === 'lavoro', c('07'));
    check('lun 9: ferie vince sulla correzione', c('09').tipo === 'ferie' && c('09').ore === 0, c('09'));
    check('mar 10: turno di notte contato fino alle 06:00 del giorno dopo', c('10').straord > 0 && c('10').ultimaUscita === '06:00', c('10'));
    check('gio 12 non corretto: invariato', c('12').ore === 480 && !c('12').corretto, c('12'));
    check('totale straordinario del mese', L.tot.straordMin === 120 + 30 + 240 + c('10').straord, L.tot);
    check('correzioni contate nel riepilogo del lavoratore', L.tot.correzioni === 7, L.tot.correzioni);

    const { count: logsDopo } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('worker_id', w.id);
    check('le timbrature non cambiano', logsPrima === logsDopo, { logsPrima, logsDopo });

    const html = generateFoglioHtml(dopo, T);
    check('PDF: una tabella sola del mese', (html.match(/<table class="mese"/g) || []).length === 1, (html.match(/<table class="mese"/g) || []).length);
    check('PDF: ore per cantiere sotto la tabella (F-476)', html.includes('Ore per cantiere') && html.includes('data-sez="cantieri"'));
    check('PDF: nome del cantiere accanto al lavoratore', html.includes(`${T}-Balbi`));
    check('PDF: correzioni dell\'ufficio elencate con l\'orario di prima', html.includes('Correzioni dell') && html.includes('08:31 → 08:00'));
    check('PDF: legenda', html.includes('ferie') && html.includes('malattia') && html.includes('corretto'));
    check('PDF: niente più pagina «Riepilogo del mese» separata', !html.includes('Riepilogo del mese'));

    const buf = await generateFoglioXlsx(dopo, T);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const s1 = wb.worksheets[0];
    check('Excel: primo foglio «Ore del mese»', s1.name === 'Ore del mese', s1.name);
    const testo = []; s1.eachRow(r => testo.push(r.values.join('|')));
    check('Excel: colonna Cantieri e nome del cantiere', testo.some(t => t.includes('Cantieri')) && testo.some(t => t.includes(`${T}-Balbi`)), testo.slice(0, 8));
  } finally {
    await supabase.from('ore_correzioni').delete().eq('company_id', company.id);
    await supabase.from('worker_absences').delete().eq('company_id', company.id);
    await supabase.from('presence_logs').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
