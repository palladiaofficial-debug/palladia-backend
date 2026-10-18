#!/usr/bin/env node
/**
 * scripts/selftest_imprese_semplici.js — F-376 (AUDIT.md del frontend): Imprese semplici e link dell'impresa.
 *
 * 1. giudica() (puro): il codice decide se un documento va bene — documento
 *    sbagliato, altra impresa (P.IVA o nome), scaduto, visura > 6 mesi, DURC
 *    = emissione + 120 gg, dichiarazione senza firma, POS di un altro
 *    cantiere, visita di un'altra persona; il caso buono.
 * 2. Sull'azienda di prova (crea e poi toglie), col modello finto: impresa
 *    aggiunta col solo telefono → da completare; il link è sempre lo stesso;
 *    l'impresa apre il link, scrive i suoi dati, carica un DURC buono (la data
 *    va sull'impresa), una dichiarazione senza firma (non va, e non conta),
 *    una visura vecchia; il titolare vede «ha mandato 3 documenti», decide
 *    «va bene lo stesso»; un operaio dal link con una visita di un altro;
 *    il modulo della dichiarazione è un PDF; un token inventato non apre niente.
 * 3. MSC (sola lettura): AYAT, le 5 cose che mancano sono quelle vere.
 */
'use strict';
require('dotenv').config({ quiet: true });
// Come in produzione (Railway): il modulo imprese è acceso di default
process.env.FEATURE_SUBAPPALTATORI_DEFAULT = process.env.FEATURE_SUBAPPALTATORI_DEFAULT || 'true';
const supabase = require('../lib/supabase');
const { giudica } = require('../lib/impreseControllo');
const L = require('../lib/impreseLink');
const I = require('../lib/imprese');
const { dichiarazionePdf } = require('../lib/impreseDichiarazione');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const MSC = '309e9018-1bcc-4876-9430-99cb89e043dd';
const E2E = process.env.E2E_COMPANY_ID;
const OGGI = '2026-10-18';
const impresa = { nome: 'AYAT SRLS', piva: '13371360960' };
const letto = (x) => ({ tipo: 'altro', ragioneSociale: null, piva: null, sede: null, persona: null, dataDocumento: null, scadenza: null, firmato: null, cantiere: null, ...x });

