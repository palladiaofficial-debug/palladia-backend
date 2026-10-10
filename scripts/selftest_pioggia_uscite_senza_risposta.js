#!/usr/bin/env node
/**
 * scripts/selftest_pioggia_uscite_senza_risposta.js — F-322 (AUDIT.md del frontend).
 *
 * Corso Sardegna 88, mercoledì 7/10: pioggia oltre soglia, i 4 operai escono
 * alle 13:30 (di solito alle 17) e nessuno risponde alla domanda all'uscita.
 * Prima la proposta era di tipo "lavorato" e finiva in "Nessuna ora di
 * pioggia". Ora:
 *   - la proposta è di tipo "uscite", con chi è uscito presto (senza risposta);
 *   - conferma: ore di pioggia nel foglio + sospensione; Annulla toglie tutto;
 *   - "Nessuna ora di pioggia" in blocco NON la tocca;
 *   - giornata di pioggia con giornata piena: resta "lavorato" (non si chiede);
 *   - chi esce presto all'ora della pausa e rientra non conta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { proposte, conferma, annulla, scartaSenzaOre } = require('../lib/pioggiaDaConfermare');
const { buildOreMese } = require('../lib/oreMese');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F322-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const romeDay = (d) => d.toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function romeIso(day, hm) {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName').value;
  const h = Number(off.replace('GMT', '') || 0);
  return new Date(Date.parse(`${day}T${hm}:00Z`) - h * 3600e3).toISOString();
}
const isWorkday = (d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
function workdaysBefore(day, n) { const out = []; let d = day; while (out.length < n) { d = addDays(d, -1); if (isWorkday(d)) out.push(d); } return out; }

async function main() {
  console.log('\n\x1b[1mF-322 — pioggia con uscite anticipate senza risposta\x1b[0m');
  const company = await ins('companies', { name: T });
  const cid = company.id;
  try {
    let today = romeDay(new Date());
    while (!isWorkday(today)) today = addDays(today, -1);
    const [giornoPioggia, giornoPieno] = workdaysBefore(today, 2);
    const storico = workdaysBefore(giornoPieno, 6);
    const site = await ins('sites', { company_id: cid, name: `${T} Corso Sardegna`, address: 'Corso Sardegna 88, Genova', status: 'attivo', start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi' });
    const mk = (n) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F322${n}${stamp}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase() });
    const ibra = await mk('Ibrahim'), giuse = await mk('Giuseppe'), suri = await mk('Suriya');
    const log = (w, type, day, hm) => ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: romeIso(day, hm), method: 'worker_self_punch' });
    for (const d of storico) for (const w of [ibra, giuse, suri]) { await log(w, 'ENTRY', d, '07:30'); await log(w, 'EXIT', d, '17:00'); }
    // Giorno di pioggia: Ibrahim e Giuseppe escono alle 13:30 e non tornano;
    // Suriya esce alle 12:00 per la pausa e rientra alle 13:00 fino alle 17
    await log(ibra, 'ENTRY', giornoPioggia, '07:30'); await log(ibra, 'EXIT', giornoPioggia, '13:30');
    await log(giuse, 'ENTRY', giornoPioggia, '07:45'); await log(giuse, 'EXIT', giornoPioggia, '13:28');
    await log(suri, 'ENTRY', giornoPioggia, '07:30'); await log(suri, 'EXIT', giornoPioggia, '12:00'); await log(suri, 'ENTRY', giornoPioggia, '13:00'); await log(suri, 'EXIT', giornoPioggia, '17:00');
    // Giorno dopo: piove ma lavorano tutti fino alle 17
    for (const w of [ibra, giuse, suri]) { await log(w, 'ENTRY', giornoPieno, '07:30'); await log(w, 'EXIT', giornoPieno, '17:00'); }
    const meteo = (day, mm) => ins('site_weather_logs', { company_id: cid, site_id: site.id, log_date: day, precipitation_mm: mm, wind_max_kmh: 20, weather_code: 63, weather_desc: 'pioggia', threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', fetched_at: new Date().toISOString() });
    await meteo(giornoPioggia, 4.6); await meteo(giornoPieno, 5.8);

    const lista = await proposte(cid, { today });
    const p = lista.find(x => x.siteId === site.id && x.day === giornoPioggia);
    const pieno = lista.find(x => x.siteId === site.id && x.day === giornoPieno);
    check('giorno di pioggia con uscite alle 13:30: tipo "uscite", non "lavorato"', p?.tipo === 'uscite', p && { tipo: p.tipo, persone: p.persone });
    const pI = p?.persone.find(x => x.workerId === ibra.id), pG = p?.persone.find(x => x.workerId === giuse.id);
    check('Ibrahim e Giuseppe nella proposta, senza risposta, con l\'ora di uscita', pI?.uscita === '13:30' && pG?.uscita === '13:28' && pI.senzaRisposta === true && pI.oreMin > 0, { pI, pG });
    check('Suriya (pausa e rientro, fino alle 17) non è nella proposta', !p?.persone.some(x => x.workerId === suri.id), p?.persone);
    check('giorno di pioggia con giornata piena: resta "lavorato"', pieno?.tipo === 'lavorato', pieno && { tipo: pieno.tipo, persone: pieno.persone });

    // "Nessuna ora di pioggia" in blocco chiude solo il giorno pieno
    const bulk = await scartaSenzaOre({ companyId: cid });
    check('"Nessuna ora di pioggia" in blocco: chiude il giorno pieno, non il 13:30', bulk.fatti.some(f => f.day === giornoPieno) && !bulk.fatti.some(f => f.day === giornoPioggia), bulk);

    const cellOf = async (w) => (await buildOreMese(cid, giornoPioggia.slice(0, 7), { today })).lavoratori.find(l => l.id === w.id)?.cells.find(c => c.date === giornoPioggia);
    check('prima della conferma: nessuna ora di pioggia', (await cellOf(ibra))?.maltempoMin === 0, await cellOf(ibra));
    const fatto = await conferma({ companyId: cid, siteId: site.id, day: giornoPioggia, today });
    check('conferma: 2 motivi scritti dal titolare + sospensione', fatto.nuoviMotivi.length === 2 && fatto.sospensione === true, fatto);
    const cI = await cellOf(ibra);
    check('foglio: ore di pioggia per Ibrahim come proposto', cI?.maltempoMin === pI.oreMin && cI.maltempoMin > 0, cI);
    check('la proposta sparisce', !(await proposte(cid, { today })).some(x => x.siteId === site.id && x.day === giornoPioggia));
    await annulla({ companyId: cid, ...fatto });
    const { count: left } = await supabase.from('presence_log_reasons').select('id', { count: 'exact', head: true }).eq('company_id', cid);
    check('Annulla: motivi tolti, niente ore di pioggia', left === 0 && (await cellOf(ibra))?.maltempoMin === 0, { left });
    check('Annulla: la proposta torna', (await proposte(cid, { today })).some(x => x.siteId === site.id && x.day === giornoPioggia && x.tipo === 'uscite'));
  } finally {
    const { data: logs } = await supabase.from('presence_logs').select('id').eq('company_id', cid);
    if (logs?.length) await supabase.from('presence_log_reasons').delete().in('presence_log_id', logs.map(l => l.id));
    for (const t of ['notifications', 'worker_absences', 'site_suspension_days', 'site_weather_logs', 'admin_audit_log']) await supabase.from(t).delete().eq('company_id', cid);
    await supabase.from('presence_logs').delete().eq('company_id', cid);
    await supabase.from('workers').delete().eq('company_id', cid);
    await supabase.from('sites').delete().eq('company_id', cid);
    await supabase.from('companies').delete().eq('id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
