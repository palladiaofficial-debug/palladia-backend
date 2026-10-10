#!/usr/bin/env node
/**
 * scripts/selftest_cantiere_squadra.js — F-326 (pezzo 2 di F-321, AUDIT.md del frontend).
 *
 * Presenze e Squadra del cantiere:
 *   - settimana: griglia operaio × giorno con entrata e uscita, dal lunedì;
 *     sabato solo se qualcuno ha lavorato; stesso calcolo del foglio ore;
 *   - squadra: chi ha timbrato qui negli ultimi 30 giorni con lo stato dei
 *     documenti (urgente solo se qui in settimana), e gli assegnati che non
 *     vengono ("altrove" / "mai").
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { settimana, squadra, lunedi } = require('../lib/cantiereSquadra');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F326-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const romeDay = (d) => d.toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
const romeHm = (iso) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const at = (day, h) => new Date(`${day}T${h}:00Z`).toISOString();

async function main() {
  console.log('\n\x1b[1mF-326 — Presenze e Squadra del cantiere\x1b[0m');
  check('lunedì della settimana', lunedi('2026-10-10') === '2026-10-05' && lunedi('2026-10-05') === '2026-10-05' && lunedi('2026-10-11') === '2026-10-05');

  const company = await ins('companies', { name: T });
  const cid = company.id;
  try {
    const today = romeDay(new Date());
    const lun = addDays(lunedi(today), -7); // settimana scorsa: tutta nel passato
    const sab = addDays(lun, 5);
    const mkSite = (n) => ins('sites', { company_id: cid, name: `${T} ${n}`, address: `${n}, Genova`, status: 'attivo', start_date: '2025-11-03', latitude: 44.41, longitude: 8.95 });
    const qui = await mkSite('Corso Sardegna 88');
    const altro = await mkSite('Via Balbi 31');
    const mk = (n, extra = {}) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F326${n}${stamp}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), safety_training_expiry: '2030-01-01', health_fitness_expiry: '2030-01-01', ...extra });
    const ibrahim = await mk('Ibrahim', { health_fitness_expiry: addDays(today, -20) });
    const giuseppe = await mk('Giuseppe', { safety_training_expiry: addDays(today, -40) });
    const armand = await mk('Armand');   // assegnato, timbra a Balbi
    const mario = await mk('Mario');     // assegnato, non timbra mai
    for (const w of [ibrahim, armand, mario]) await ins('worksite_workers', { company_id: cid, site_id: qui.id, worker_id: w.id, status: 'active' });
    const log = (w, s, type, day, h) => ins('presence_logs', { company_id: cid, site_id: s.id, worker_id: w.id, event_type: type, timestamp_server: at(day, h), method: 'worker_self_punch' });
    // Ibrahim: lunedì giornata piena, mercoledì uscito presto, sabato mattina; ieri qui
    await log(ibrahim, qui, 'ENTRY', lun, '05:45'); await log(ibrahim, qui, 'EXIT', lun, '15:00');
    await log(ibrahim, qui, 'ENTRY', addDays(lun, 2), '05:31'); await log(ibrahim, qui, 'EXIT', addDays(lun, 2), '11:28');
    await log(ibrahim, qui, 'ENTRY', sab, '06:00'); await log(ibrahim, qui, 'EXIT', sab, '10:00');
    await log(ibrahim, qui, 'ENTRY', addDays(today, -1), '05:45'); await log(ibrahim, qui, 'EXIT', addDays(today, -1), '15:00');
    // Giuseppe: qui 12 giorni fa (formazione scaduta, ma non urgente)
    const g12 = addDays(today, -12);
    await log(giuseppe, qui, 'ENTRY', g12, '05:45'); await log(giuseppe, qui, 'EXIT', g12, '15:00');
    await log(armand, altro, 'ENTRY', addDays(today, -2), '05:45'); await log(armand, altro, 'EXIT', addDays(today, -2), '15:00');

    // ── Settimana ──
    const s = await settimana(cid, qui.id, addDays(lun, 3));
    check('settimana: parte dal lunedì', s.da === lun && s.a === addDays(lun, 6), { da: s.da, a: s.a });
    check('settimana: lun–ven più il sabato lavorato, niente domenica', s.giorni.length === 6 && s.giorni[5] === sab && !s.giorni.includes(addDays(lun, 6)), s.giorni);
    const ib = s.persone.find(p => p.workerId === ibrahim.id);
    check('Ibrahim lunedì: entrata e uscita all\'ora di Roma', ib?.giorni[lun]?.entrata === romeHm(at(lun, '05:45')) && ib.giorni[lun].uscita === romeHm(at(lun, '15:00')), ib?.giorni[lun]);
    check('Ibrahim mercoledì: uscito alle ' + romeHm(at(addDays(lun, 2), '11:28')), ib?.giorni[addDays(lun, 2)]?.uscita === romeHm(at(addDays(lun, 2), '11:28')), ib?.giorni[addDays(lun, 2)]);
    check('minuti dal foglio ore (lunedì > 8 ore, con la pausa tolta < 9h15)', ib.giorni[lun].minuti > 480 && ib.giorni[lun].minuti < 555, ib.giorni[lun].minuti);
    check('totale settimana = somma dei giorni', ib.totaleMin === Object.values(ib.giorni).reduce((t, g) => t + g.minuti, 0), ib.totaleMin);
    check('chi non ha lavorato quella settimana non compare', !s.persone.some(p => p.workerId === armand.id || p.workerId === mario.id));

    // ── Squadra ──
    const q = await squadra(cid, qui.id, { today });
    const qi = q.lavorano.find(x => x.workerId === ibrahim.id);
    const qg = q.lavorano.find(x => x.workerId === giuseppe.id);
    check('lavorano qui: Ibrahim (assegnato) e Giuseppe (non assegnato, ma timbra qui)', qi?.assegnato === true && qg?.assegnato === false, q.lavorano);
    check('Ibrahim: idoneità scaduta, urgente (qui ieri)', qi.idoneita.stato === 'scaduta' && qi.idoneita.urgente === true && qi.formazione.stato === 'ok', qi);
    check('Giuseppe: formazione scaduta, non urgente (qui 12 giorni fa)', qg.formazione.stato === 'scaduta' && qg.formazione.urgente === false, qg);
    check('assegnati che non vengono: Armand "altrove", Mario "mai"', q.nonVengono.find(x => x.workerId === armand.id)?.dove === 'altrove' && q.nonVengono.find(x => x.workerId === mario.id)?.dove === 'mai', q.nonVengono);
    check('chi lavora qui non è tra quelli che non vengono', !q.nonVengono.some(x => x.workerId === ibrahim.id));
  } finally {
    await supabase.from('presence_logs').delete().eq('company_id', cid);
    await supabase.from('worksite_workers').delete().eq('company_id', cid);
    await supabase.from('workers').delete().eq('company_id', cid);
    await supabase.from('sites').delete().eq('company_id', cid);
    await supabase.from('companies').delete().eq('id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
