#!/usr/bin/env node
/**
 * scripts/selftest_uscita_anticipata_pioggia.js — F-318 (AUDIT.md del frontend).
 *
 * Il titolare (9/10): "i miei operai dicono che non hanno queste opzioni"
 * (pioggia, permesso, malattia). Verificato: zero motivi d'uscita, zero
 * assenze, 54 giornate di pioggia mai confermate. Questo test rifà il percorso:
 *   - la domanda arriva SOLO a chi esce almeno un'ora prima del solito, mai a
 *     un operaio nuovo, mai all'ora della pausa abituale;
 *   - "Piove" dall'operaio non conta nel foglio finché il titolare non conferma;
 *   - conferma: ore di pioggia = ore mancanti alle 8 (rientro compreso),
 *     sospensione legale del cantiere; Annulla rimette tutto com'era;
 *   - giornata intera senza timbrature: 8 ore di maltempo a chi di solito c'è;
 *   - "Mi sono fatto male": avviso critico in Da fare;
 *   - "Sono malato" dall'Area lavoratore: conta subito, protocollo anche dopo.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabase');
const { decidi, domanda, rispondi } = require('../lib/uscitaAnticipata');
const { proposte, conferma, scarta, annulla } = require('../lib/pioggiaDaConfermare');
const { buildOreMese } = require('../lib/oreMese');
const { buildDaFare } = require('../lib/daFare');
const { signWorkerToken } = require('../lib/workerAuth');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F318-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const romeDay = (d) => d.toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Istante ISO per giorno + ora italiana (ora legale compresa)
function romeIso(day, hm) {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName').value; // GMT+2
  const h = Number(off.replace('GMT', '') || 0);
  return new Date(Date.parse(`${day}T${hm}:00Z`) - h * 3600e3).toISOString();
}
// Giorni lavorativi prima di oggi
function workdaysBefore(today, n) {
  const out = []; let d = today;
  while (out.length < n) { d = addDays(d, -1); const dow = new Date(`${d}T12:00:00Z`).getUTCDay(); if (dow !== 0 && dow !== 6) out.push(d); }
  return out;
}

async function main() {
  console.log('\n\x1b[1mF-318 — pioggia, permesso, malattia e infortunio\x1b[0m');

  // ── Regola della domanda (pura) ──
  const ab = (uscite, rientri = []) => ({ giorni: uscite.length, uscitaSolita: uscite.length ? [...uscite].sort((a, b) => a - b)[Math.floor(uscite.length / 2)] : null, usciteRientrate: uscite.map((_, i) => rientri[i] || []) });
  check('operaio nuovo (3 giorni): nessuna domanda', decidi(ab([1020, 1020, 1020]), 660).ask === false);
  check('esce alle 16:30 (solito 17:00): nessuna domanda', decidi(ab(Array(6).fill(1020)), 990).ask === false);
  check('esce alle 11:00 (solito 17:00): domanda', decidi(ab(Array(6).fill(1020)), 660).ask === true);
  check('esce alle 12:00 ma di solito a quell\'ora fa la pausa e rientra: nessuna domanda',
    decidi(ab(Array(6).fill(1020), Array(6).fill([720])), 725).ask === false);

  const company = await ins('companies', { name: T });
  const cid = company.id;
  const app = express(); app.use(express.json()); app.set('trust proxy', 1);
  app.use('/api/v1', require('../routes/v1/workerAreaMalattia'));
  app.use('/api/v1', require('../routes/v1/badgeUscitaAnticipata'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const today = romeDay(new Date());
    const site = await ins('sites', { company_id: cid, name: `${T} Via Lucarno`, address: 'Via Lucarno 14, Genova', status: 'attivo', start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi' });
    const site2 = await ins('sites', { company_id: cid, name: `${T} Via Verdi`, address: 'Via Verdi 13, Savona', status: 'attivo', start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi' });
    const mk = (n) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F318${n}${stamp}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase() });
    const arben = await mk('Arben');
    const ion = await mk('Ion');
    const nuovo = await mk('Nuovo');
    const log = (w, s, type, day, hm) => ins('presence_logs', { company_id: cid, site_id: s.id, worker_id: w.id, event_type: type, timestamp_server: romeIso(day, hm), method: 'worker_self_punch' });

    // Storico: 6 giorni 7:30–17:00 per Arben e Ion; il "nuovo" solo 2
    const prima = workdaysBefore(today, 6);
    for (const d of prima) { for (const w of [arben, ion]) { await log(w, site, 'ENTRY', d, '07:30'); await log(w, site, 'EXIT', d, '17:00'); } }
    for (const d of prima.slice(0, 2)) { await log(nuovo, site, 'ENTRY', d, '07:30'); await log(nuovo, site, 'EXIT', d, '17:00'); }

    // Oggi: escono alle 11; Ion rientra alle 14 ed esce alle 17
    await log(arben, site, 'ENTRY', today, '07:30'); const exA = await log(arben, site, 'EXIT', today, '11:00');
    await log(nuovo, site, 'ENTRY', today, '07:30'); await log(nuovo, site, 'EXIT', today, '11:00');
    const at = (iso, min) => new Date(Date.parse(iso) + min * 60000);
    const qA = await domanda(arben.badge_code, at(exA.timestamp_server, 2));
    check('Arben esce alle 11 (solito 17): la domanda arriva', qA.ask === true && qA.uscita_solita === '17:00', qA);
    const qN = await domanda(nuovo.badge_code, at(exA.timestamp_server, 2));
    check('operaio nuovo: nessuna domanda', qN.ask === false, qN);
    const qOld = await domanda(arben.badge_code, at(exA.timestamp_server, 45));
    check('uscita di 45 minuti fa: troppo vecchia', qOld.error === 'EXIT_TOO_OLD', qOld);

    const rA = await rispondi(arben.badge_code, 'maltempo', { now: at(exA.timestamp_server, 2) });
    check('"Piove" salvato', rA.ok && rA.saved, rA);
    const { data: rowA } = await supabase.from('presence_log_reasons').select('reason, stato, da_lavoratore').eq('presence_log_id', exA.id).single();
    check('...come da confermare, dichiarato dall\'operaio', rowA.stato === 'da_confermare' && rowA.da_lavoratore === true, rowA);
    const again = await rispondi(arben.badge_code, 'maltempo', { now: at(exA.timestamp_server, 3) });
    check('doppio tocco: nessun doppione', again.unchanged === true, again);
    check('"Ho finito": niente da salvare', (await rispondi(arben.badge_code, 'fine', { now: at(exA.timestamp_server, 3) })).saved === false);
    check('motivo inventato rifiutato', (await rispondi(arben.badge_code, 'vacanza', { now: at(exA.timestamp_server, 3) })).error === 'INVALID_REASON');

    // Ion: esce alle 11 con "Piove", rientra alle 14, esce alle 17
    await log(ion, site, 'ENTRY', today, '07:30'); const exI = await log(ion, site, 'EXIT', today, '11:00');
    await rispondi(ion.badge_code, 'maltempo', { now: at(exI.timestamp_server, 1) });
    await log(ion, site, 'ENTRY', today, '14:00'); await log(ion, site, 'EXIT', today, '17:00');

    const month = today.slice(0, 7);
    const cellOf = async (w) => (await buildOreMese(cid, month, { today })).lavoratori.find(l => l.id === w.id)?.cells.find(c => c.date === today);
    check('prima della conferma: nessuna ora di pioggia nel foglio', (await cellOf(arben))?.maltempoMin === 0, await cellOf(arben));

    // Proposta per il titolare
    const p1 = (await proposte(cid, { today })).find(x => x.siteId === site.id && x.day === today);
    const pA = p1?.persone.find(p => p.workerId === arben.id), pI = p1?.persone.find(p => p.workerId === ion.id);
    check('proposta: cantiere e giorno, tipo "uscite"', p1?.tipo === 'uscite', p1);
    check('Arben: uscito 11:00, non rientrato', pA?.uscita === '11:00' && pA.rientro === null && pA.oreMin > 0, pA);
    check('Ion: rientrato alle 14:00, meno ore di pioggia di Arben', pI?.rientro === '14:00' && pI.oreMin < pA.oreMin, pI);

    const fatto = await conferma({ companyId: cid, siteId: site.id, day: today, userId: null, today });
    check('conferma: 2 motivi confermati', fatto.reasonIds.length === 2, fatto);
    const cA = await cellOf(arben), cI = await cellOf(ion);
    check('dopo la conferma: ore di pioggia nel foglio (Arben)', cA?.maltempoMin === pA.oreMin, cA);
    check('...e Ion ha quelle calcolate col rientro', cI?.maltempoMin === pI.oreMin, cI);
    check('la proposta sparisce', !(await proposte(cid, { today })).some(x => x.siteId === site.id && x.day === today));

    await annulla({ companyId: cid, ...fatto });
    check('Annulla: di nuovo da confermare', (await proposte(cid, { today })).some(x => x.siteId === site.id && x.day === today && x.persone.length === 2));
    check('Annulla: niente più ore di pioggia', (await cellOf(arben))?.maltempoMin === 0);

    const sc = await scarta({ companyId: cid, siteId: site.id, day: today });
    const { data: rowS } = await supabase.from('presence_log_reasons').select('stato').eq('presence_log_id', exA.id).single();
    check('"Non era pioggia": motivo scartato, nessuna ora', rowS.stato === 'scartato' && (await cellOf(arben))?.maltempoMin === 0, rowS);
    await annulla({ companyId: cid, ...sc });

    // Giornata intera: pioggia ieri su Via Verdi, nessuno ha timbrato; Gallo e Riva ci lavorano di solito
    // (Arben e Ion ieri hanno lavorato a Via Lucarno: niente 8 ore di pioggia per loro)
    const ieri = workdaysBefore(today, 1)[0];
    const prima2 = workdaysBefore(ieri, 3);
    const gallo = await mk('Gallo'), riva = await mk('Riva');
    for (const d of prima2) for (const w of [gallo, riva]) { await log(w, site2, 'ENTRY', d, '07:30'); await log(w, site2, 'EXIT', d, '17:00'); }
    await ins('site_weather_logs', { company_id: cid, site_id: site2.id, log_date: ieri, precipitation_mm: 32, wind_max_kmh: 20, weather_code: 63, weather_desc: 'pioggia', threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', fetched_at: new Date().toISOString() });
    const pG = (await proposte(cid, { today })).find(x => x.siteId === site2.id && x.day === ieri);
    check('giornata intera: proposta con chi di solito c\'è', pG?.tipo === 'giornata' && pG.giornataIntera.length === 2 && pG.giornataIntera.every(g => g.oreMin === 480), pG);
    const fG = await conferma({ companyId: cid, siteId: site2.id, day: ieri, userId: null, today });
    check('conferma: 2 giornate di maltempo + sospensione del cantiere', fG.absenceIds.length === 2 && fG.sospensione === true, fG);
    const { data: susp } = await supabase.from('site_suspension_days').select('id').eq('site_id', site2.id).eq('day', ieri);
    check('...la sospensione legale esiste', susp?.length === 1, susp);
    const cellIeri = (await buildOreMese(cid, ieri.slice(0, 7), { today })).lavoratori.find(l => l.id === gallo.id)?.cells.find(c => c.date === ieri);
    check('foglio: 8 ore di maltempo (T) per Gallo', cellIeri?.tipo === 'maltempo' && cellIeri.maltempoMin === 480, cellIeri);
    await annulla({ companyId: cid, ...fG });
    const { count: absLeft } = await supabase.from('worker_absences').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('tipo', 'maltempo');
    const { data: susp2 } = await supabase.from('site_suspension_days').select('id').eq('site_id', site2.id).eq('day', ieri);
    check('Annulla: assenze e sospensione tolte', absLeft === 0 && !susp2?.length, { absLeft, susp2 });

    // Infortunio
    const exAll = await log(arben, site, 'ENTRY', today, '15:00').then(() => log(arben, site, 'EXIT', today, '15:10'));
    const inj = await rispondi(arben.badge_code, 'infortunio', { now: at(exAll.timestamp_server, 1) });
    const { data: nInj } = await supabase.from('notifications').select('type, severity, title').eq('company_id', cid).eq('type', 'worker_injury');
    check('"Mi sono fatto male": avviso critico', inj.saved && nInj?.length === 1 && nInj[0].severity === 'critical', nInj);
    const df = await buildDaFare(cid, null, { todayStr: today });
    const itInj = df.items.find(i => i.type === 'worker_injury');
    check('...in Da fare, in cima e urgente', itInj?.bucket === 'scaduto' && itInj.urgent === true, itInj);

    // Malattia dall'Area lavoratore
    const tok = signWorkerToken({ workerId: ion.id, companyId: cid, badgeCode: ion.badge_code });
    const call = async (method, path, body) => {
      const r = await fetch(`${base}/area/${ion.badge_code}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `WorkerArea ${tok}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    check('malattia senza PIN: rifiutata', (await fetch(`${base}/area/${ion.badge_code}/malattia`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dal: today }) })).status === 401);
    check('malattia di un mese fa: rifiutata', (await call('POST', '/malattia', { dal: addDays(today, -30) })).status === 400);
    const m = await call('POST', '/malattia', { dal: today });
    check('"Sono malato" da oggi: comunicata subito (approvata)', m.status === 201 && m.body.stato === 'approvata' && m.body.tipo === 'malattia' && !m.body.protocollo, m);
    check('doppio tocco: stessa malattia, nessun doppione', (await call('POST', '/malattia', { dal: today })).body.id === m.body.id);
    const p = await call('PATCH', `/malattia/${m.body.id}`, { protocollo: ' 123456789 ' });
    check('numero del certificato mandato dopo', p.status === 200 && p.body.protocollo === '123456789', p);
    const { data: nIll } = await supabase.from('notifications').select('type').eq('company_id', cid).eq('type', 'worker_illness');
    check('il titolare riceve l\'avviso', nIll?.length === 1, nIll);

    check('rotta: codice badge non valido → 400', (await fetch(`${base}/badge/XYZ/uscita-anticipata`)).status === 400);
  } finally {
    server.close();
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
