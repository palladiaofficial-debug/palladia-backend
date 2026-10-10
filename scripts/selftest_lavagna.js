#!/usr/bin/env node
/**
 * scripts/selftest_lavagna.js — F-331 (AUDIT.md del frontend): Lavagna cantieri.
 *
 *   - chi è dentro adesso (l'ultima timbratura del lavoratore, ovunque);
 *   - ogni cantiere registrato ha la sua riga; le righe "solo nella lavagna"
 *     non creano cantieri;
 *   - lo stato scritto sulla lavagna è lo stato vero del cantiere
 *     (Fermo = sospeso, Consegnato = ultimato), con il limite del piano;
 *   - "Da iniziare" su un cantiere registrato non lo toglie dalle timbrature;
 *   - una riga con lo stesso nome di un cantiere registrato dopo si collega
 *     da sola; "È il cantiere…" unisce le scritte;
 *   - un cantiere consegnato senza niente scritto sparisce dopo un mese;
 *   - niente righe di un'altra azienda.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const T = `TEST-F331-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-331 — Lavagna cantieri\x1b[0m');
  let L;
  try { L = require('../lib/lavagna'); } catch { L = null; }
  check('esiste lib/lavagna', !!L && typeof L.lavagna === 'function');
  if (!L) { console.log(`\n${passed} passati, ${failed} falliti`); process.exit(1); }

  // ── Chi è dentro adesso ──
  const S1 = 'a', S2 = 'b';
  const p = L.presenzeOggi([
    { worker_id: 'w1', site_id: S1, event_type: 'ENTRY', timestamp_server: '2026-10-10T05:34:00Z' },
    { worker_id: 'w2', site_id: S1, event_type: 'ENTRY', timestamp_server: '2026-10-10T05:40:00Z' },
    { worker_id: 'w3', site_id: S1, event_type: 'ENTRY', timestamp_server: '2026-10-10T05:50:00Z' },
    { worker_id: 'w3', site_id: S1, event_type: 'EXIT', timestamp_server: '2026-10-10T09:00:00Z' },
    { worker_id: 'w2', site_id: S2, event_type: 'EXIT', timestamp_server: '2026-10-10T10:00:00Z' }, // uscito da un altro cantiere
  ]);
  check('dentro: conta solo chi ha come ultima timbratura un\'entrata qui', p.dentro.get(S1) === 1 && !p.dentro.get(S2), [...p.dentro]);
  check('prima entrata e ultima uscita del cantiere', p.primaEntrata.get(S1) === '2026-10-10T05:34:00Z' && p.ultimaUscita.get(S1) === '2026-10-10T09:00:00Z');

  const company = await ins('companies', { name: T, subscription_plan: 'starter', subscription_status: 'active' });
  const other = await ins('companies', { name: `${T}-altra` });
  const cid = company.id;
  try {
    const attivo = await ins('sites', { company_id: cid, name: 'Via Riboli 4', address: '', status: 'attivo' });
    const vecchio = await ins('sites', { company_id: cid, name: 'Via Byron', address: '', status: 'ultimato' });
    await ins('sites', { company_id: other.id, name: 'Via Altrui', address: '', status: 'attivo' });
    await ins('lavagna_righe', { company_id: other.id, nome: 'Riga altrui', fase: 'in_corso' });

    let l = await L.lavagna(cid);
    const riga = (n) => l.righe.find(r => r.nome === n);
    check('il cantiere registrato è sulla lavagna, in corso, senza niente scritto',
      riga('Via Riboli 4')?.registrato && riga('Via Riboli 4').stato === 'in_corso' && riga('Via Riboli 4').urgenza === 'nessuna' && riga('Via Riboli 4').operai?.adesso === 0, riga('Via Riboli 4'));
    check('un cantiere consegnato da tempo senza niente scritto non c\'è', !riga('Via Byron'), l.righe.map(r => r.nome));
    check('niente righe né cantieri di un\'altra azienda', !riga('Via Altrui') && !riga('Riga altrui'));

    // ── Riga solo nella lavagna ──
    const nuova = await L.crea(cid, null, '  Via   Rivale 9 ');
    const { count: nSites } = await supabase.from('sites').select('id', { count: 'exact', head: true }).eq('company_id', cid);
    l = await L.lavagna(cid);
    check('nuova riga: solo il nome, "Da iniziare", nessun cantiere creato',
      riga('Via Rivale 9')?.stato === 'da_iniziare' && riga('Via Rivale 9').registrato === false && nSites === 2, { r: riga('Via Rivale 9'), nSites });
    const vuota = await L.crea(cid, null, '   ').then(() => null, e => e.code);
    check('senza nome rifiutata', vuota === 'NOME_RICHIESTO', vuota);

    await L.salva(cid, null, { rigaId: nuova.id, urgenza: 'rosso', daFare: 'Pressare Taccia', note: 'In attesa di occ. suolo' });
    l = await L.lavagna(cid);
    check('urgenza, da fare e nota salvate', riga('Via Rivale 9')?.urgenza === 'rosso' && riga('Via Rivale 9').daFare === 'Pressare Taccia' && riga('Via Rivale 9').note === 'In attesa di occ. suolo', riga('Via Rivale 9'));
    const badUrg = await L.salva(cid, null, { rigaId: nuova.id, urgenza: 'viola' }).then(() => null, e => e.code);
    check('urgenza non valida rifiutata', badUrg === 'INVALID_URGENZA', badUrg);

    // ── Stato di un cantiere registrato = sites.status ──
    await L.salva(cid, null, { siteId: attivo.id, stato: 'fermo', daFare: 'Smontaggio ponti' });
    let st = (await supabase.from('sites').select('status').eq('id', attivo.id).single()).data.status;
    l = await L.lavagna(cid);
    check('Fermo sulla lavagna = cantiere sospeso', st === 'sospeso' && riga('Via Riboli 4')?.stato === 'fermo' && riga('Via Riboli 4').daFare === 'Smontaggio ponti', { st, r: riga('Via Riboli 4') });
    await L.salva(cid, null, { siteId: attivo.id, stato: 'da_iniziare' });
    st = (await supabase.from('sites').select('status').eq('id', attivo.id).single()).data.status;
    l = await L.lavagna(cid);
    check('Da iniziare su un cantiere registrato: resta attivo (si timbra), la lavagna dice Da iniziare', st === 'attivo' && riga('Via Riboli 4')?.stato === 'da_iniziare', { st, r: riga('Via Riboli 4') });
    await L.salva(cid, null, { siteId: attivo.id, stato: 'consegnato' });
    st = (await supabase.from('sites').select('status').eq('id', attivo.id).single()).data.status;
    l = await L.lavagna(cid);
    check('Consegnato = cantiere ultimato, e resta sulla lavagna (scritto da poco)', st === 'ultimato' && riga('Via Riboli 4')?.stato === 'consegnato', { st, r: riga('Via Riboli 4') });

    // Limite del piano (starter = 5): riaprire oltre il limite non si può
    for (let i = 0; i < 5; i++) await ins('sites', { company_id: cid, name: `${T} pieno ${i}`, address: '', status: 'attivo' });
    const lim = await L.salva(cid, null, { siteId: attivo.id, stato: 'in_corso' }).then(() => null, e => e.code);
    st = (await supabase.from('sites').select('status').eq('id', attivo.id).single()).data.status;
    check('riaprire oltre il limite del piano: rifiutato, il cantiere resta consegnato', lim === 'SITE_LIMIT_REACHED' && st === 'ultimato', { lim, st });

    // ── Collegamento ──
    const registrato = await ins('sites', { company_id: cid, name: 'via rivale 9', address: '', status: 'attivo' });
    l = await L.lavagna(cid);
    const rr = l.righe.filter(r => /rivale 9/i.test(r.nome));
    check('stesso nome registrato dopo: la riga si collega da sola, una riga sola con le scritte',
      rr.length === 1 && rr[0].siteId === registrato.id && rr[0].daFare === 'Pressare Taccia' && rr[0].urgenza === 'rosso' && rr[0].stato === 'da_iniziare', rr);

    const libera = await L.crea(cid, null, 'Ponterotto');
    await L.salva(cid, null, { rigaId: libera.id, urgenza: 'giallo', daFare: 'Verificare il da farsi' });
    const sito2 = await ins('sites', { company_id: cid, name: 'Via Ponterotto 12', address: '', status: 'attivo' });
    await L.salva(cid, null, { siteId: sito2.id, note: 'Chiamare il committente' });
    await L.collega(cid, null, libera.id, sito2.id);
    l = await L.lavagna(cid);
    const pr = l.righe.filter(r => /ponterotto/i.test(r.nome));
    check('"È il cantiere…": una riga sola, scritte unite, urgenza più alta',
      pr.length === 1 && pr[0].siteId === sito2.id && pr[0].daFare === 'Verificare il da farsi' && pr[0].note === 'Chiamare il committente' && pr[0].urgenza === 'giallo', pr);

    // ── Togliere ──
    const via = await L.crea(cid, null, 'Da togliere');
    await L.togli(cid, via.id);
    const tolto = await L.togli(cid, via.id).then(() => null, e => e.code);
    const nonTogli = await L.togli(cid, (await supabase.from('lavagna_righe').select('id').eq('site_id', sito2.id).single()).data.id).then(() => null, e => e.code);
    check('una riga solo nella lavagna si toglie; quella di un cantiere registrato no', tolto === 'NOT_FOUND' && nonTogli === 'NOT_FOUND', { tolto, nonTogli });

    // ── Consegnato scritto da più di un mese e vuoto: sparisce ──
    await supabase.from('lavagna_righe').update({ urgenza: 'nessuna', da_fare: '', note: '', updated_at: '2026-01-01T00:00:00Z' }).eq('site_id', attivo.id);
    l = await L.lavagna(cid);
    check('consegnato, vuoto, toccato più di un mese fa: non c\'è più', !riga('Via Riboli 4'), riga('Via Riboli 4'));
    await supabase.from('lavagna_righe').update({ note: 'Manca il collaudo' }).eq('site_id', attivo.id);
    l = await L.lavagna(cid);
    check('consegnato con ancora qualcosa scritto: resta', riga('Via Riboli 4')?.note === 'Manca il collaudo');
    void vecchio;
  } finally {
    await supabase.from('lavagna_righe').delete().in('company_id', [cid, other.id]);
    await supabase.from('sites').delete().in('company_id', [cid, other.id]);
    await supabase.from('companies').delete().in('id', [cid, other.id]);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
