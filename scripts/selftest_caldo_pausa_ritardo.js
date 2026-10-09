#!/usr/bin/env node
/**
 * scripts/selftest_caldo_pausa_ritardo.js — F-319 (AUDIT.md del frontend).
 *
 * Il titolare (10/10): "quando escono prima possono scegliere se è per
 * permesso, malattia, pioggia, allerta caldo ecc? […] se escono solo un'ora
 * prima ci può essere la domanda 'hai saltato la pausa pranzo?'". Più un
 * buco trovato rispondendo: chi entra tardi per la pioggia del mattino.
 * Decisioni del titolare: caldo da giugno a settembre (lo conferma lui);
 * "Ho saltato la pausa" se esce fino a 90 minuti prima (lo conferma lui);
 * entrata almeno un'ora dopo il solito → una domanda.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { domanda, rispondi, domandaEntrata, rispondiEntrata } = require('../lib/uscitaAnticipata');
const { proposte, conferma, annulla, pauseDaConfermare, confermaPausa, annullaPausa } = require('../lib/pioggiaDaConfermare');
const { buildOreMese } = require('../lib/oreMese');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F319-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const romeDay = (d) => d.toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function romeIso(day, hm) {
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' }).formatToParts(new Date(`${day}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value;
  return new Date(Date.parse(`${day}T${hm}:00Z`) - Number(off.replace('GMT', '') || 0) * 3600e3).toISOString();
}
function workdaysBefore(day, n) {
  const out = []; let d = day;
  while (out.length < n) { d = addDays(d, -1); const dow = new Date(`${d}T12:00:00Z`).getUTCDay(); if (dow !== 0 && dow !== 6) out.push(d); }
  return out;
}
const lastWorkday = (day) => { let d = day; while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, -1); return d; };
const at = (iso, min) => new Date(Date.parse(iso) + min * 60000);

async function main() {
  console.log('\n\x1b[1mF-319 — caldo, pausa saltata, entrata in ritardo\x1b[0m');
  const company = await ins('companies', { name: T });
  const cid = company.id;
  try {
    const site = await ins('sites', { company_id: cid, name: `${T} Cantiere`, address: 'Via Test 1, Genova', status: 'attivo', start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi' });
    const mk = (n) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F319${n}${stamp}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase() });
    const log = (w, type, day, hm) => ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: romeIso(day, hm), method: 'worker_self_punch' });
    const storico = async (w, day, n = 6) => { for (const d of workdaysBefore(day, n)) { await log(w, 'ENTRY', d, '07:30'); await log(w, 'EXIT', d, '17:00'); } };

    // ── Caldo: in luglio il tasto c'è, a ottobre no ──
    const luglio = '2026-07-15';
    const caldoW = await mk('Caldo'); await storico(caldoW, luglio);
    await log(caldoW, 'ENTRY', luglio, '07:30'); const exC = await log(caldoW, 'EXIT', luglio, '13:00');
    const qC = await domanda(caldoW.badge_code, at(exC.timestamp_server, 2));
    check('luglio, esce alle 13 (solito 17): domanda con "Fa troppo caldo"', qC.ask && qC.caldo === true, qC);
    check('...senza "Ho saltato la pausa" (4 ore prima)', qC.pausa === false, qC);
    const rC = await rispondi(caldoW.badge_code, 'caldo', { now: at(exC.timestamp_server, 2) });
    const { data: rowC } = await supabase.from('presence_log_reasons').select('reason, stato').eq('presence_log_id', exC.id).single();
    check('"Fa troppo caldo" salvato da confermare', rC.saved && rowC.reason === 'caldo' && rowC.stato === 'da_confermare', rowC);
    const pC = (await proposte(cid, { today: luglio })).find(x => x.kind === 'caldo' && x.day === luglio);
    check('proposta "caldo" a parte, con la persona', pC?.persone.length === 1 && pC.persone[0].uscita === '13:00', pC);
    const cellC = async () => (await buildOreMese(cid, '2026-07', { today: luglio })).lavoratori.find(l => l.id === caldoW.id)?.cells.find(c => c.date === luglio);
    check('prima della conferma: nessuna ora di maltempo', (await cellC())?.maltempoMin === 0, await cellC());
    const fC = await conferma({ companyId: cid, siteId: site.id, day: luglio, kind: 'caldo', today: luglio });
    check('conferma caldo: motivo confermato, nessuna sospensione automatica', fC.reasonIds.length === 1 && fC.sospensione === false, fC);
    check('...ore di caldo nel foglio (colonna maltempo)', (await cellC())?.maltempoMin > 0, await cellC());
    await annulla({ companyId: cid, ...fC });
    check('Annulla caldo: di nuovo da confermare', (await proposte(cid, { today: luglio })).some(x => x.kind === 'caldo' && x.day === luglio));

    // ── Pausa saltata: esce 60–90 minuti prima ──
    const giorno = lastWorkday(romeDay(new Date()));
    const pausaW = await mk('Pausa'); await storico(pausaW, giorno);
    await log(pausaW, 'ENTRY', giorno, '07:30'); const exP = await log(pausaW, 'EXIT', giorno, '16:00');
    const qP = await domanda(pausaW.badge_code, at(exP.timestamp_server, 2));
    check('esce alle 16 (solito 17): domanda con "Ho saltato la pausa"', qP.ask && qP.pausa === true, qP);
    check('a ottobre niente "Fa troppo caldo"', qP.caldo === false, qP);
    await rispondi(pausaW.badge_code, 'pausa_saltata', { now: at(exP.timestamp_server, 2) });
    const cellP = async () => (await buildOreMese(cid, giorno.slice(0, 7), { today: giorno })).lavoratori.find(l => l.id === pausaW.id)?.cells.find(c => c.date === giorno);
    const prima = await cellP();
    const pend = (await pauseDaConfermare(cid)).find(x => x.workerId === pausaW.id);
    check('pausa saltata da confermare per il titolare', pend?.day === giorno && pend.uscita === '16:00', pend);
    const fP = await confermaPausa({ companyId: cid, reasonId: pend.reasonId });
    const { data: ov } = await supabase.from('presence_lunch_overrides').select('id').eq('worker_id', pausaW.id).eq('work_date', giorno);
    check('conferma: "niente pausa oggi" scritto', fP.overrideId && ov?.length === 1, ov);
    const dopo = await cellP();
    check('...la pausa non si toglie più (ore più alte)', prima.pausaMin > 0 && dopo.pausaMin === 0 && dopo.ore > prima.ore, { prima, dopo });
    await annullaPausa({ companyId: cid, reasonId: pend.reasonId });
    const { data: ov2 } = await supabase.from('presence_lunch_overrides').select('id').eq('worker_id', pausaW.id).eq('work_date', giorno);
    check('Annulla: "niente pausa oggi" tolto, di nuovo da confermare', !ov2?.length && (await pauseDaConfermare(cid)).some(x => x.reasonId === pend.reasonId), ov2);
    const lontano = await mk('Lontano'); await storico(lontano, giorno);
    await log(lontano, 'ENTRY', giorno, '07:30'); const exL = await log(lontano, 'EXIT', giorno, '14:00');
    check('esce 3 ore prima: niente "Ho saltato la pausa"', (await domanda(lontano.badge_code, at(exL.timestamp_server, 2))).pausa === false);

    // ── Entrata in ritardo ──
    const tardi = await mk('Tardi'); await storico(tardi, giorno);
    const enT = await log(tardi, 'ENTRY', giorno, '10:00');
    const qT = await domandaEntrata(tardi.badge_code, at(enT.timestamp_server, 2));
    check('entra alle 10 (solito 7:30): domanda', qT.ask === true && qT.entrata_solita === '07:30', qT);
    await rispondiEntrata(tardi.badge_code, 'maltempo', { now: at(enT.timestamp_server, 2) });
    const { data: rowT } = await supabase.from('presence_log_reasons').select('reason, stato').eq('presence_log_id', enT.id).single();
    check('"Pioveva" salvato sull\'entrata, da confermare', rowT.reason === 'ritardo_maltempo' && rowT.stato === 'da_confermare', rowT);
    await log(tardi, 'EXIT', giorno, '17:00');
    const pT = (await proposte(cid, { today: giorno })).find(x => x.kind === 'pioggia' && x.day === giorno);
    const persT = pT?.persone.find(p => p.workerId === tardi.id);
    check('nella card della pioggia: "entrato alle 10:00"', persT?.entrata === '10:00' && persT.uscita === null, pT);
    const fT = await conferma({ companyId: cid, siteId: site.id, day: giorno, kind: 'pioggia', today: giorno });
    const cellT = (await buildOreMese(cid, giorno.slice(0, 7), { today: giorno })).lavoratori.find(l => l.id === tardi.id)?.cells.find(c => c.date === giorno);
    check('confermata: ore di pioggia del mattino nel foglio', fT.reasonIds.includes(persT.reasonId) && cellT?.maltempoMin === persT.oreMin && persT.oreMin > 0, { cellT, persT });

    const medico = await mk('Medico'); await storico(medico, giorno);
    const enM = await log(medico, 'ENTRY', giorno, '11:00');
    await rispondiEntrata(medico.badge_code, 'visita_medica', { now: at(enM.timestamp_server, 1) });
    await log(medico, 'EXIT', giorno, '17:00');
    const cellM = (await buildOreMese(cid, giorno.slice(0, 7), { today: giorno })).lavoratori.find(l => l.id === medico.id)?.cells.find(c => c.date === giorno);
    check('"Visita medica": conta subito come permesso', cellM?.permessoMin > 0, cellM);

    const puntuale = await mk('Puntuale'); await storico(puntuale, giorno);
    const enO = await log(puntuale, 'ENTRY', giorno, '08:00');
    check('entra mezz\'ora dopo: nessuna domanda', (await domandaEntrata(puntuale.badge_code, at(enO.timestamp_server, 1))).ask === false);
    const enO2 = await log(puntuale, 'EXIT', giorno, '12:00').then(() => log(puntuale, 'ENTRY', giorno, '13:30'));
    check('rientro dopo pranzo: non è la prima entrata, nessuna domanda', (await domandaEntrata(puntuale.badge_code, at(enO2.timestamp_server, 1))).error === 'NOT_FIRST_ENTRY');
    check('motivo d\'entrata inventato rifiutato', (await rispondiEntrata(tardi.badge_code, 'sciopero', { now: at(enT.timestamp_server, 3) })).error === 'INVALID_REASON');
  } finally {
    const { data: logs } = await supabase.from('presence_logs').select('id').eq('company_id', cid);
    if (logs?.length) await supabase.from('presence_log_reasons').delete().in('presence_log_id', logs.map(l => l.id));
    for (const t of ['presence_lunch_overrides', 'notifications', 'worker_absences', 'site_suspension_days', 'site_weather_logs', 'admin_audit_log']) await supabase.from(t).delete().eq('company_id', cid);
    await supabase.from('presence_logs').delete().eq('company_id', cid);
    await supabase.from('workers').delete().eq('company_id', cid);
    await supabase.from('sites').delete().eq('company_id', cid);
    await supabase.from('companies').delete().eq('id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
