#!/usr/bin/env node
/**
 * scripts/selftest_cantiere_riepilogo.js — F-321 (AUDIT.md del frontend).
 *
 * Scheda cantiere senza cartelle. Il Riepilogo dice cosa sistemare guardando
 * le timbrature vere, non le date:
 *   - documenti del cantiere = POS, PSC, notifica (niente DVR/DURC/assicurazione,
 *     che facevano dire "6 mancanti" a Corso Sardegna 88);
 *   - "Non serve" toglie un documento dai mancanti;
 *   - chi lavora qui con formazione scaduta → da sistemare; chi non lavora qui no;
 *   - assegnati che non vengono: "altrove" o "mai";
 *   - data di fine passata ma si lavora → da sistemare;
 *   - cantiere fermo (nessuna timbratura in 30 giorni) → non "al lavoro", niente lista.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { riepiloghi, checklistDocumenti } = require('../lib/cantiereRiepilogo');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F321-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const romeDay = (d) => d.toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const at = (day, h) => new Date(`${day}T${h}:00Z`).toISOString();

async function main() {
  console.log('\n\x1b[1mF-321 — Riepilogo del cantiere\x1b[0m');

  // Documenti del cantiere (pura)
  const lista = checklistDocumenti({ conPos: false, categorie: new Set(), nonServono: [] });
  check('documenti del cantiere: solo POS, PSC, notifica', lista.map(d => d.tipo).join() === 'pos,psc,notifica_asl', lista);
  check('niente DVR, DURC, assicurazione', !lista.some(d => ['dvr', 'durc', 'assicurazione'].includes(d.tipo)));
  const ns = checklistDocumenti({ conPos: true, categorie: new Set(), nonServono: ['psc', 'notifica_asl'] });
  check('"Non serve" su PSC e notifica: non sono mancanti', ns.every(d => d.presente || d.non_serve), ns);

  const company = await ins('companies', { name: T });
  const cid = company.id;
  try {
    const today = romeDay(new Date());
    const ieri = addDays(today, -1);
    const mkSite = (n, extra = {}) => ins('sites', { company_id: cid, name: `${T} ${n}`, address: `${n}, Genova`, status: 'attivo', start_date: '2025-11-03', latitude: 44.41, longitude: 8.95, ...extra });
    const sardegna = await mkSite('Corso Sardegna 88', { end_date: addDays(today, -79) });
    const altro = await mkSite('Via Balbi 31');
    const fermo = await mkSite('Via Ponza 22', { end_date: addDays(today, -5) });
    const mk = (n, extra = {}) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F321${n}${stamp}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), safety_training_expiry: '2030-01-01', health_fitness_expiry: '2030-01-01', ...extra });
    const giuseppe = await mk('Giuseppe', { safety_training_expiry: addDays(today, -38) });
    const ibrahim = await mk('Ibrahim');
    const armand = await mk('Armand');  // assegnato a Sardegna, timbra a Balbi
    const mario = await mk('Mario');    // assegnato a Sardegna, non timbra mai
    const lontano = await mk('Lontano', { health_fitness_expiry: addDays(today, -10) }); // scaduto ma lavora solo a Balbi
    for (const w of [giuseppe, ibrahim, armand, mario]) await ins('worksite_workers', { company_id: cid, site_id: sardegna.id, worker_id: w.id, status: 'active' });
    await ins('worksite_workers', { company_id: cid, site_id: fermo.id, worker_id: mario.id, status: 'active' });
    const log = (w, s, type, day, h) => ins('presence_logs', { company_id: cid, site_id: s.id, worker_id: w.id, event_type: type, timestamp_server: at(day, h), method: 'worker_self_punch' });
    for (const w of [giuseppe, ibrahim]) { await log(w, sardegna, 'ENTRY', ieri, '05:40'); await log(w, sardegna, 'EXIT', ieri, '15:00'); }
    for (const w of [armand, lontano]) { await log(w, altro, 'ENTRY', ieri, '05:40'); await log(w, altro, 'EXIT', ieri, '15:00'); }

    const m = await riepiloghi(cid, { fresh: true, today });
    const r = m.get(sardegna.id);
    check('Corso Sardegna: al lavoro, ieri 2 persone', r?.alLavoro === true && r.ultimoGiorno?.day === ieri && r.ultimoGiorno.persone === 2, r && { alLavoro: r.alLavoro, ultimoGiorno: r.ultimoGiorno });
    const tipi = r.daSistemare.map(x => x.tipo);
    const giu = r.daSistemare.find(x => x.tipo === 'lavoratore' && x.workerId === giuseppe.id);
    check('Giuseppe lavora qui con la formazione scaduta → da sistemare', giu?.cosa === 'formazione' && giu.stato === 'scaduta', r.daSistemare);
    check('chi ha documenti scaduti ma lavora altrove non compare qui', !r.daSistemare.some(x => x.workerId === lontano.id));
    check('POS mancante → da sistemare', tipi.includes('pos'));
    const ass = r.daSistemare.find(x => x.tipo === 'assenti');
    check('assegnati che non vengono: Armand "altrove", Mario "mai"', ass?.persone.find(p => p.workerId === armand.id)?.dove === 'altrove' && ass.persone.find(p => p.workerId === mario.id)?.dove === 'mai', ass);
    check('fine passata da 79 giorni ma si lavora → da sistemare', r.daSistemare.find(x => x.tipo === 'fine')?.endDate === addDays(today, -79));
    check('documenti: POS, PSC, notifica mancanti (e basta)', JSON.stringify(r.documenti) === JSON.stringify({ pos: 'manca', psc: 'manca', notifica_asl: 'manca' }), r.documenti);

    const f = m.get(fermo.id);
    check('Via Ponza: nessuno timbra da 30 giorni → fermo, niente da sistemare', f?.alLavoro === false && f.daSistemare.length === 0, f);

    // "Non serve" sul POS (es. il magazzino) e posizione mancante
    await supabase.from('sites').update({ documenti_non_servono: ['pos'], latitude: null, longitude: null }).eq('id', sardegna.id);
    const r2 = (await riepiloghi(cid, { siteIds: [sardegna.id], fresh: true, today })).get(sardegna.id);
    check('POS "non serve": sparisce da Da sistemare', !r2.daSistemare.some(x => x.tipo === 'pos') && r2.documenti.pos === 'non_serve', r2.documenti);
    check('posizione per timbrare mancante → da sistemare', r2.daSistemare.some(x => x.tipo === 'posizione'));
    const nuovo = await mkSite('Via Nuova 1', { latitude: null, longitude: null });
    const rn = (await riepiloghi(cid, { siteIds: [nuovo.id], fresh: true, today })).get(nuovo.id);
    check('cantiere appena creato senza posizione: "manca la posizione" anche senza timbrature', rn.alLavoro === false && rn.daSistemare.some(x => x.tipo === 'posizione'), rn.daSistemare);
    check('...ed è "nuovo" (in cima, non tra i fermi)', rn.nuovo === true, rn);
    const bad = await supabase.from('sites').update({ documenti_non_servono: ['dvr'] }).eq('id', sardegna.id);
    check('il database rifiuta un documento che non è del cantiere', !!bad.error, bad.error?.message);
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
