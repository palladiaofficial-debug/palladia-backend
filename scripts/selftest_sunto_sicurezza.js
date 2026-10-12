#!/usr/bin/env node
/**
 * scripts/selftest_sunto_sicurezza.js — F-340 (AUDIT.md del frontend).
 *
 * Verificato il 12/10: 798 timbrature su 1.000 passano dal badge
 * (public/badge-punch.html), che non mostrava MAI il POS; in tutto lo storico
 * 5 prese visione. Questo test rifà il percorso del sunto dopo l'entrata:
 *   - compare solo subito dopo un'ENTRATA in un cantiere con un POS;
 *   - le 3 lavorazioni più pericolose, poi DPI e soccorso, nella lingua del badge;
 *   - HO CAPITO salva la presa visione (canale, lingua, schede, secondi);
 *   - finché non c'è HO CAPITO ricompare; dopo no; un POS nuovo lo fa ricomparire;
 *   - l'operaio di un subappaltatore vede il POS della sua impresa (F-260);
 *   - niente sunto dopo un'uscita, dopo 30 minuti, senza POS;
 *   - ogni frase delle schede ha la traduzione e ogni cartello un disegno.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabase');
const { SCHEDE } = require('../lib/lavorazioniSchede');
const { FRASI } = require('../lib/suntoSicurezzaLingue');
const { PER_CODICE } = require('../lib/suntoSicurezzaIcone');
const { componiSunto } = require('../lib/suntoSicurezza');
const { elencoPresaVisione } = require('../lib/posPresaVisione');
const { computePosOverview } = require('../lib/posOverview');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F340-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-340 — sunto del POS dopo l\'entrata dal badge\x1b[0m');

  // ── Dati delle schede (puri) ──
  const mancanti = [];
  for (const s of SCHEDE) for (const f of [s.carosello.pericolo, s.carosello.regola]) for (const l of ['ro', 'sq', 'ar']) if (!FRASI[f]?.[l]) mancanti.push(`${s.id}:${l}:${f}`);
  check('ogni frase del carosello ha rumeno, albanese e arabo', mancanti.length === 0, mancanti.slice(0, 5));
  const senzaDisegno = [...new Set(SCHEDE.map(s => s.carosello.cartello.iso7010))].filter(c => !PER_CODICE[c]);
  check('ogni cartello delle schede ha un disegno', senzaDisegno.length === 0, senzaDisegno);

  const pd = { selectedSchede: ['intonaci', 'tinteggiature', 'ponteggio-uso', 'guaina-fiamma', 'coperture-lavori'], primoSoccorso: 'Daniel Miosi' };
  const s = componiSunto(pd, 'it');
  check('5 schede: 3 lavori, DPI, soccorso', s.length === 5 && s[3].id === 'dpi' && s[4].id === 'soccorso', s.map(x => x.id));
  check('prima le lavorazioni più pericolose (R12), a parità nell\'ordine scelto; intonaci fuori', s.slice(0, 3).map(x => x.id).join() === 'guaina-fiamma,coperture-lavori,ponteggio-uso', s.map(x => x.id));
  check('soccorso col nome dell\'addetto del POS', /Daniel Miosi/.test(s[4].regola) && /112/.test(s[4].regola), s[4]);
  check('cartello con forma e disegno', s[1].tipo === 'obbligo' && s[1].iso7010 === 'M018' && s[0].tipo === 'pericolo' && s[0].icona.length > 0, s[0]);
  const ar = componiSunto(pd, 'ar');
  check('in arabo le frasi sono tradotte', ar[0].pericolo === FRASI['La fiamma dà fuoco.'].ar && /Daniel Miosi/.test(ar[4].regola), ar[0]);
  check('lingua sconosciuta: italiano', componiSunto(pd, 'xx')[0].pericolo === 'La fiamma dà fuoco.');
  const vecchio = componiSunto({ selectedWorks: ['Montaggio ponteggio', 'Intonaco civile interno'] }, 'it');
  check('POS del vecchio generatore: voci mappate alle schede', vecchio[0].id === 'ponteggio-montaggio', vecchio.map(x => x.id));
  check('POS senza lavori: DPI e soccorso', componiSunto({}, 'it').map(x => x.id).join() === 'dpi,soccorso');

  // ── Percorso vero, con DB e rotta ──
  const company = await ins('companies', { name: T });
  const cid = company.id;
  const app = express(); app.use(express.json()); app.set('trust proxy', 1);
  app.use('/api/v1', require('../routes/v1/badgeSuntoSicurezza'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (code, lingua = 'it') => { const r = await fetch(`${base}/badge/${code}/sunto-sicurezza?lingua=${lingua}`); return { status: r.status, body: await r.json() }; };
  const post = async (code, body) => { const r = await fetch(`${base}/badge/${code}/sunto-sicurezza`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const site = await ins('sites', { company_id: cid, name: `${T} Via Lucarno`, address: 'Via Lucarno 45, Genova', status: 'attivo' });
    const site2 = await ins('sites', { company_id: cid, name: `${T} Senza POS`, address: 'Via Verdi 1, Genova', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: cid, company_name: `${T} Sub`, is_active: true });
    const mk = (n, extra = {}) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F340${n}${stamp}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), ...extra });
    const arben = await mk('Arben');
    const ion = await mk('Ion', { subcontractor_id: sub.id });
    const nuovo = await mk('Nuovo');
    const pos1 = await ins('pos_documents', { company_id: cid, site_id: site.id, revision: 1, content: '', created_at: new Date(Date.now() - 3600e3).toISOString(), pos_data: { selectedSchede: ['ponteggio-uso', 'intonaci'], primoSoccorso: 'Addetto F340' } });
    const posSub = await ins('pos_documents', { company_id: cid, site_id: site.id, revision: 1, content: '', pos_data: { selectedSchede: ['guaina-fiamma'], subcontractorId: sub.id } });
    const log = (w, st, type, minAgo) => ins('presence_logs', { company_id: cid, site_id: st.id, worker_id: w.id, event_type: type, timestamp_server: new Date(Date.now() - minAgo * 60e3).toISOString(), method: 'worker_self_punch' });

    await log(arben, site, 'ENTRY', 2);
    const g1 = await get(arben.badge_code, 'ro');
    check('subito dopo l\'entrata: sunto da mostrare', g1.status === 200 && g1.body.show === true && g1.body.pos_id === pos1.id, g1.body);
    check('...in rumeno, col cantiere e i tasti', g1.body.lingua === 'ro' && g1.body.testi.hoCapito === 'AM ÎNȚELES' && g1.body.cantiere === site.name && g1.body.schede[0].pericolo === FRASI['Dal ponteggio si cade.'].ro, g1.body);
    check('...il soccorso col nome dell\'addetto', /Addetto F340/.test(g1.body.schede.at(-1).regola));

    // Non ha premuto HO CAPITO: alla prossima entrata ricompare
    await log(arben, site, 'EXIT', 1);
    check('dopo un\'uscita: niente sunto', (await get(arben.badge_code)).body.show === false);
    await log(arben, site, 'ENTRY', 0);
    check('entrata successiva senza HO CAPITO: ricompare', (await get(arben.badge_code)).body.show === true);

    check('POS sbagliato: rifiutato', (await post(arben.badge_code, { pos_id: posSub.id, lingua: 'it' })).status === 409);
    check('pos_id non valido: 400', (await post(arben.badge_code, { pos_id: 'x' })).status === 400);
    const ok = await post(arben.badge_code, { pos_id: pos1.id, lingua: 'ro', schede: g1.body.schede.map(x => x.id), secondi: [6, 5, 4, 7] });
    check('HO CAPITO: salvato', ok.status === 200 && ok.body.ok === true, ok);
    const { data: ack } = await supabase.from('pos_acknowledgments').select('*').eq('pos_id', pos1.id).eq('worker_id', arben.id);
    check('presa visione con canale, lingua, schede e secondi', ack?.length === 1 && ack[0].canale === 'badge' && ack[0].lingua === 'ro' && ack[0].schede.length === 4 && ack[0].secondi_schede.join() === '6,5,4,7' && ack[0].site_id === site.id, ack);
    check('doppio tocco: nessun doppione', (await post(arben.badge_code, { pos_id: pos1.id })).body.unchanged === true);
    check('dopo HO CAPITO: non ricompare', (await get(arben.badge_code)).body.show === false);

    // Titolare: chi è entrato (anche senza essere assegnato al cantiere) conta
    const el = await elencoPresaVisione(pos1);
    const ra = el.find(x => x.worker_id === arben.id);
    check('registro: l\'operaio entrato senza assegnazione è nell\'elenco, con lingua e secondi', ra?.signed === true && ra.canale === 'badge' && ra.lingua === 'ro' && ra.secondi === 22, el);
    const ov = await computePosOverview(cid);
    const imp = ov.sites.find(x => x.id === site.id)?.imprese.find(x => x.kind === 'impresa');
    check('panoramica: presa visione contata su chi entra, non solo sugli assegnati', imp?.workers === 1 && imp.signed === 1 && imp.status === 'firmato', imp);

    // Revisione nuova del POS: ricompare
    const pos2 = await ins('pos_documents', { company_id: cid, site_id: site.id, revision: 2, content: '', pos_data: { selectedSchede: ['ponteggio-uso'] }, created_at: new Date(Date.now() + 1000).toISOString() });
    const g2 = await get(arben.badge_code);
    check('POS rifatto (rev. 2): il sunto ricompare', g2.body.show === true && g2.body.pos_id === pos2.id, g2.body);

    // Subappaltatore: il POS della sua impresa
    await log(ion, site, 'ENTRY', 1);
    const gi = await get(ion.badge_code);
    check('operaio del subappaltatore: POS della sua impresa', gi.body.show === true && gi.body.pos_id === posSub.id && gi.body.schede[0].id === 'guaina-fiamma', gi.body);

    // Cantiere senza POS, entrata vecchia
    await log(nuovo, site2, 'ENTRY', 1);
    check('cantiere senza POS: niente sunto', (await get(nuovo.badge_code)).body.show === false);
    const vecchio45 = await mk('Vecchio');
    await log(vecchio45, site, 'ENTRY', 45);
    const g45 = await get(vecchio45.badge_code);
    check('entrata di 45 minuti fa: niente sunto (solo subito dopo)', g45.status === 409 && g45.body.show === false, g45);

    check('codice badge non valido: 400', (await get('XYZ')).status === 400);
    check('badge sconosciuto: 404', (await get('ABCDEF012345678901')).status === 404);
  } finally {
    server.close();
    await supabase.from('pos_acknowledgments').delete().eq('company_id', cid);
    await supabase.from('pos_documents').delete().eq('company_id', cid);
    await supabase.from('presence_logs').delete().eq('company_id', cid);
    await supabase.from('workers').delete().eq('company_id', cid);
    await supabase.from('subcontractors').delete().eq('company_id', cid);
    await supabase.from('sites').delete().eq('company_id', cid);
    await supabase.from('companies').delete().eq('id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
