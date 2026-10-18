#!/usr/bin/env node
/**
 * scripts/selftest_avviso_sub_non_in_regola.js — F-377 (AUDIT.md del frontend).
 *
 * Deciso dal titolare il 18/10: un operaio di un'impresa non in regola che
 * entra in cantiere NON si blocca, si avvisa. Sull'azienda di prova (crea e
 * poi toglie): un cantiere attivo, un'impresa senza documenti assegnata, due
 * suoi operai. Il primo entra dall'ufficio:
 *  - l'entrata è registrata (come prima: niente blocco);
 *  - arriva UN avviso «… è in cantiere ma non è in regola» con chi è entrato
 *    e cosa manca, in Da fare col tocco alla scheda dell'impresa;
 * il secondo entra: stesso avviso (uno al giorno per impresa e cantiere), con
 * entrambi i nomi. Un'impresa in regola con operai in regola → nessun avviso
 * (controllato sulla funzione, con lo stato finto).
 */
'use strict';
require('dotenv').config({ quiet: true });
process.env.FEATURE_SUBAPPALTATORI_DEFAULT = process.env.FEATURE_SUBAPPALTATORI_DEFAULT || 'true';
const supabase = require('../lib/supabase');
const S = require('../lib/subPresenze');
const I = require('../lib/imprese');
const { testoAvviso } = require('../lib/impreseAvviso');
const { buildDaFare } = require('../lib/daFare');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const E2E = process.env.E2E_COMPANY_ID;
const aspetta = (ms) => new Promise(r => setTimeout(r, ms));
async function avvisoDi(subId) {
  for (let i = 0; i < 30; i++) {
    const { data } = await supabase.from('notifications').select('id, title, body, entity_id, entity_type, read_by').eq('company_id', E2E).eq('type', 'sub_non_in_regola').like('entity_id', `${subId}:%`);
    if (data?.length) return data;
    await aspetta(500);
  }
  return [];
}

(async () => {
  console.log('\nF-377 — il testo dell\'avviso (puro)');
  const stato = (x) => ({ puoLavorare: false, requisiti: [], pos: [], operai: [], ...x });
  let t = testoAvviso({ impresa: 'AYAT SRLS', cantiere: 'Via Riboli 4b', nomi: ['Youssef Amrani'],
    stato: stato({ requisiti: [{ key: 'visura', label: 'Visura camerale', stato: 'scaduto' }, { key: 'durc', label: 'DURC', stato: 'ok' }, { key: 'assicurazione', label: 'Assicurazione RC', stato: 'manca', consigliata: true }], pos: [{ siteId: 's1', label: 'POS per Via Riboli 4b', stato: 'manca' }] }), siteId: 's1' });
  check('impresa non in regola → titolo, chi è entrato, cosa manca (non la consigliata), «non l\'ho bloccato»',
    t && t.title === 'AYAT SRLS è in cantiere ma non è in regola' && /Youssef Amrani/.test(t.body) && /visura camerale/i.test(t.body) && /POS di questo cantiere/.test(t.body) && !/Assicurazione/i.test(t.body) && /non l'ho bloccat/.test(t.body), t);
  t = testoAvviso({ impresa: 'Edil Rossi', cantiere: 'Via Chiodo 9C', nomi: ['Karim Benali'], siteId: 's2',
    stato: stato({ puoLavorare: true, operai: [{ nome: 'Karim Benali', idoneita: { stato: 'manca' }, formazione: { stato: 'ok' } }] }) });
  check('impresa in regola ma l\'operaio senza visita → avviso sull\'operaio', t && /Karim Benali/.test(t.body) && /visita medica/i.test(t.body), t);
  t = testoAvviso({ impresa: 'Edil Rossi', cantiere: 'Via Chiodo 9C', nomi: ['Karim Benali'], siteId: 's2',
    stato: stato({ puoLavorare: true, operai: [{ nome: 'Karim Benali', idoneita: { stato: 'ok' }, formazione: { stato: 'in_scadenza' } }] }) });
  check('tutto in regola → nessun avviso', t === null, t);

  if (!E2E) { console.log('E2E_COMPANY_ID non configurato: salto la parte sul DB'); }
  else {
    console.log('\nF-377 — un ingresso vero sull\'azienda di prova');
    let siteId = null, subId = null;
    try {
      const { data: site, error } = await supabase.from('sites').insert({ company_id: E2E, name: `TEST-F377 ${Date.now()}`, address: 'Via Prova 1, Genova', status: 'attivo' }).select('id, name').single();
      if (error) throw new Error(error.message);
      siteId = site.id;
      const imp = await I.crea(E2E, { nome: `TEST-F377 Impresa ${Date.now()}`, piva: `07${String(Date.now()).slice(-9)}` });
      subId = imp.id;
      await I.mettiInCantiere(E2E, subId, siteId);
      const a = await S.aggiungiPersona({ companyId: E2E, subcontractorId: subId, fullName: 'Youssef Amrani', addedVia: 'ufficio' });
      const b = await S.aggiungiPersona({ companyId: E2E, subcontractorId: subId, fullName: 'Karim Benali', addedVia: 'ufficio' });

      const r1 = await S.segnaDaUfficio({ companyId: E2E, userId: null, siteId, subWorkerId: a.id, event: 'entrata' });
      check('l\'entrata è registrata: non si blocca', r1.dentro === true && r1.unchanged === false && !!r1.id, r1);
      let av = await avvisoDi(subId);
      check('arriva UN avviso «… è in cantiere ma non è in regola» con chi è entrato e cosa manca', av.length === 1 && /è in cantiere ma non è in regola/.test(av[0].title) && /Youssef Amrani/.test(av[0].body) && /DURC/.test(av[0].body), av);

      await S.segnaDaUfficio({ companyId: E2E, userId: null, siteId, subWorkerId: b.id, event: 'entrata' });
      for (let i = 0; i < 20; i++) { av = await avvisoDi(subId); if (/Karim Benali/.test(av[0]?.body || '')) break; await aspetta(500); }
      check('entra il secondo: sempre UN avviso (uno al giorno per impresa e cantiere), con tutti e due i nomi', av.length === 1 && /Youssef Amrani/.test(av[0].body) && /Karim Benali/.test(av[0].body), av);

      const df = await buildDaFare(E2E, null);
      const voce = (df.items || df).find?.(x => x.type === 'sub_non_in_regola' && String(x.link || '').includes(subId));
      check('in Da fare, col tocco alla scheda dell\'impresa', !!voce && voce.link === `/imprese/${subId}` && voce.urgent === true, voce);
    } finally {
      if (subId) {
        await supabase.from('notifications').delete().eq('company_id', E2E).eq('type', 'sub_non_in_regola').like('entity_id', `${subId}:%`);
        await supabase.from('sub_presenze').delete().eq('subcontractor_id', subId);
        await supabase.from('sub_workers').delete().eq('subcontractor_id', subId);
        await supabase.from('site_subcontractors').delete().eq('subcontractor_id', subId);
        await supabase.from('subcontractors').update({ is_active: false }).eq('id', subId);
      }
      if (siteId) await supabase.from('sites').update({ status: 'eliminato' }).eq('id', siteId);
    }
  }
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
