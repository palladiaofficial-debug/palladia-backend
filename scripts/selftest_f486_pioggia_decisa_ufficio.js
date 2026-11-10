#!/usr/bin/env node
/**
 * scripts/selftest_f486_pioggia_decisa_ufficio.js — F-486 (AUDIT.md del frontend).
 *
 * Il titolare (10/11/2026): «dare la possibilità ai tecnici di segnare tutto il
 * giorno pioggia o meno». L'ufficio decide giorno per giorno, sopra la regola
 * automatica delle 10 (F-485):
 *  - uscito alle 10:34 per pioggia (regola: 2,5 h + 5,5 h) → «tutto il giorno» → giornata di pioggia;
 *  - uscito alle 09:50 (regola: tutto il giorno) → «no» → ore lavorate + pioggia;
 *  - togliere la decisione → torna la regola.
 * Parte senza DB (la regola con la decisione) e parte contro il DB vero
 * (febbraio 2026, azienda di prova creata e cancellata qui).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const T = `TEST-F486-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-486 — la regola con la decisione dell\'ufficio (senza DB)\x1b[0m');
  const { applicaPioggiaGiornoIntero } = require('../lib/pioggiaGiornoIntero');
  const cella = (uscita, ore) => ({ tipo: 'lavoro', ore, straord: 0, maltempoMin: 480 - ore, permessoMin: 0, malattiaMin: 0, infortunioMin: 0, ultimaUscita: uscita, perCantiere: { s1: ore } });
  const o = { limite: '10:00', tolleranza: 5, contratto: 480, motivo: 'maltempo' };
  let c = cella('10:34', 154); applicaPioggiaGiornoIntero(c, { ...o, forza: true });
  check('10:34 + «tutto il giorno» → giornata di pioggia (0 + 8 h)', c.tipo === 'maltempo' && c.ore === 0 && c.maltempoMin === 480 && c.pioggiaGiornoIntero?.decisoUfficio === true, c);
  c = cella('09:50', 110); applicaPioggiaGiornoIntero(c, { ...o, forza: false });
  check('09:50 + «no» → 1 h 50 lavorate + il resto di pioggia', c.tipo === 'lavoro' && c.ore === 110 && c.maltempoMin === 370, c);
  c = cella('10:34', 154); applicaPioggiaGiornoIntero(c, { ...o, limite: null, forza: true });
  check('«tutto il giorno» vale anche con la regola automatica spenta', c.tipo === 'maltempo', c);
  c = cella('10:34', 154); applicaPioggiaGiornoIntero(c, { ...o, motivo: 'caldo', forza: true });
  check('uscita per il caldo: la decisione di pioggia non si applica', c.tipo === 'lavoro', c);

  let lib = null;
  try { lib = require('../lib/orePioggiaGiorno'); } catch { lib = null; }
  check('esiste lib/orePioggiaGiorno.js (decisioni dell\'ufficio)', !!lib);
  let valida = null;
  try { ({ validaPioggiaGiorno: valida } = require('../routes/v1/oreCorrezioni')); } catch { valida = null; }
  check('rotta: validazione (sì / no / togli; niente giorni futuri)', typeof valida === 'function'
    && !valida({ worker_id: '11111111-2222-3333-4444-555555555555', giorno: '2026-02-03', intero: true }, '2026-03-01').error
    && !valida({ worker_id: '11111111-2222-3333-4444-555555555555', giorno: '2026-02-03', intero: null }, '2026-03-01').error
    && !!valida({ worker_id: '11111111-2222-3333-4444-555555555555', giorno: '2026-03-02', intero: true }, '2026-03-01').error
    && !!valida({ worker_id: '11111111-2222-3333-4444-555555555555', giorno: '2026-02-03', intero: 'forse' }, '2026-03-01').error);
  if (!lib) return;

  console.log('\n\x1b[1mF-486 — il mese con le decisioni (DB)\x1b[0m');
  const { buildOreMese } = require('../lib/oreMese');
  const company = await ins('companies', { name: T });
  try {
    const { error: limErr } = await supabase.from('companies').update({ pioggia_giorno_intero_entro: '10:00' }).eq('id', company.id);
    check('regola automatica delle 10 accesa per l\'azienda di prova (migr. 275)', !limErr, limErr?.message);
    const site = await ins('sites', { company_id: company.id, name: `${T}-Balbi`, address: 'Via Test 486', status: 'attivo' });
    const w = await ins('workers', { company_id: company.id, full_name: `${T} Lika`, is_active: true, fiscal_code: `F486AAAA${stamp}`, badge_code: `F486A${stamp}` });
    const log = (type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });
    const pioggia = async (giorno, entrata, uscita) => {
      await log('ENTRY', `${giorno}T${entrata}:00+01:00`);
      const u = await log('EXIT', `${giorno}T${uscita}:00+01:00`);
      await ins('presence_log_reasons', { company_id: company.id, presence_log_id: u.id, reason: 'maltempo', stato: 'confermato' });
    };
    await pioggia('2026-02-02', '08:00', '10:34'); // lun: come Lika Elton il 20/10
    await pioggia('2026-02-03', '08:00', '09:50'); // mar: entro le 10
    await pioggia('2026-02-04', '08:00', '10:34'); // mer: nessuna decisione

    const cellaDi = async (d) => (await buildOreMese(company.id, '2026-02', { today: '2026-03-01' })).lavoratori.find(l => l.id === w.id).cells.find(x => x.date === `2026-02-${d}`);
    let c2 = await cellaDi('02'), c3 = await cellaDi('03');
    check('senza decisioni: lun 10:34 → 2 h 34 + pioggia (regola)', c2.tipo === 'lavoro' && c2.ore === 154 && c2.maltempoMin === 326, c2);
    check('senza decisioni: mar 09:50 → tutto il giorno pioggia (regola)', c3.tipo === 'maltempo' && c3.maltempoMin === 480, c3);

    const r1 = await lib.segnaPioggiaGiorno({ companyId: company.id, workerId: w.id, giorno: '2026-02-02', intero: true });
    const r2 = await lib.segnaPioggiaGiorno({ companyId: company.id, workerId: w.id, giorno: '2026-02-03', intero: false });
    check('decisioni salvate (tabella ore_pioggia_giorno, migr. 276)', r1.ok && r2.ok, { r1, r2 });
    c2 = await cellaDi('02'); c3 = await cellaDi('03');
    const c4 = await cellaDi('04');
    check('lun 10:34 + «tutto il giorno» → giornata di pioggia, decisione esposta', c2.tipo === 'maltempo' && c2.ore === 0 && c2.maltempoMin === 480 && c2.pioggiaDecisa === true, c2);
    check('mar 09:50 + «no» → 1 h 50 + pioggia, decisione esposta', c3.tipo === 'lavoro' && c3.ore === 110 && c3.maltempoMin === 370 && c3.pioggiaDecisa === false, c3);
    check('mer 10:34 senza decisione → regola (2 h 34 + pioggia)', c4.tipo === 'lavoro' && c4.ore === 154 && c4.pioggiaDecisa == null, c4);

    await lib.segnaPioggiaGiorno({ companyId: company.id, workerId: w.id, giorno: '2026-02-02', intero: null });
    c2 = await cellaDi('02');
    check('decisione tolta → torna la regola', c2.tipo === 'lavoro' && c2.ore === 154 && c2.pioggiaDecisa == null, c2);
    const altro = await lib.segnaPioggiaGiorno({ companyId: company.id, workerId: '11111111-2222-3333-4444-555555555555', giorno: '2026-02-02', intero: true });
    check('lavoratore di un\'altra impresa → rifiutato', !altro.ok && altro.status === 404, altro);
  } finally {
    await supabase.from('companies').delete().eq('id', company.id);
  }
}

main().then(() => {
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
