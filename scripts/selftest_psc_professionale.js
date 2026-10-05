#!/usr/bin/env node
/**
 * scripts/selftest_psc_professionale.js — F-293, F-297, F-298, F-299, F-300
 * (AUDIT.md del frontend). Il secondo giro sulla prova del primo coordinatore
 * vero: "prodotto molto buono, ma non ancora abbastanza professionale".
 * Funzioni pure: niente DB, niente AI (il modello dell'ortografia è finto).
 */
'use strict';
require('dotenv').config({ quiet: true });
const P = require('../lib/psc/prezzario');
const C = require('../lib/psc/costi');
const O = require('../lib/psc/ortografia');
const W = require('../lib/psc/settimane');
const I = require('../lib/psc/interferenze');
const S = require('../lib/lavorazioniSchede');
const documento = require('../lib/psc/documento');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

(async () => {
  // ── F-293 prezzario ─────────────────────────────────────────────────────────
  console.log('\n\x1b[1mF-293 — Prezzario regionale\x1b[0m');
  const lig = P.PUBBLICI.find(p => p.id === 'liguria-2025');
  check('Prezzario Liguria 2025 · Sicurezza incluso, 89 articoli della sezione 95', !!lig && lig.voci.length === 89 && lig.voci.every(v => /^95\./.test(v.codice) && v.prezzo > 0), lig && lig.voci.length);
  const rec = lig && lig.voci.find(v => v.codice === '95.A10.A10.010');
  check('95.A10.A10.010 = recinzione in pannelli, 7,51 €/m (dal PDF ufficiale)', rec && rec.prezzo === 7.51 && rec.um === 'm' && /Recinzione di cantiere/.test(rec.descrizione), rec);
  // lettore del PDF su un estratto reale (pagina 555)
  const estratto = ['--- Pagina 555 ---', '95 [Sicurezza (Dlgs 81/2008 e s.m.i.)]', '1.2.1. A05 - Quadro elettrico di cantiere', 'CODICE DESCRIZIONE U.M. PREZZO % MO SIC', 'FINALE',
    'Ammortamento giornaliero quadro elettrico da cantiere 12 prese', '95.A10.A05.010 giorno 2,24 € 0,00 0,00 €', '(durata 2 anni)',
    '1.2.4. A15 - Delimitazione area di lavoro con rete arancione', 'CODICE DESCRIZIONE U.M. PREZZO % MO SIC', 'FINALE', 'Delimitazione di area di lavoro con rete in polietilene di colore',
    '95.A10.A15.005 arancione e tondino in acciaio con relativo fungo copritondino m 8,06 € 62,12 0,30 €', 'per un\'altezza complessiva fuori terra di 1,2 m.', 'Pagina 555 di 1014'].join('\n');
  const letti = P.parseLiguriaPdfText(estratto);
  check('lettore PDF: 2 articoli, descrizione ricomposta sopra e sotto il codice', letti.length === 2 && /12 prese \(durata 2 anni\)$/.test(letti[0].descrizione) && /copritondino per un'altezza complessiva fuori terra di 1,2 m\.$/.test(letti[1].descrizione) && letti[1].prezzo === 8.06, letti);
  const xls = P.parseListinoRighe([['Prezzario Regione Toscana'], ['Codice', 'Descrizione', 'U.M.', 'Prezzo'], ['', 'Apprestamenti', '', ''], ['TOS.S.01', 'Recinzione metallica', 'm', 9.2], ['TOS.S.02', 'Bagno chimico', 'cad/mese', '145,50']]);
  check('Excel/CSV: intestazione riconosciuta, capitolo e prezzi (anche "145,50")', xls.length === 2 && xls[1].prezzo === 145.5 && xls[0].capitolo === 'Apprestamenti', xls);
  check('ricerca: "bagno chimico" trova il locale igienico chimico', P.cerca(lig.voci, 'bagno chimico')[0].codice === '95.C10.A10.050');
  check('ricerca: "ponteggio" trova le ponteggiature di facciata', P.cerca(lig.voci, 'ponteggio').some(v => v.codice === '95.B10.S10.011'));
  check('regione: Genova → Liguria, Milano → nessuna', P.regioneDi({ provincia: 'Genova' }) === 'Liguria' && P.regioneDi({ comune: 'Milano', provincia: 'MI' }) === null);
  const voci = C.proponi({ project: { start_date: '2026-10-15', end_date: '2027-01-14', provincia: 'GE' }, lavorazioni: [{ scheda_id: 'ponteggio-montaggio' }], regionale: P.regionalePer({ provincia: 'GE' }) });
  const recP = voci.find(v => v.origine === 'catalogo:recinzione');
  check('cantiere ligure: "Proponi le voci" usa codice e prezzo del prezzario regionale', recP && recP.codice === '95.A10.A10.010' && recP.prezzo === 7.51 && recP.prezzo_fonte === 'prezzario' && /Liguria 2025/.test(recP.prezzario_fonte), recP);
  check('cantiere ligure: il ponteggio prende 95.B10.S10.011', voci.some(v => v.codice === '95.B10.S10.011'));
  const fuori = C.proponi({ project: { start_date: '2026-10-15', end_date: '2027-01-14', provincia: 'MI' }, lavorazioni: [] });
  check('cantiere fuori Liguria: prezzi indicativi come prima', fuori.every(v => v.prezzo_fonte !== 'prezzario'));
  const lib = [{ kind: 'costo', testo: 'Mia recinzione', data: { key: 'recinzione', prezzo: 10 } }];
  const conLib = C.proponi({ project: { provincia: 'GE' }, lavorazioni: [], library: lib, regionale: P.regionalePer({ provincia: 'GE' }) });
  check('il prezzo del coordinatore (libreria) resta davanti al prezzario', conLib.find(v => v.origine === 'catalogo:recinzione').prezzo_fonte === 'libreria');

  // ── F-297 ortografia ────────────────────────────────────────────────────────
  console.log('\n\x1b[1mF-297 — Controlla l\'ortografia\x1b[0m');
  const all = {
    project: { descrizione: 'Ristrutturazone della facciata', organizzazione: { recinzione: { attivo: true, titolo: 'Recinzione', testo: 'La recinzone è alta 2 m.' } }, coordinamento: { riunioni: 'Riunioni ogni due settimane' } },
    lavorazioni: [{ id: 'L1', nome: 'Ponteggio', misure: [{ id: 'm1', testo: 'Area sottostante delimtata' }], rischi: [], fasi: ['Montagio'] }],
    decisioni: [{ id: 'D1', testo: 'Le due imprese lavorano in zone diverse' }],
  };
  const testi = O.testiDa(all);
  check('raccoglie i testi del PSC con il loro campo', ['p:descrizione', 'p:org:recinzione', 'l:L1:m:m1', 'l:L1:f:0', 'd:D1'].every(r => testi.some(t => t.ref === r)), testi.map(t => t.ref));
  const finto = async ({ content }) => ({ input: { correzioni: content.split('\n\n').flatMap(b => {
    const id = b.match(/^\[(t\d+)\]/)[1];
    const out = [];
    if (/Ristrutturazone/.test(b)) out.push({ id, sbagliato: 'Ristrutturazone', corretto: 'Ristrutturazione' });
    if (/delimtata/.test(b)) out.push({ id, sbagliato: 'delimtata', corretto: 'delimitata' });
    if (/Montagio/.test(b)) out.push({ id, sbagliato: 'Montagio', corretto: 'Montaggio' });
    if (/imprese/.test(b)) out.push({ id, sbagliato: 'imprese lavorano in zone diverse e', corretto: 'x' }); // non presente: va scartata
    return out;
  }) } });
  const corr = await O.controlla(testi, finto);
  check('tiene solo le correzioni presenti davvero nel testo', corr.length === 3 && corr.every(c => c.contesto.includes(c.sbagliato)), corr);
  const ap = O.applica(all, corr);
  check('applica: descrizione, misura e fase corrette, nient\'altro toccato', ap.applicate === 3 && ap.project.descrizione === 'Ristrutturazione della facciata' && ap.lavorazioni.get('L1').misure[0].testo === 'Area sottostante delimitata' && ap.lavorazioni.get('L1').fasi[0] === 'Montaggio' && !('organizzazione' in ap.project), { p: ap.project, l: [...ap.lavorazioni] });
  check('applica: una correzione su testo cambiato nel frattempo non fa niente', O.applica(all, [{ ref: 'p:descrizione', sbagliato: 'inesistente', corretto: 'x' }]).applicate === 0);

  // ── F-298 settimane ─────────────────────────────────────────────────────────
  console.log('\n\x1b[1mF-298 — Cronoprogramma a settimane\x1b[0m');
  check('lunedì e venerdì della settimana (mer 21/10/2026 → 19/10 e 23/10)', W.lunedi('2026-10-21') === '2026-10-19' && W.venerdi('2026-10-21') === '2026-10-23');
  check('settimana 1 = quella dell\'inizio lavori (gio 15/10 → S1; lun 26/10 → S3)', W.numero('2026-10-15', '2026-10-15') === 1 && W.numero('2026-10-26', '2026-10-15') === 3);
  const ar = W.arrotonda({ start_date: '2026-10-21', end_date: '2026-11-03' });
  check('una lavorazione si arrotonda a settimane intere (lunedì–venerdì)', ar.start_date === '2026-10-19' && ar.end_date === '2026-11-06' && W.durata(ar) === 3, ar);
  check('etichetta "settimane 2–4"', W.etichetta(ar, '2026-10-15') === 'settimane 2–4');
  const la = { id: 'a', nome: 'Ponteggio', scheda_id: 'ponteggio-montaggio', start_date: '2026-10-19', end_date: '2026-11-06' };
  const lb = { id: 'b', nome: 'Impianto elettrico', scheda_id: 'impianti-elettrici', start_date: '2026-10-26', end_date: '2026-11-13' };
  const det = I.detect([la, lb], []).aperte[0];
  const sol = I.soluzioni(det, new Map([['a', la], ['b', lb]]), new Map(), '2027-01-14', { scala: 'settimane', inizio: '2026-10-15' });
  const temp = sol.opzioni.find(o => o.soluzione === 'temporale');
  check('sfasamento temporale a settimane: "inizia nella settimana 5", stessa durata in settimane', /inizia nella settimana 5 \(dal 9 novembre\)/.test(temp.testo) && /termina nella settimana 7/.test(temp.testo) && temp.sposta.start_date === '2026-11-09' && temp.sposta.end_date === '2026-11-27', temp);
  const solG = I.soluzioni(det, new Map([['a', la], ['b', lb]]), new Map(), '2027-01-14');
  check('a giorni resta il testo con le date', /inizia il /.test(solG.opzioni[0].testo));

  // ── F-299 lavorazioni ──────────────────────────────────────────────────────
  console.log('\n\x1b[1mF-299 — Lavorazioni aggiunte\x1b[0m');
  check(`almeno 84 schede (${S.SCHEDE.length})`, S.SCHEDE.length >= 84);
  for (const id of ['ferro-lavorazione', 'strutture-legno', 'rinforzi-frp', 'consolidamento-murature', 'fognature-tubazioni', 'rinterri-compattazione', 'amianto-friabile', 'linee-vita-permanenti', 'impianti-climatizzazione', 'impianti-antincendio', 'colonne-scarico', 'impianti-speciali', 'rivestimenti-facciata', 'sabbiatura', 'porte-falegnameria', 'levigatura-pavimenti', 'montacarichi-argani', 'recinzioni-muretti']) {
    check(`scheda ${id}`, !!S.getScheda(id));
  }

  // ── F-300 PDF ──────────────────────────────────────────────────────────────
  console.log('\n\x1b[1mF-300 — PDF: cronoprogramma, organigramma, interferenze, costi\x1b[0m');
  const snap = {
    project: { title: 'Via Crimea 10', address: 'Via Crimea, 10', comune: 'Genova', tipo_opera: 'manutenzione straordinaria', start_date: '2026-10-15', end_date: '2027-01-14', crono_scala: 'settimane', revision: 0,
      soggetti: { committente: { nome: 'Condominio' }, responsabile_lavori: { nome: 'Amabile Veiga' }, csp: { nome: 'Claudia Pastorino' }, cse: { nome: 'Claudia Pastorino' } } },
    lavorazioni: [{ ...la, impresa_id: 'i1', rischi: [], misure: [], dpi: [], apprestamenti: [], fasi: [] }, { ...lb, impresa_id: 'i2', rischi: [], misure: [], dpi: [], apprestamenti: [], fasi: [] }],
    imprese: [{ id: 'i1', ragione_sociale: 'Ponteggi srl', ruolo: 'affidataria' }, { id: 'i2', ragione_sociale: 'Elettro snc', ruolo: 'esecutrice' }],
    costi: [{ categoria: 'a', ordine: 0, descrizione: 'Recinzione', um: 'm', quantita: 10, prezzo: 7.51, codice: '95.A10.A10.010', prezzo_fonte: 'prezzario', prezzario_fonte: 'Prezzario Regione Liguria 2025 · Sicurezza' },
      { categoria: 'b', ordine: 1, descrizione: 'Cartelli', um: 'cad', quantita: 2, prezzo: 15, codice: null, prezzo_fonte: 'manuale' }],
    decisioni: [{ id: 'D1', lav_a: 'a', lav_b: 'b', soluzione: 'misure', testo: 'Zona sotto il ponteggio interdetta.', rischio: 'caduta di materiale dall\'alto' }], revisioni: [],
  };
  const html = documento.pscHtml(snap, {});
  const gt = html.slice(html.indexOf('<div class="gt"'));
  check('cronoprogramma disegnato: una barra continua per lavorazione', (gt.match(/class="bar"/g) || []).length === 2, (gt.match(/class="bar"/g) || []).length);
  check('cronoprogramma a settimane: intestazione S1, S2… e durata "3 sett."', />S1</.test(gt) && />S4</.test(gt) && /3 sett\./.test(gt));
  check('legenda delle imprese sotto il cronoprogramma', /class="leg-imp"[\s\S]*Ponteggi srl[\s\S]*Elettro snc/.test(html));
  check('organigramma disegnato: collegamenti in SVG, coordinamento tratteggiato', /<div class="org"[\s\S]*<svg[\s\S]*stroke-dasharray/.test(html));
  check('interferenze come schede con periodo a settimane, rischio e prescrizione', /class="intf"[\s\S]*Periodo: settimane 3–4[\s\S]*Rischio[\s\S]*Misure di coordinamento/.test(html));
  check('costi: fonte del prezzario dichiarata; colonna Codice solo dove ci sono codici', /Prezzi unitari: Prezzario Regione Liguria 2025/.test(html) && (html.match(/<th style="width:27mm">Codice<\/th>/g) || []).length === 1);
  check('firme raccolte in un blocco con il titolo "Firme"', /<div class="firme"><h3>Firme<\/h3>/.test(html));
  const word = documento.pscWord(snap);
  check('Word: cronoprogramma e organigramma restano tabelle (Word non legge l\'SVG)', !/<svg/.test(word) && /class="gantt"/.test(word) && /class="org"/.test(word));

  console.log(`\n  ${passed} passati, ${failed} falliti\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