(async () => {
  console.log('\nF-376 — il codice decide se un documento va bene');
  let g = giudica('durc', letto({ tipo: 'durc', ragioneSociale: 'AYAT S.R.L.S.', piva: '13371360960', dataDocumento: '2026-09-01' }), { impresa, oggi: OGGI });
  check('DURC buono, solo emissione → va bene, scade dopo 120 giorni (30/12/2026)', g.esito === 'va_bene' && g.scadenza === '2026-12-30', g);
  g = giudica('visura', letto({ tipo: 'durc', piva: '13371360960' }), { impresa, oggi: OGGI });
  check('ha mandato un DURC al posto della visura → non va (altro documento)', g.esito === 'non_va' && g.motivo.codice === 'altro_documento' && g.motivo.valore === 'durc', g);
  g = giudica('durc', letto({ tipo: 'durc', ragioneSociale: 'AYAT SRLS', piva: '01234567890', scadenza: '2027-01-01' }), { impresa, oggi: OGGI });
  check('P.IVA di un\'altra impresa → non va, anche se il nome somiglia', g.esito === 'non_va' && g.motivo.codice === 'altra_impresa', g);
  g = giudica('dvr', letto({ tipo: 'dvr', ragioneSociale: 'Edil Rossi snc' }), { impresa, oggi: OGGI });
  check('DVR intestato a «Edil Rossi snc» → non va (altra impresa)', g.esito === 'non_va' && g.motivo.codice === 'altra_impresa' && g.motivo.valore === 'Edil Rossi snc', g);
  g = giudica('dvr', letto({ tipo: 'dvr', ragioneSociale: 'Ayat srls' }), { impresa, oggi: OGGI });
  check('DVR «Ayat srls» (stessa impresa scritta diversa), senza scadenza → va bene', g.esito === 'va_bene', g);
  g = giudica('visura', letto({ tipo: 'visura', piva: '13371360960', dataDocumento: '2026-02-10' }), { impresa, oggi: OGGI });
  check('visura di febbraio (più di 6 mesi) → non va (visura vecchia)', g.esito === 'non_va' && g.motivo.codice === 'visura_vecchia' && g.motivo.valore === '2026-02-10', g);
  g = giudica('visura', letto({ tipo: 'visura', piva: '13371360960', dataDocumento: '2026-09-15' }), { impresa, oggi: OGGI });
  check('visura di settembre → va bene, vale fino al 15/03/2027', g.esito === 'va_bene' && g.scadenza === '2027-03-15', g);
  g = giudica('dichiarazione', letto({ tipo: 'dichiarazione', piva: '13371360960', firmato: false }), { impresa, oggi: OGGI });
  check('dichiarazione con lo spazio della firma vuoto → non va (senza firma)', g.esito === 'non_va' && g.motivo.codice === 'senza_firma', g);
  g = giudica('dichiarazione', letto({ tipo: 'dichiarazione', piva: '13371360960', firmato: null }), { impresa, oggi: OGGI });
  check('firma che non si capisce → non si boccia (va bene)', g.esito === 'va_bene', g);
  g = giudica('assicurazione', letto({ tipo: 'assicurazione', ragioneSociale: 'AYAT SRLS', scadenza: '2026-06-30' }), { impresa, oggi: OGGI });
  check('polizza scaduta il 30/06 → non va (scaduto)', g.esito === 'non_va' && g.motivo.codice === 'scaduto', g);
  const cantiere = { nome: 'Via Riboli 4b', indirizzo: 'Via Riboli 4b, Genova' };
  g = giudica('pos', letto({ tipo: 'pos', ragioneSociale: 'AYAT SRLS', cantiere: 'Corso Italia 12, Milano' }), { impresa, cantiere, oggi: OGGI });
  check('POS per «Corso Italia 12, Milano» mandato per Via Riboli → non va (altro cantiere)', g.esito === 'non_va' && g.motivo.codice === 'altro_cantiere', g);
  g = giudica('pos', letto({ tipo: 'pos', ragioneSociale: 'AYAT SRLS', cantiere: 'VIA RIBOLI 4/B - GENOVA' }), { impresa, cantiere, oggi: OGGI });
  check('POS per «VIA RIBOLI 4/B - GENOVA» → va bene', g.esito === 'va_bene', g);
  g = giudica('idoneita', letto({ tipo: 'idoneita', persona: 'KARIM BENALI', scadenza: '2027-05-01' }), { operaio: { nome: 'Youssef Amrani' }, oggi: OGGI });
  check('visita medica di un\'altra persona → non va (altra persona)', g.esito === 'non_va' && g.motivo.codice === 'altra_persona', g);
  g = giudica('idoneita', letto({ tipo: 'idoneita', persona: 'AMRANI YOUSSEF', scadenza: '2027-05-01' }), { operaio: { nome: 'Youssef Amrani' }, oggi: OGGI });
  check('visita di «AMRANI YOUSSEF» per Youssef Amrani → va bene', g.esito === 'va_bene' && g.scadenza === '2027-05-01', g);

  const pdf = await dichiarazionePdf({ impresa: { nome: 'AYAT SRLS', piva: '13371360960', indirizzo: 'Milano, Viale Monza 92', referente: null }, azienda: 'MSCedilizia S.r.l.', cantieri: [cantiere] });
  check('il modulo della dichiarazione è un PDF', pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 1000, pdf.length);

  if (E2E) {
    console.log('\nF-376 — sull\'azienda di prova (crea e poi toglie), modello finto');
    let id = null;
    try {
      const c = await I.crea(E2E, { telefono: '333 1234567' });
      id = c.id;
      const p0 = await I.panoramica(E2E);
      const riga = p0.imprese.find(x => x.id === id);
      check('aggiunta col solo telefono → «Nuova impresa · 333 1234567», da completare', riga?.daCompletare && riga.nome === 'Nuova impresa · 333 1234567', riga);

      const a = await I.chiedi(E2E, null, id);
      const b = await I.chiedi(E2E, null, id);
      check('il link è sempre lo stesso', a.url === b.url && /\/impresa\/[A-Za-z0-9_-]{30,}$/.test(a.url), [a.url, b.url]);
      check('messaggio WhatsApp al numero giusto (39 + numero) col link', a.whatsapp.startsWith('https://wa.me/393331234567?text=') && a.testo.includes(a.url), a.whatsapp.slice(0, 60));
      const token = a.url.split('/impresa/')[1];

      let d = await L.datiPubblici(token);
      check('l\'impresa apre il link: dati da completare, 4 richieste obbligatorie + l\'assicurazione', d.impresa.daCompletare && d.richieste.length === 5 && d.richieste.filter(r => r.stato === 'manca').length === 5, d.richieste.map(r => [r.key, r.stato]));
      await L.salvaDati(token, { nome: 'Prova Selftest Impresa srl', piva: '12345678903', referente: 'Mario Prova' });
      d = await L.datiPubblici(token);
      check('scrive nome e P.IVA → non è più da completare', !d.impresa.daCompletare && d.impresa.nome === 'Prova Selftest Impresa srl', d.impresa);

      const file = { buffer: Buffer.from('%PDF-1.4\n%%EOF\n'), mimetype: 'application/pdf', originalname: 'doc.pdf', size: 15 };
      const finto = (r) => async () => r;
      let r = await L.caricaDaImpresa(token, { tipo: 'durc', file }, finto({ tipo: 'durc', ragione_sociale: 'PROVA SELFTEST IMPRESA S.R.L.', partita_iva: '12345678903', scadenza: '2027-01-20' }));
      const { data: sub } = await supabase.from('subcontractors').select('durc_expiry').eq('id', id).single();
      check('DURC buono → va bene, e la data va sull\'impresa', r.esito === 'va_bene' && sub.durc_expiry === '2027-01-20', { r, sub });
      r = await L.caricaDaImpresa(token, { tipo: 'dichiarazione', file }, finto({ tipo: 'dichiarazione', partita_iva: '12345678903', firmato: false }));
      check('dichiarazione senza firma → non va', r.esito === 'non_va' && r.motivo.codice === 'senza_firma', r);
      r = await L.caricaDaImpresa(token, { tipo: 'visura', file }, finto({ tipo: 'visura', partita_iva: '12345678903', data_documento: '2025-12-01' }));
      check('visura di dicembre 2025 → non va (vecchia)', r.esito === 'non_va' && r.motivo.codice === 'visura_vecchia', r);
      d = await L.datiPubblici(token);
      const stato = Object.fromEntries(d.richieste.map(x => [x.key, x.stato]));
      check('l\'impresa vede: DURC ok, dichiarazione e visura «non va» col motivo, DVR manca', stato.durc === 'ok' && stato.dichiarazione === 'non_va' && stato.visura === 'non_va' && stato.dvr === 'manca'
        && d.richieste.find(x => x.key === 'dichiarazione').motivo?.codice === 'senza_firma', d.richieste);

      let p = await I.panoramica(E2E);
      check('il titolare: prima cosa «ha mandato 3 documenti»', p.prima?.tipo === 'guardare' && p.prima.id === id && p.prima.quanti === 3, p.prima);
      let s = await I.scheda(E2E, id);
      const dich = s.ricevuti.find(x => x.label === 'Dichiarazione che non è sospesa');
      check('nella scheda: 3 ricevuti, la dichiarazione col motivo in italiano «Manca la firma»', s.ricevuti.length === 3 && dich?.motivo === 'Manca la firma' && !s.puoLavorare, s.ricevuti);
      const rif = await I.chiedi(E2E, null, id, { rifare: dich.id });
      check('«Chiedile di rifarla»: il messaggio dice cosa non va', /non va: manca la firma/.test(rif.testo), rif.testo);
      await I.vaBene(E2E, dich.id);
      s = await I.scheda(E2E, id);
      check('«Va bene lo stesso» → la dichiarazione conta', s.requisiti.find(x => x.key === 'dichiarazione').stato === 'ok', s.requisiti.find(x => x.key === 'dichiarazione'));
      await I.visti(E2E, id);
      p = await I.panoramica(E2E);
      check('dopo averli guardati la prima cosa non è più «guardali»', !(p.prima?.tipo === 'guardare' && p.prima.id === id), p.prima);

      const op = await L.aggiungiOperaio(token, { nome: 'Youssef Amrani' });
      let err = null;
      try { await L.aggiungiOperaio(token, { nome: 'Youssef' }); } catch (e) { err = e; }
      check('operaio dal link (nome e cognome; solo il nome → 400)', !!op.id && err?.code === 'NOME_E_COGNOME', err?.code);
      r = await L.caricaOperaio(token, op.id, { tipo: 'idoneita', file }, finto({ tipo: 'idoneita', persona: 'KARIM BENALI', scadenza: '2027-05-01' }));
      d = await L.datiPubblici(token);
      check('visita medica di un altro → non va, e l\'operaio resta senza visita', r.esito === 'non_va' && d.operai[0].idoneita.stato === 'non_va', d.operai);

      err = null;
      try { await L.datiPubblici('x'.repeat(43)); } catch (e) { err = e; }
      check('un token inventato non apre niente (404)', err?.status === 404, err?.code);
    } finally {
      if (id) {
        const { data: docs } = await supabase.from('subcontractor_documents').select('file_path').eq('subcontractor_id', id);
        const { data: ops } = await supabase.from('sub_workers').select('id').eq('subcontractor_id', id);
        const { data: dOp } = ops?.length ? await supabase.from('sub_worker_documenti').select('file_path').in('sub_worker_id', ops.map(o => o.id)) : { data: [] };
        const paths = [...(docs || []), ...(dOp || [])].map(x => x.file_path);
        if (paths.length) await supabase.storage.from(L.BUCKET).remove(paths).catch(() => {});
        await supabase.from('subcontractor_documents').delete().eq('subcontractor_id', id);
        if (ops?.length) await supabase.from('sub_workers').delete().eq('subcontractor_id', id);
        await supabase.from('sub_link').delete().eq('subcontractor_id', id);
        await supabase.from('subcontractors').update({ is_active: false }).eq('id', id);
      }
    }
  }

  console.log('\nF-376 — MSC (sola lettura)');
  const pm = await I.panoramica(MSC);
  const ayat = pm.imprese.find(x => x.nome === 'AYAT SRLS');
  check('MSC: AYAT c\'è, non può ancora lavorare', ayat && !ayat.puoLavorare, ayat);
  const sm = await I.scheda(MSC, ayat.id);
  const manca = [...sm.requisiti.filter(r => !r.consigliata), ...sm.pos].filter(r => r.stato !== 'ok').map(r => r.label);
  check('MSC: mancano visura (di novembre 2025), DVR, dichiarazione, POS per Via Riboli 4b e Via Chiodo 9C', manca.length === 5 && manca.includes('Visura camerale') && manca.includes('POS per Via Chiodo 9C'), manca);
  check('MSC: il DURC c\'è, fino al 28 novembre', sm.requisiti.find(r => r.key === 'durc')?.scadenza === '2026-11-28');

  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
