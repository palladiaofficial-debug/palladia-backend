#!/usr/bin/env node
/**
 * scripts/selftest_f481_motivi_mese_lungo.js — F-481 (AUDIT.md del frontend).
 *
 * «Ci sono giorni di pioggia. 2 se non sbaglio.» Le uscite per pioggia
 * confermate di ottobre (MSC, 500 timbrature) sparivano dalle ore del mese:
 * latestReasonsByLogId chiedeva i motivi di tutte le timbrature con una sola
 * .in(): URL troppo lungo, «fetch failed», errore ignorato, mappa vuota.
 * Qui: un'azienda di prova con un'uscita per pioggia confermata, cercata
 * insieme ad altri 600 id (come un mese pieno). Poi il mese con pioggia.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { latestReasonsByLogId } = require('../lib/presenceLogReasons');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F481-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-481 — motivi d\'uscita confermati con un mese pieno di timbrature\x1b[0m');
  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Balbi`, address: 'Via Test 481', status: 'attivo' });
    const w = await ins('workers', { company_id: company.id, full_name: `${T} Lika`, is_active: true, fiscal_code: `F481AAAA${stamp}`, badge_code: `F481A${stamp}` });
    const log = (type, ts) => ins('presence_logs', { company_id: company.id, site_id: site.id, worker_id: w.id, event_type: type, timestamp_server: ts, method: 'scan' });
    // mar 3 febbraio: 07:36 → 10:34 uscito per pioggia (come Lika Elton il 20/10)
    await log('ENTRY', '2026-02-03T07:36:00+01:00');
    const uscita = await log('EXIT', '2026-02-03T10:34:00+01:00');
    await ins('presence_log_reasons', { company_id: company.id, presence_log_id: uscita.id, reason: 'maltempo', stato: 'confermato' });

    const finti = Array.from({ length: 600 }, () => crypto.randomUUID());
    let mappa = null, errore = null;
    try { mappa = await latestReasonsByLogId(company.id, [...finti, uscita.id]); } catch (e) { errore = e.message; }
    check('con 601 id il motivo confermato si trova (prima: richiesta troppo lunga, mappa vuota)', !!mappa && mappa.get(uscita.id)?.reason === 'maltempo', errore || (mappa && [...mappa.keys()].length));
    const poche = await latestReasonsByLogId(company.id, [uscita.id]);
    check('con un id solo funziona come prima', poche.get(uscita.id)?.reason === 'maltempo');

    // Il mese: la pioggia conta, non è «uscito prima»
    const { buildOreMese } = require('../lib/oreMese');
    const mese = await buildOreMese(company.id, '2026-02', { today: '2026-03-01' });
    const c = mese.lavoratori.find(l => l.id === w.id).cells.find(x => x.date === '2026-02-03');
    check('mese: 3/2 conta 2 h 34 (08:00–10:34) + pioggia 5 h 26, non «uscito prima»', c.ore === 154 && c.maltempoMin === 326 && c.uscitoPrima === 0 && c.uscitoPer === 'pioggia', c);
  } finally {
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
