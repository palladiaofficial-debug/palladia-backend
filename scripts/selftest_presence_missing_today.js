#!/usr/bin/env node
/**
 * scripts/selftest_presence_missing_today.js — F-285 (AUDIT.md del frontend).
 *
 * Il titolare: "non si capisce chi manchi, bisogna controllare uno per uno".
 * Contro il DB vero (azienda di prova): lib/presenceMissing.missingToday
 *  - chi timbra di solito e oggi no → mancante, con l'ultima timbratura;
 *  - chi ha già timbrato oggi → no;
 *  - chi non timbra mai (ufficio/titolare) → no;
 *  - chi ha l'ultima timbratura oltre 14 giorni fa → no;
 *  - ferie approvate oggi → a parte, con il motivo; ferie solo richieste → mancante;
 *  - lavoratore disattivato o in attesa di approvazione → no.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { missingToday } = require('../lib/presenceMissing');
const { romeDate, addDays } = require('../lib/daFare');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F285-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

async function main() {
  console.log('\n\x1b[1mF-285 — chi non ha timbrato oggi\x1b[0m');
  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via Test 285', status: 'attivo' });
    let n = 0;
    const worker = (label, extra = {}) => { n++; return ins('workers', { company_id: company.id, full_name: `${T} ${label}`, is_active: true, fiscal_code: `F285${Date.now()}${n}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), ...extra }); };
    const log = (w, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: 'ENTRY', timestamp_server: ts, method: 'worker_self_punch' });

    const solito = await worker('Solito');            await log(solito, daysAgo(3));
    const oggi = await worker('Oggi');                await log(oggi, daysAgo(3)); await log(oggi, new Date().toISOString());
    const ufficio = await worker('Ufficio');
    const vecchio = await worker('Vecchio');          await log(vecchio, daysAgo(20));
    const ferie = await worker('Ferie');              await log(ferie, daysAgo(2));
    const richiesta = await worker('Richiesta');      await log(richiesta, daysAgo(2));
    const spento = await worker('Spento', { is_active: false }); await log(spento, daysAgo(2));
    const attesa = await worker('Attesa', { pending_approval: true }); await log(attesa, daysAgo(2));
    const today = romeDate();
    await ins('worker_absences', { company_id: company.id, worker_id: ferie.id, tipo: 'ferie', date_from: addDays(today, -1), date_to: addDays(today, 1), stato: 'approvata' });
    await ins('worker_absences', { company_id: company.id, worker_id: richiesta.id, tipo: 'ferie', date_from: today, date_to: today, stato: 'richiesta' });

    const r = await missingToday(company.id);
    const names = (list) => list.map(x => x.full_name.replace(`${T} `, '')).sort().join(',');
    check('mancanti: chi timbra di solito e oggi no (anche con ferie solo richieste)', names(r.missing) === 'Richiesta,Solito', r.missing);
    check('…con l\'ora dell\'ultima timbratura', Math.abs(Date.parse(r.missing.find(x => x.worker_id === solito.id)?.last_at) - Date.parse(daysAgo(3))) < 5000, r.missing);
    check('in ferie approvate oggi: a parte, con il motivo', names(r.absent) === 'Ferie' && r.absent[0].tipo === 'ferie', r.absent);
    check('esclusi: chi ha timbrato oggi, ufficio, oltre 14 giorni, disattivato, in attesa', ![oggi, ufficio, vecchio, spento, attesa].some(w => [...r.missing, ...r.absent].some(x => x.worker_id === w.id)), r);
    check('conta chi ha timbrato oggi', r.punched === 1, r.punched);
  } finally {
    await supabase.from('worker_absences').delete().eq('company_id', company.id);
    await supabase.from('presence_logs').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
