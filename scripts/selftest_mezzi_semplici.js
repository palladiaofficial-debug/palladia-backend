#!/usr/bin/env node
/**
 * scripts/selftest_mezzi_semplici.js — F-375 (AUDIT.md del frontend): Mezzi semplici.
 *
 * 1. prossimaRevisione() (puro): art. 80 CdS — fino a 3,5 t prima a 4 anni poi
 *    ogni 2, oltre 3,5 t ogni anno, fine mese; dall'ultima revisione se c'è;
 *    presunta quando la prima è già passata.
 * 2. proposta() del libretto (puro): targa senza spazi, marca/modello in
 *    maiuscolo → «Nissan Cabstar», genere → tipo, massa, revisione calcolata.
 * 3. nomeBreve(): i nomi veri di MSC.
 * 4. Sull'azienda di prova (E2E_COMPANY_ID), scrivendo e poi togliendo:
 *    crea un autocarro dal libretto, la targa doppia viene rifiutata (409), lo
 *    mette in un cantiere e lo sposta (un posto solo), aggiunge e sostituisce il
 *    bollo, un bollo scaduto diventa la «prima cosa», lo toglie.
 * 5. Su MSC (sola lettura): la panoramica dice dell'assicurazione del Nissan
 *    quello che dice /documenti.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const { prossimaRevisione } = require('../lib/mezziRevisione');
const { proposta } = require('../lib/mezziLibretto');
const M = require('../lib/mezzi');
const { panoramica: docPanoramica } = require('../lib/documentiStato');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const MSC = '309e9018-1bcc-4876-9430-99cb89e043dd';
const E2E = process.env.E2E_COMPANY_ID;
const OGGI = '2026-10-18';

(async () => {
  console.log('\nF-375 — la revisione la calcola Palladia');
  let r = prossimaRevisione({ immatricolazione: '2024-03-10', massaKg: 3500 }, OGGI);
  check('autocarro 3,5 t immatricolato a marzo 2024 → prima revisione 31/03/2028', r.data === '2028-03-31' && !r.presunta && !r.pesante, r);
  r = prossimaRevisione({ immatricolazione: '2019-03-10', massaKg: 3500 }, OGGI);
  check('immatricolato a marzo 2019 → 31/03/2027 (2023, 2025 presunte fatte), «presunta»', r.data === '2027-03-31' && r.presunta, r);
  r = prossimaRevisione({ immatricolazione: '2019-03-10', ultima: '2025-06-20', massaKg: 3000 }, OGGI);
  check('ultima revisione a giugno 2025 → 30/06/2027, non presunta', r.data === '2027-06-30' && !r.presunta && r.daUltima, r);
  r = prossimaRevisione({ immatricolazione: '2022-01-15', massaKg: 7500 }, OGGI);
  check('autocarro 7,5 t → ogni anno: 31/01/2027', r.data === '2027-01-31' && r.pesante, r);
  r = prossimaRevisione({ immatricolazione: '2023-02-05', massaKg: null }, OGGI);
  check('febbraio: fine mese giusta (28/02/2027)', r.data === '2027-02-28', r);
  r = prossimaRevisione({ ultima: '2024-10-02', massaKg: 3500 }, OGGI);
  check('revisione scaduta resta scaduta (fatta a ottobre 2024 → 31/10/2026)', r.data === '2026-10-31', r);
  check('senza date → niente calcolo', prossimaRevisione({}, OGGI) === null);

  console.log('\nF-375 — il libretto');
  const p = proposta({ targa: 'BX 120 CW', marca: 'NISSAN', modello: 'CABSTAR', genere: 'autocarro', prima_immatricolazione: '2019-03-10', massa_kg: '3.500', ultima_revisione: null }, OGGI);
  check('targa senza spazi, «Nissan Cabstar», Autocarro, 3500 kg', p.letto.targa === 'BX120CW' && p.nome === 'Nissan Cabstar' && p.letto.tipo === 'Autocarro' && p.letto.massaKg === 3500, p);
  check('revisione calcolata dal libretto: 31/03/2027', p.revisione?.data === '2027-03-31', p.revisione);
  const strano = proposta({ targa: { a: 1 }, genere: 'boh', prima_immatricolazione: '10/03/2019', massa_kg: 'n.d.' }, OGGI);
  check('risposta strana: niente errori, data non ISO scartata, niente revisione', strano.letto.immatricolazione === null && strano.revisione === null && strano.letto.massaKg === null, strano);

  console.log('\nF-375 — nomi brevi');
  check('«Autocarro NISSAN CABSTAR 120.35 3.0 TDI» → «Nissan Cabstar»', M.nomeBreve({ type: 'Autocarro', name: 'Autocarro NISSAN CABSTAR 120.35 3.0 TDI PM-RG CABINATO L' }) === 'Nissan Cabstar');
  check('«Velocifero CITY-X» (Motociclo/Scooter) → «Velocifero City-X»', M.nomeBreve({ type: 'Motociclo/Scooter', name: 'Velocifero CITY-X' }) === 'Velocifero City-X', M.nomeBreve({ type: 'Motociclo/Scooter', name: 'Velocifero CITY-X' }));
  check('«Betoniera Imer» → «Betoniera Imer» (il tipo resta se è tutto il nome)', M.nomeBreve({ type: 'Attrezzatura', name: 'Betoniera Imer' }) === 'Betoniera Imer');

  if (E2E) {
    console.log('\nF-375 — sull\'azienda di prova (crea e poi toglie)');
    const targa = `ZZ${String(Date.now()).slice(-5)}T`;
    let id = null;
    try {
      const c = await M.crea(E2E, null, { tipo: 'Autocarro', nome: 'Prova Selftest', targa: targa.slice(0, 2) + ' ' + targa.slice(2), immatricolazione: '2019-03-10', massaKg: 3500, revisione: '2027-03-31', assicurazione: '2020-01-01' });
      id = c.id;
      check('crea dal libretto confermato', !!id);
      let dop = null;
      try { await M.crea(E2E, null, { tipo: 'Autocarro', nome: 'Doppione', targa }); } catch (e) { dop = e; }
      check('stessa targa scritta diversa → 409 TARGA_GIA_PRESENTE col mezzo che c\'è già', dop?.status === 409 && dop?.id === id, dop && { s: dop.status, id: dop.id });

      const { data: siti } = await supabase.from('sites').select('id, name').eq('company_id', E2E).limit(2);
      if (siti?.length >= 2) {
        await M.mettiIn(E2E, id, siti[0].id);
        await M.mettiIn(E2E, id, siti[1].id);
        const { data: posti } = await supabase.from('site_equipment').select('site_id').eq('equipment_id', id);
        check('spostato in un altro cantiere: un posto solo', posti.length === 1 && posti[0].site_id === siti[1].id, posti);
        await M.mettiIn(E2E, id, null);
        const { data: zero } = await supabase.from('site_equipment').select('site_id').eq('equipment_id', id);
        check('«In magazzino»: in nessun cantiere', zero.length === 0, zero);
      } else console.log('  (meno di 2 cantieri: salto lo spostamento)');

      await M.aggiungiPromemoria(E2E, null, id, { tipo: 'bollo', scadenza: '2027-03-31' });
      await M.aggiungiPromemoria(E2E, null, id, { tipo: 'bollo', scadenza: '2026-09-30' });
      const s = await M.scheda(E2E, id, OGGI);
      const bolli = s.promemoria.filter(x => x.key === 'bollo');
      check('il bollo nuovo prende il posto del vecchio (uno solo, 30/09/2026, scaduto)', bolli.length === 1 && bolli[0].expiry === '2026-09-30' && bolli[0].state === 'scaduto', s.promemoria);
      check('scheda: assicurazione scaduta, revisione 31/03/2027 in regola', s.requisiti.find(x => x.key === 'assicurazione')?.state === 'scaduto' && s.requisiti.find(x => x.key === 'revisione')?.expiry === '2027-03-31', s.requisiti);
      check('il problema più grave è il più vecchio: assicurazione (1/1/2020) prima del bollo', s.problema?.key === 'assicurazione' && s.problemi === 2, s.problema);
      let err = null;
      try { await M.aggiungiPromemoria(E2E, null, id, { tipo: 'altro', scadenza: '2027-01-01' }); } catch (e) { err = e; }
      check('«Altro» senza testo → 400', err?.status === 400 && err.code === 'TESTO_RICHIESTO', err && err.code);

      // Il nome scelto, non quello del file (prima: «IMG_2041» al posto di «Libretto di circolazione»)
      const { carica } = require('../lib/documentiCarica');
      await carica({ companyId: E2E, userId: null, kind: 'mezzi', id, label: 'Libretto di circolazione',
        file: { buffer: Buffer.from('%PDF-1.4\n%%EOF\n'), mimetype: 'application/pdf', originalname: 'IMG_2041.pdf', size: 15 } });
      const s2 = await M.scheda(E2E, id, OGGI);
      check('documento di un mezzo col nome scelto: «Libretto di circolazione»', s2.documenti.some(d => d.label === 'Libretto di circolazione'), s2.documenti.map(d => d.label));

      const pan = await M.panoramica(E2E, OGGI);
      const riga = pan.mezzi.find(x => x.id === id);
      check('panoramica: la riga del mezzo dice «assicurazione scaduta» e il nome breve', riga?.problema?.key === 'assicurazione' && riga?.nome === 'Prova Selftest', riga);
      await M.togli(E2E, id);
      const dopo = await M.panoramica(E2E, OGGI);
      check('«Non lo usiamo più»: sparisce dalla pagina', !dopo.mezzi.some(x => x.id === id));
    } finally {
      if (id) {
        const { data: docs } = await supabase.from('equipment_documents').select('id, file_url').eq('equipment_id', id);
        if (docs?.length) {
          await supabase.storage.from('equipment-docs').remove(docs.map(d => d.file_url)).catch(() => {});
          await supabase.from('equipment_documents').delete().eq('equipment_id', id);
        }
        await supabase.from('equipment_promemoria').delete().eq('equipment_id', id);
        await supabase.from('site_equipment').delete().eq('equipment_id', id);
        await supabase.from('equipment').update({ is_active: false }).eq('id', id);
      }
    }
  }

  console.log('\nF-375 — MSC (sola lettura)');
  const [pan, doc] = await Promise.all([M.panoramica(MSC), docPanoramica(MSC)]);
  const nissan = pan.mezzi.find(x => /BX120CW/.test(x.targa || ''));
  const docNissan = doc.daSistemare.find(x => x.kind === 'mezzi' && x.id === nissan?.id && x.key === 'assicurazione');
  check(`MSC: ${pan.mezzi.length} mezzi, lo scooter doppione tolto non c'è`, pan.mezzi.filter(x => x.targa === 'FX53745').length === 1, pan.mezzi.map(x => x.targa));
  check('MSC: Nissan, assicurazione = quella di /documenti', nissan && docNissan && nissan.problema?.key === 'assicurazione' && nissan.problema.expiry === docNissan.expiry && nissan.problema.state === docNissan.state, { nissan: nissan?.problema, docNissan });
  check('MSC: la prima cosa è un\'assicurazione scaduta o mancante', pan.prima && pan.prima.key === 'assicurazione', pan.prima);
  check('MSC: i veicoli senza revisione chiedono il libretto (non sono «manca»)', pan.mezzi.filter(m => m.veicolo).every(m => m.revisioneDaCalcolare || m.revisioneProposta || m.problema?.key !== 'revisione'), pan.mezzi.map(m => [m.nome, m.revisioneDaCalcolare]));

  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
