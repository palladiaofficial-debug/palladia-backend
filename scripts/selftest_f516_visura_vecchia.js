#!/usr/bin/env node
/**
 * scripts/selftest_f516_visura_vecchia.js — F-516 (AUDIT.md del frontend).
 *
 * Una visura di più di 6 mesi NON blocca l'impresa: l'Allegato XVII del D.Lgs. 81/2008
 * chiede l'iscrizione alla Camera di Commercio, non una visura recente (i 6 mesi sono
 * un'abitudine). Resta un avviso «chiedine una recente». Bloccano ancora: visura assente,
 * impresa non attiva dalla visura, patente, DURC, DVR, dichiarazione art. 14.
 *
 * 1. giudica() (puro): visura vecchia → va bene con l'avviso; vecchia e cessata → non va.
 * 2. verdettoDi() (puro): con la sola visura «vecchia» l'impresa può entrare.
 * 3. «E tu? Sei pronto a fare da subappalto?» (puro): la tua visura vecchia non ti ferma.
 * 4. Sull'azienda di prova (crea e poi toglie), col modello finto: impresa con tutto in
 *    regola e una visura di 7 mesi fa → può entrare, la visura è «vecchia»; senza visura → no.
 */
'use strict';
require('dotenv').config({ quiet: true });
process.env.FEATURE_SUBAPPALTATORI_DEFAULT = process.env.FEATURE_SUBAPPALTATORI_DEFAULT || 'true';
const supabase = require('../lib/supabase');
const { giudica, motivoItaliano } = require('../lib/impreseControllo');
const L = require('../lib/impreseLink');
const I = require('../lib/imprese');
const P = require('../lib/prontoSubappalto');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const E2E = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const OGGI = '2026-11-20';
const impresa = { nome: 'AYAT SRLS', piva: '13371360960' };
const letto = (x) => ({ tipo: 'altro', ragioneSociale: null, piva: null, sede: null, persona: null, dataDocumento: null, scadenza: null, firmato: null, cantiere: null, ...x });
const piuGiorni = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  console.log('\nF-516 — giudica(): la visura vecchia non è «non va»');
  let g = giudica('visura', letto({ tipo: 'visura', piva: '13371360960', dataDocumento: '2026-04-10' }), { impresa, oggi: OGGI });
  check('visura del 10 aprile (7 mesi) → va bene, con l\'avviso «visura vecchia»', g.esito === 'va_bene' && g.motivo?.codice === 'visura_vecchia' && g.scadenza === '2026-10-10', g);
  check('l\'avviso in italiano chiede una visura recente', /6 mesi/.test(motivoItaliano(g.motivo) || ''), motivoItaliano(g.motivo));
  g = giudica('visura', letto({ tipo: 'visura', piva: '13371360960', dataDocumento: '2026-04-10', statoAttivita: 'cessata' }), { impresa, oggi: OGGI });
  check('visura vecchia di un\'impresa cessata → non va (impresa non attiva): questo blocca', g.esito === 'non_va' && g.motivo?.codice === 'impresa_non_attiva', g);
  g = giudica('visura', letto({ tipo: 'visura', piva: '13371360960', dataDocumento: '2026-10-01' }), { impresa, oggi: OGGI });
  check('visura di ottobre → va bene, senza avvisi', g.esito === 'va_bene' && !g.motivo, g);

  console.log('\nF-516 — verdettoDi(): la sola visura vecchia non ferma l\'impresa');
  const req = (key, stato, x = {}) => ({ key, label: L.ETICHETTA[key], stato, scadenza: null, consigliata: false, motivo: null, ...x });
  const ok5 = ['patente', 'durc', 'dvr', 'dichiarazione'].map(k => req(k, 'ok'));
  let v = L.verdettoDi({ requisiti: [...ok5, req('visura', 'vecchia', { scadenza: '2026-10-10' })], pos: [], operai: [] });
  check('visura «vecchia», il resto in regola → può entrare (si), con l\'avviso visura', v.stato === 'si' && v.cose.length === 0 && v.vecchia === true, v);
  check('la data passata della visura non diventa «fino al»', v.finoAl !== '2026-10-10', v.finoAl);
  v = L.verdettoDi({ requisiti: [...ok5, req('visura', 'manca')], pos: [], operai: [] });
  check('visura che manca del tutto → non può entrare (no)', v.stato === 'no' && v.cose.some(c => c.label === 'Visura camerale'), v);
  v = L.verdettoDi({ requisiti: [req('patente', 'manca'), ...ok5.slice(1), req('visura', 'vecchia')], pos: [], operai: [] });
  check('patente che manca → no, e la visura vecchia non è tra le cose da chiedere', v.stato === 'no' && v.cose.length === 1 && v.cose[0].label === 'Patente a crediti', v.cose);

  console.log('\nF-516 — «Sei pronto a fare da subappalto?»: la tua visura vecchia non ti ferma');
  const doc = (cat, x = {}) => ({ id: cat, category: cat, created_at: '2026-04-10T10:00:00Z', ai_expiry_date: null, ...x });
  const tuoi = P.requisitiImpresa({ patente: doc('patente_crediti'), durc: doc('durc', { ai_expiry_date: '2027-02-01' }), visura: doc('visura'), dvr: doc('dvr'), dichiarazione: doc('dichiarazione_art14') }, {}, OGGI);
  const vt = P.verdettoTuo(tuoi, []);
  check('visura caricata il 10 aprile → «vecchia», ma il verdetto è sì', tuoi.find(r => r.key === 'visura').stato === 'vecchia' && vt.stato === 'si', { tuoi, vt });
  check('…e «hai tutto fino al» non è la data passata della visura', vt.finoAl === '2027-02-01', vt.finoAl);

  if (E2E) {
    console.log('\nF-516 — sull\'azienda di prova (crea e poi toglie), modello finto');
    let id = null;
    try {
      const c = await I.crea(E2E, { nome: 'Prova F516 Visura srl', piva: '12345678903' });
      id = c.id;
      const file = { buffer: Buffer.from('%PDF-1.4\n%%EOF\n'), mimetype: 'application/pdf', originalname: 'doc.pdf', size: 15 };
      const finto = (r) => async () => r;
      const base = { ragione_sociale: 'PROVA F516 VISURA S.R.L.', partita_iva: '12345678903' };
      await L.caricaDalTitolare(E2E, null, id, { tipo: 'patente', file }, finto({ ...base, tipo: 'patente', crediti: 30 }));
      await L.caricaDalTitolare(E2E, null, id, { tipo: 'durc', file }, finto({ ...base, tipo: 'durc', scadenza: piuGiorni(90) }));
      await L.caricaDalTitolare(E2E, null, id, { tipo: 'dvr', file }, finto({ ...base, tipo: 'dvr' }));
      await L.caricaDalTitolare(E2E, null, id, { tipo: 'dichiarazione', file }, finto({ ...base, tipo: 'dichiarazione', firmato: true }));
      let s = await I.scheda(E2E, id);
      check('senza visura → non può entrare', !s.puoLavorare && s.verdetto.stato === 'no', s.verdetto);
      const r = await L.caricaDalTitolare(E2E, null, id, { tipo: 'visura', file }, finto({ ...base, tipo: 'visura', data_documento: piuGiorni(-210), stato_attivita: 'attiva' }));
      check('visura di 7 mesi fa → va bene con l\'avviso', r.esito === 'va_bene' && r.motivo?.codice === 'visura_vecchia', r);
      s = await I.scheda(E2E, id);
      const vis = s.requisiti.find(x => x.key === 'visura');
      check('la scheda: visura «vecchia» (non «scaduto», non «non va»)', vis?.stato === 'vecchia', vis);
      check('la scheda: può entrare in cantiere, 0 cose che mancano', s.puoLavorare && s.verdetto.stato === 'si' && s.mancano === 0, { v: s.verdetto, mancano: s.mancano });
      const p = await I.panoramica(E2E);
      const riga = p.imprese.find(x => x.id === id);
      check('l\'elenco delle imprese: può lavorare', riga?.puoLavorare === true, riga);
    } finally {
      if (id) {
        const { data: docs } = await supabase.from('subcontractor_documents').select('file_path').eq('subcontractor_id', id);
        const paths = (docs || []).map(x => x.file_path);
        if (paths.length) await supabase.storage.from(L.BUCKET).remove(paths).catch(() => {});
        await supabase.from('subcontractor_documents').delete().eq('subcontractor_id', id);
        await supabase.from('sub_link').delete().eq('subcontractor_id', id);
        await supabase.from('subcontractors').update({ is_active: false }).eq('id', id);
      }
    }
  }

  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
