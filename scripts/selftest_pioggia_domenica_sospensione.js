#!/usr/bin/env node
/**
 * scripts/selftest_pioggia_domenica_sospensione.js — F-385 e F-386 (AUDIT.md del frontend).
 *
 * F-385, il titolare (19/10): «la domenica non si lavora», davanti a
 * «Ieri, domenica 18/10 · Corso Sardegna 88 — Giornata intera di pioggia: 8 ore
 * a testa». La giornata intera di pioggia si propone solo nei giorni lavorativi
 * (stessa regola del foglio del mese: niente sabato, domenica, festivi); di
 * domenica la pioggia senza nessuno in cantiere va tra le giornate «senza ore»
 * e confermarla non scrive ore di maltempo a nessuno. Di venerdì, invece, sì.
 *
 * F-386, il titolare: «Carlos è stato sospeso, metti la funzione». Un giorno
 * si giustifica come sospensione: il database la accetta, il foglio del mese la
 * conta (non è più un giorno da giustificare), il foglio per il consulente la
 * scrive con il suo codice (S, causale SOS) e la sua colonna, in fondo.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { proposte, conferma } = require('../lib/pioggiaDaConfermare');
const { buildOreMese } = require('../lib/oreMese');
const { movimenti, cellCode, generateFoglioXlsx } = require('../lib/oreMeseFoglio');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F385-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const romeDay = (d) => d.toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dow = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
function romeIso(day, hm) {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName').value;
  const h = Number(off.replace('GMT', '') || 0);
  return new Date(Date.parse(`${day}T${hm}:00Z`) - h * 3600e3).toISOString();
}
const meteo = (cid, siteId, day) => ins('site_weather_logs', { company_id: cid, site_id: siteId, log_date: day, precipitation_mm: 29.2, wind_max_kmh: 20, weather_code: 63, weather_desc: 'pioggia', threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', fetched_at: new Date().toISOString() });

async function main() {
  console.log('\n\x1b[1mF-385 — pioggia di domenica · F-386 — sospensione\x1b[0m');
  const today = romeDay(new Date());
  // L'ultima domenica prima di oggi e il venerdì prima di quella
  let domenica = addDays(today, -1);
  while (dow(domenica) !== 0) domenica = addDays(domenica, -1);
  const venerdi = addDays(domenica, -2);

  const company = await ins('companies', { name: T });
  const cid = company.id;
  try {
    const site = await ins('sites', { company_id: cid, name: `${T} Corso Sardegna 88`, address: 'Corso Sardegna 88, Genova', status: 'attivo', start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi' });
    const mk = (n) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F385${n}${stamp}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase() });
    const ibrahim = await mk('Ibrahim'), suriya = await mk('Suriya');
    const log = (w, type, day, hm) => ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: romeIso(day, hm), method: 'worker_self_punch' });
    // Lavorano qui nei feriali delle due settimane prima del venerdì; Suriya il
    // mercoledì non viene (F-386: lo giustifichiamo come sospensione). Le
    // timbrature sono a sola aggiunta: il giorno vuoto si prepara non creandole.
    const mercoledi = addDays(venerdi, -2);
    for (let d = addDays(venerdi, -12); d < venerdi; d = addDays(d, 1)) {
      if ([0, 6].includes(dow(d))) continue;
      for (const w of [ibrahim, suriya]) {
        if (w === suriya && d === mercoledi) continue;
        await log(w, 'ENTRY', d, '08:00'); await log(w, 'EXIT', d, '17:00');
      }
    }
    // Pioggia forte il venerdì e la domenica, nessuno ha timbrato
    await meteo(cid, site.id, venerdi);
    await meteo(cid, site.id, domenica);

    const lista = await proposte(cid, { today });
    const pDom = lista.find(x => x.siteId === site.id && x.day === domenica);
    const pVen = lista.find(x => x.siteId === site.id && x.day === venerdi);
    check('venerdì: giornata intera di pioggia, 8 ore a chi di solito c\'è', pVen?.tipo === 'giornata' && pVen.giornataIntera.length === 2 && pVen.giornataIntera.every(g => g.oreMin === 480), pVen);
    check('domenica: niente «giornata intera», nessuna ora a nessuno', pDom && pDom.tipo !== 'giornata' && pDom.giornataIntera.length === 0, pDom);
    check('domenica: va tra le giornate senza ore («Nessuna ora di pioggia»)', pDom?.tipo === 'vuoto', pDom);

    const fDom = await conferma({ companyId: cid, siteId: site.id, day: domenica, userId: null, today });
    check('confermare la domenica non scrive ore di maltempo', fDom.absenceIds.length === 0, fDom);
    const { data: absDom } = await supabase.from('worker_absences').select('id').eq('company_id', cid).eq('date_from', domenica);
    check('...nessuna assenza di maltempo di domenica nel database', (absDom || []).length === 0, absDom);

    // ── F-386: un giorno feriale senza timbrature giustificato come sospensione ──
    const mese = mercoledi.slice(0, 7);
    const prima = (await buildOreMese(cid, mese, { today })).lavoratori.find(l => l.id === suriya.id);
    check('prima: il mercoledì senza timbrature è da giustificare', prima?.cells.find(c => c.date === mercoledi)?.tipo === 'giustificare', prima?.cells.find(c => c.date === mercoledi));
    const { error: errIns } = await supabase.from('worker_absences').insert({
      company_id: cid, worker_id: suriya.id, tipo: 'sospensione', date_from: mercoledi, date_to: mercoledi, stato: 'approvata', da_lavoratore: false,
    });
    check('il database accetta una sospensione (vincolo sul tipo)', !errIns, errIns?.message);
    const dato = await buildOreMese(cid, mese, { today });
    const s = dato.lavoratori.find(l => l.id === suriya.id);
    const cella = s?.cells.find(c => c.date === mercoledi);
    check('foglio del mese: il giorno è una sospensione, non più da giustificare', cella?.tipo === 'sospensione', cella);
    check('...contata nel mese (1 giorno) e senza domanda «Cos\'era?» per quel giorno', s?.tot.sospensioneGiorni === 1 && !dato.domande.some(d => d.tipo === 'giustificare' && d.workerId === suriya.id && d.giorni.includes(mercoledi)), s?.tot);
    check('calendario per il consulente: codice S', cellCode(cella) === 'S', cellCode(cella));
    const mov = movimenti(dato).find(m => m.cf === s.cf && m.data === mercoledi);
    check('movimenti (Excel): causale SOS, giornata intera', mov?.causale === 'SOS' && mov.min === dato.regole.oreGiornoMin, mov);
    const wb = await generateFoglioXlsx(dato, T);
    const buf = Buffer.isBuffer(wb) ? wb : Buffer.from(await wb);
    check('Excel generato', buf.length > 1000, buf.length);
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
