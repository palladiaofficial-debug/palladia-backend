#!/usr/bin/env node
/**
 * scripts/selftest_psc_letto.js — F-426 (AUDIT.md del frontend).
 *
 * Il PSC del coordinatore letto e confrontato con il tuo POS, su un'azienda di prova vera (DB,
 * modello finto):
 *  - Corso Italia: il tuo POS fatto PRIMA del PSC → le 2 richieste del PSC «nel tuo POS non c'è»;
 *    nella catena e su Oggi «Il PSC chiede 2 cose che il tuo POS non ha»;
 *  - la lettura si salva: aprire di nuovo non richiama il modello;
 *  - rifatto il POS con il PSC dentro (rev. 2) → tutte e due «nel tuo POS», catena a posto;
 *  - Via Roma: POS caricato come file → le richieste «non si possono controllare»;
 *  - Via Balbi: senza POS → «senza POS»; Via Nuda: senza PSC → «nessuno»;
 *  - un'altra azienda non vede niente.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const L = require('../lib/pscLetto');
const S = require('../lib/sicurezzaCantieri');
const { buildDaFare } = require('../lib/daFare');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
async function pdfPsc() {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) d.addPage([595, 842]).drawText(`PIANO DI SICUREZZA E COORDINAMENTO pagina ${i + 1} `.repeat(12).match(/.{1,90}/g).join('\n'), { x: 30, y: 800, size: 9, font: f, lineHeight: 11 });
  return Buffer.from(await d.save());
}
const RISPOSTA = {
  e_un_psc: true, riferimento: 'PSC rev. 1', committente: 'Condominio Corso Italia', cse_nome: 'Arch. Bianchi',
  richieste_per_impresa: [
    { titolo: 'Recinzione alta 2 m con il cartello di cantiere', dettaglio: 'Prima dell\'inizio dei lavori', pagina: 2 },
    { titolo: 'Gru in comune con Edil Rossi, a turni', pagina: 3 },
  ],
  fasi_impresa: [], rischi_interferenza: [], pagine: {},
};

(async () => {
  console.log('\n\x1b[1mF-426 — il PSC del coordinatore, letto e confrontato\x1b[0m');
  const T = `TEST-F426-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  const altra = await ins('companies', { name: `${T}-altra` });
  let chiamate = 0;
  const ai = async () => { chiamate++; return RISPOSTA; };
  const buf = await pdfPsc();
  const deps = { ai, download: async () => buf };
  try {
    const sito = (nome) => ins('sites', { company_id: co.id, name: `${T} ${nome}`, address: `${nome}, Genova`, status: 'attivo' });
    const corso = await sito('Corso Italia 8'), roma = await sito('Via Roma 4'), balbi = await sito('Via Balbi 31'), nuda = await sito('Via Nuda 1');
    const psc = (s) => ins('site_documents', { company_id: co.id, site_id: s.id, name: 'PSC Corso Italia.pdf', category: 'psc', file_path: `${co.id}/${s.id}/psc.pdf`, mime_type: 'application/pdf', file_size: buf.length });
    for (const s of [corso, roma, balbi]) await psc(s);
    await ins('pos_documents', { company_id: co.id, site_id: corso.id, revision: 1, content: 'x', pos_data: { subcontractorId: null, pscRichieste: [] } });
    await ins('site_documents', { company_id: co.id, site_id: roma.id, name: 'POS.pdf', category: 'pos', file_path: `${co.id}/${roma.id}/pos.pdf` });

    const a = await L.scheda(co.id, corso.id, { deps, attendi: true });
    check('Corso Italia: letto, «Chiede 2 cose»', a.stato === 'letto' && a.richieste.length === 2 && a.cse === 'Arch. Bianchi', a);
    check('il POS fatto prima del PSC non le ha: tutte e due «manca»', a.richieste.every(r => r.stato === 'manca') && a.mancano === 2 && a.pos.stato === 'palladia' && a.pos.revisione === 1, a.richieste);
    check('ogni richiesta con la sua pagina', a.richieste[0].pagina === 2 && a.richieste[1].pagina === 3, a.richieste);
    const b = await L.scheda(co.id, corso.id, { deps, attendi: true });
    check('la lettura si salva: la seconda volta niente modello', chiamate === 1 && b.richieste.length === 2, { chiamate });

    let c = (await S.elenco(co.id)).cantieri.find(x => x.id === corso.id);
    check('nella catena: «Il PSC chiede 2 cose che il tuo POS non ha»', c?.frase === 'Il PSC chiede 2 cose che il tuo POS non ha' && !c.aPosto && c.azione === 'psc_pos' && c.psc.chiede === 2 && c.psc.mancano === 2, c && { frase: c.frase, psc: c.psc });
    const df = await buildDaFare(co.id, null, { role: 'owner' });
    const it = df.items.find(i => i.kind === 'psc' && i.entityId === corso.id);
    check('su Oggi: la riga del PSC, verso /cantieri/…/psc', it?.title === `Il PSC di ${T} Corso Italia 8 chiede 2 cose che il tuo POS non ha` && it.link === `/cantieri/${corso.id}/psc`, it);

    await ins('pos_documents', { company_id: co.id, site_id: corso.id, revision: 2, content: 'x', pos_data: { subcontractorId: null, pscRichieste: RISPOSTA.richieste_per_impresa.map(r => ({ titolo: r.titolo, dettaglio: r.dettaglio || '', pagina: r.pagina })) } });
    const d2 = await L.scheda(co.id, corso.id, { deps, attendi: true });
    check('rifatto il POS col PSC dentro: tutte e due «nel tuo POS»', d2.mancano === 0 && d2.richieste.every(r => r.stato === 'nel_pos') && d2.pos.revisione === 2, d2.richieste);
    c = (await S.elenco(co.id)).cantieri.find(x => x.id === corso.id);
    check('…e la catena torna a posto', c?.aPosto && c.psc.mancano === 0, c && { frase: c.frase, psc: c.psc });

    const r = await L.scheda(co.id, roma.id, { deps, attendi: true });
    check('Via Roma: POS caricato come file → «non si può controllare»', r.pos.stato === 'file' && r.richieste.every(x => x.stato === 'non_controllabile') && r.mancano === null, r);
    const bb = await L.scheda(co.id, balbi.id, { deps, attendi: true });
    check('Via Balbi: senza POS', bb.pos.stato === 'manca' && bb.richieste.every(x => x.stato === 'senza_pos'), bb);
    const n = await L.scheda(co.id, nuda.id, { deps, attendi: true });
    check('Via Nuda: nessun PSC', n.stato === 'nessuno' && n.richieste.length === 0, n);

    let negato = false;
    try { await L.scheda(altra.id, corso.id, { deps, attendi: true }); } catch (e) { negato = e.status === 404; }
    check('un\'altra azienda non vede niente', negato);
  } finally {
    for (const id of [co.id, altra.id]) {
      await supabase.from('psc_letture').delete().eq('company_id', id);
      await supabase.from('pos_documents').delete().eq('company_id', id);
      await supabase.from('site_documents').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
