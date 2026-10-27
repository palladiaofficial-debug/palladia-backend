#!/usr/bin/env node
/**
 * scripts/selftest_sospeso_licenziato.js — F-396 (AUDIT.md del frontend).
 *
 * Il titolare: «serve la possibilità di poter mettere in sospensione o poter
 * licenziare un operaio. Così non esce sempre come timbratura assente o come
 * formazione scaduta ecc».
 *
 * Sospeso (assenza «sospensione» che copre oggi): non è tra chi non ha
 * timbrato e le sue scadenze non avvisano finché è sospeso; a fine sospensione
 * tornano. Non lavora più qui (giorno e motivo): esce da avvisi, elenchi e
 * timbrature; si può riattivare e allora tutto torna.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { problemiLavoratori } = require('../lib/documentiStato');
const { buildDaFare, romeDate, addDays } = require('../lib/daFare');
const { missingToday } = require('../lib/presenceMissing');
const { cessa, riattiva, sospensioni, conSospensione, MOTIVI } = require('../lib/rapportoLavoro');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F396-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const suoi = (p, id) => p.scadenze.filter(s => s.workerId === id).length + p.mancanti.filter(m => m.workerId === id).length;
const inDaFare = (df, id) => df.items.filter(i => i.entityId === id).length;
const rifiuta = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function main() {
  console.log('\n\x1b[1mF-396 — sospeso o non lavora più qui\x1b[0m');
  const today = romeDate();
  const company = await ins('companies', { name: T });
  const cid = company.id;
  try {
    const site = await ins('sites', { company_id: cid, name: `${T} cantiere`, address: 'Via Roma 1, Genova', status: 'attivo', start_date: '2026-01-01', contract_days: 365, days_type: 'lavorativi' });
    const mk = (n) => ins('workers', {
      company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F396${n}${stamp}`.slice(0, 16),
      badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
      safety_training_expiry: addDays(today, 400), health_fitness_expiry: addDays(today, -20),
    });
    const binozi = await mk('Binozi'), carlos = await mk('Carlos');
    // Entrambi hanno timbrato ieri, oggi no
    for (const w of [binozi, carlos]) {
      await ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: 'ENTRY', timestamp_server: new Date(Date.now() - 864e5).toISOString(), method: 'worker_self_punch' });
    }

    const p0 = await problemiLavoratori(cid);
    check('prima: la visita scaduta di Binozi e di Carlos avvisa', suoi(p0, binozi.id) > 0 && suoi(p0, carlos.id) > 0, p0.scadenze);
    const m0 = await missingToday(cid, { today });
    check('prima: entrambi tra chi non ha timbrato', m0.missing.some(x => x.worker_id === binozi.id) && m0.missing.some(x => x.worker_id === carlos.id), m0);

    // ── Sospensione di Binozi da ieri a fra 4 giorni ──
    await ins('worker_absences', { company_id: cid, worker_id: binozi.id, tipo: 'sospensione', date_from: addDays(today, -1), date_to: addDays(today, 4), stato: 'approvata', da_lavoratore: false });
    const sosp = await sospensioni(cid, { today });
    check('sospensioni(): Binozi sospeso fino a fra 4 giorni', sosp.get(binozi.id)?.al === addDays(today, 4) && !sosp.has(carlos.id), [...sosp]);
    // Persone: l'elenco intero (l'azienda E2E ne ha 679) deve portare la sospensione
    const tanti = [...Array.from({ length: 700 }, () => ({ id: crypto.randomUUID() })), { id: binozi.id }, { id: carlos.id }];
    const elenco = await conSospensione(cid, tanti);
    check('conSospensione(): con 702 lavoratori Binozi risulta sospeso', elenco.find(w => w.id === binozi.id)?.sospensione?.al === addDays(today, 4) && elenco.find(w => w.id === carlos.id)?.sospensione === null, elenco.slice(-2));
    const p1 = await problemiLavoratori(cid, { today });
    check('sospeso: la sua visita scaduta non avvisa più (email, notifiche, Da fare)', suoi(p1, binozi.id) === 0, p1.scadenze.filter(s => s.workerId === binozi.id));
    check('...quella di Carlos sì', suoi(p1, carlos.id) > 0);
    const df1 = await buildDaFare(cid, null, { todayStr: today, role: 'owner' });
    check('Da fare: niente righe per Binozi', inDaFare(df1, binozi.id) === 0, df1.items.filter(i => i.entityId === binozi.id));
    check('Da fare: la visita di Carlos c\'è', inDaFare(df1, carlos.id) > 0);
    const m1 = await missingToday(cid, { today });
    check('chi non ha timbrato: Binozi è a parte, «sospensione»', !m1.missing.some(x => x.worker_id === binozi.id) && m1.absent.some(x => x.worker_id === binozi.id && x.tipo === 'sospensione'), m1);
    const p1b = await problemiLavoratori(cid, { today: addDays(today, 5) });
    check('finita la sospensione la visita scaduta torna ad avvisare', suoi(p1b, binozi.id) > 0);

    // ── Carlos non lavora più qui ──
    check('motivi: licenziamento, dimissioni, fine contratto, altro', ['licenziamento', 'dimissioni', 'fine_contratto', 'altro'].every(m => MOTIVI.includes(m)), MOTIVI);
    const e1 = await rifiuta(() => cessa({ companyId: cid, workerId: carlos.id, ultimoGiorno: addDays(today, 3), motivo: 'licenziamento', today }));
    check('un ultimo giorno nel futuro è rifiutato (timbra fino a quel giorno)', e1?.status === 400, e1?.message);
    const e2 = await rifiuta(() => cessa({ companyId: cid, workerId: carlos.id, ultimoGiorno: today, motivo: 'boh', today }));
    check('un motivo sconosciuto è rifiutato', e2?.status === 400, e2?.message);
    const e3 = await rifiuta(() => cessa({ companyId: crypto.randomUUID(), workerId: carlos.id, ultimoGiorno: today, motivo: 'licenziamento', today }));
    check('un lavoratore di un\'altra azienda: non trovato', e3?.status === 404, e3?.message);
    const w2 = await cessa({ companyId: cid, workerId: carlos.id, ultimoGiorno: today, motivo: 'licenziamento', today });
    check('cessa(): non attivo, con giorno e motivo', w2.is_active === false && w2.cessato_il === today && w2.cessazione_motivo === 'licenziamento', w2);
    const p2 = await problemiLavoratori(cid, { today });
    check('non lavora più qui: niente avvisi su di lui', suoi(p2, carlos.id) === 0);
    const m2 = await missingToday(cid, { today });
    check('...non è tra chi non ha timbrato', !m2.missing.some(x => x.worker_id === carlos.id) && !m2.absent.some(x => x.worker_id === carlos.id));

    const w3 = await riattiva({ companyId: cid, workerId: carlos.id });
    check('riattiva(): di nuovo attivo, giorno e motivo cancellati', w3.is_active === true && w3.cessato_il === null && w3.cessazione_motivo === null, w3);
    const p3 = await problemiLavoratori(cid, { today });
    check('riattivato: la visita scaduta torna ad avvisare', suoi(p3, carlos.id) > 0);
  } finally {
    for (const t of ['notifications', 'worker_absences', 'admin_audit_log', 'da_fare_prenotazioni']) await supabase.from(t).delete().eq('company_id', cid);
    await supabase.from('presence_logs').delete().eq('company_id', cid);
    await supabase.from('workers').delete().eq('company_id', cid);
    await supabase.from('sites').delete().eq('company_id', cid);
    await supabase.from('companies').delete().eq('id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
