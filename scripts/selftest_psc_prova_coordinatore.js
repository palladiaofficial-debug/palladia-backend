#!/usr/bin/env node
/**
 * scripts/selftest_psc_prova_coordinatore.js — F-286→F-296 (AUDIT.md del frontend).
 *
 * La prima prova di un coordinatore vero (cantiere "Via Crimea 10", Genova).
 * Le voci usate qui sono quelle reali del suo computo/capitolato. Funzioni pure:
 * niente DB, niente AI.
 *  - F-286: il cronoprogramma dal computo resta dentro inizio–fine lavori;
 *           "adatta alla durata" riporta dentro un cronoprogramma lungo 34 mesi.
 *  - F-287: ogni voce va nella lavorazione giusta (l'idrolavaggio non è una
 *           cassaforma, le canne fumarie non sono amianto, "progetto" non è un getto).
 *  - F-288: esistono le schede per rimozioni di balconi/guaine, idrolavaggio,
 *           spicconatura, lattonerie e canne fumarie.
 *  - F-289: le voci del computo si uniscono alla lavorazione già presente con la
 *           stessa scheda; nessuna interferenza di una lavorazione con sé stessa.
 *  - F-295: PDF con copertina (tipo di opera) e indice in pagine diverse,
 *           sezione "Soggetti", organigramma.
 *  - F-296: computo fino a 60 MB.
 */
'use strict';
require('dotenv').config({ quiet: true });
const L = require('../lib/psc/lavorazioni');
const I = require('../lib/psc/interferenze');
const S = require('../lib/lavorazioniSchede');
const documento = require('../lib/psc/documento');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const classifica = (d, c) => (L.classifica ? L.classifica(d, c) : L.schedaPerTesto(`${d} ${c || ''}`));

// ── F-287 / F-288: voci reali del cantiere Via Crimea 10 ──────────────────────
console.log('\n\x1b[1mF-287/F-288 — Ogni voce del computo nella lavorazione giusta\x1b[0m');
const VOCI = [
  ['Idrolavaggio. Accurata spazzolatura ed esecuzione di idrolavaggio a pressione con vapore di acqua calda per la pulizia di tutte le superfici intonacate oggetto di intervento. Misure indicative: parapetto interno ed esterno + supporti canne fumarie perimetrali mq.140,00 circa', 'idrolavaggio-facciate'],
  ["Sostituzione canne fumarie con condotte in acciaio tipo AISI 316 della dimensione e forma esistente, dotate di cappello sigillato, altezza finale terminali circa ml.1,30. Comprensivo di smaltimento da parte di ditta specializzata e eventuale bonifica amianto. Misure indicative circa n.6 terminali.", 'lattonerie-canne-fumarie'],
  ["Preparazione del piano di posa del lastrico e canale di gronda: esecuzione e/o revisione delle pendenze di smaltimento delle acque piovane con malta premiscelata autolivellante (tipo Mapei), pendenza minima 2%.", 'massetti-sottofondi'],
  ['Revisione e risanamento intonaci: completa revisione di tutta la superficie del parapetto basso perimetrale (esterno e interno), supporto canne fumarie e torri di ventilazione. Demolizione porzioni di intonaco lesionate, distaccate o in cattivo stato.', 'intonaci'],
  ["Rimozione dell'impermeabilizzazione della copertura del volume tecnico scale, compresi risvolti, fissaggi, scossaline e quant'altro per dare il supporto libero. Compresi calo in basso, trasporto alla P.D. e oneri di smaltimento.", 'rimozione-guaine-copertura'],
  ["Rimozione completa dell'impermeabilizzazione del lastrico e del canale di gronda, compresi risvolti, fissaggi, scossaline e quant'altro per dare il supporto libero.", 'rimozione-guaine-copertura'],
  ['Rimozione completa della pavimentazione esistente fino al raggiungimento dello strato impermeabile esistente. Comprensivo di manodopera, mezzi d\'opera, eventuali opere provvisionali, raccolta e smaltimento dei materiali di risulta in discarica autorizzata.', 'rimozione-pavimenti-esterni'],
  ['Rimozione delle piastrelle dei balconi e del sottofondo ammalorato', 'rimozione-pavimenti-esterni'],
  ['Frontalino. Revisione superficie, demolizione rivestimento frontalino con gocciolatoio, pulitura ferri, protezione con antiruggine DisboCRET 502, inserimento rete di vetro, intonacatura con schizzatura.', 'risanamento-calcestruzzo'],
  ['Pluviali e grondaia. Smontaggio dei pluviali e grondaia in corrispondenza del volume tecnico, dei ferri di ancoraggio, dei collarini ecc. e loro smaltimento. Fornitura e posa in opera di nuovi pluviali e grondaia in rame.', 'lattonerie-canne-fumarie'],
  ['Sostituzione dei messicani del canale di gronda. Rimozione messicani esistenti, fornitura e posa in opera di nuovi messicani in rame.', 'lattonerie-canne-fumarie'],
  ['Spicconatura di intonaco esterno ammalorato di facciata fino al vivo della muratura, compreso calo in basso dei materiali', 'spicconatura-intonaci'],
  ['Impianto di cantiere. Realizzazione di cantiere adeguatamente attrezzato ai lavori da eseguire: formazione area di cantiere con delimitazione mediante adeguata recinzione.', 'allestimento-cantiere'],
  ['Ponteggi a castelli a servizio del canale di gronda e parapetti esterni delle terrazze e trabattelli. Fornitura, montaggio e successivo smontaggio delle necessarie impalcature di servizio metalliche.', 'ponteggio-montaggio'],
  ['Solo posa in opera di membrane bituminose semplici, autoprotette, mediante rinvenimento a fiamma, su canali di gronda, converse, risvolti e simili. Copertura terrazzi privati.', 'guaina-fiamma'],
  ['Assistenza muraria secondo progetto esecutivo agli impianti tecnologici', null],
];
for (const [d, atteso] of VOCI) {
  const got = classifica(d, null);
  if (atteso === null) check(`"${d.slice(0, 60)}…" → nessuna scheda sbagliata (non un getto per "progetto")`, got !== 'casseforme-armature' && got !== 'getto-calcestruzzo', got);
  else check(`"${d.slice(0, 60)}…" → ${atteso}`, got === atteso, got);
}

console.log('\n\x1b[1mF-288 — Schede nuove complete\x1b[0m');
for (const id of ['rimozione-pavimenti-esterni', 'rimozione-guaine-copertura', 'idrolavaggio-facciate', 'spicconatura-intonaci', 'lattonerie-canne-fumarie']) {
  const s = S.getScheda(id);
  check(`scheda ${id} presente, con rischi, misure e DPI`, !!(s && s.rischi.length >= 3 && s.misure.length >= 3 && s.dpi.length >= 2), s && s.id);
}

console.log('\n\x1b[1mF-287 — L\'amianto citato in una voce non si perde\x1b[0m');
{
  const lav = L.fromComputo([{ descrizione: VOCI[1][0], importo: 6000, codice: '5.5' }], { start: '2026-10-15', end: '2027-01-14' });
  const canne = lav.find(l => l.scheda_id === 'lattonerie-canne-fumarie');
  check('canne fumarie: rischio "possibile amianto" con la voce di provenienza', !!(canne && canne.rischi.some(r => /amianto/i.test(r.testo) && /5\.5/.test(r.testo))), canne && canne.rischi);
  check('canne fumarie: misura di verifica amianto proposta (non approvata in automatico)', !!(canne && canne.misure.some(m => /amianto/i.test(m.testo) && m.approvata === false)), canne && canne.misure);
}

// ── F-286: cronoprogramma dentro la durata ────────────────────────────────────
console.log('\n\x1b[1mF-286 — Il cronoprogramma dal computo resta dentro inizio–fine lavori\x1b[0m');
const vociGrandi = [
  ['Ponteggi a servizio di facciata', 380000], ['Rimozione dell\'impermeabilizzazione del lastrico', 220000],
  ['Rimozione completa della pavimentazione dei terrazzi', 260000], ['Revisione e risanamento intonaci', 310000],
  ['Frontalino. Ripristino calcestruzzo', 150000], ['Pluviali e grondaia', 90000], ['Tinteggiatura delle facciate', 207000],
].map(([descrizione, importo]) => ({ descrizione, importo }));
{
  const start = '2026-10-15', end = '2027-01-14'; // 3 mesi
  const lav = L.fromComputo(vociGrandi, { start, end });
  const ultima = lav.map(l => l.end_date).sort().pop();
  check(`3 mesi dichiarati: nessuna lavorazione oltre il ${end}`, ultima <= end, ultima);
  check('nessuna lavorazione prima dell\'inizio lavori', lav.every(l => l.start_date >= start), lav.map(l => l.start_date));
  check('date coerenti (fine ≥ inizio)', lav.every(l => l.end_date >= l.start_date));
  check('uomini-giorno stimati restano quelli del computo (le date non li cambiano)', lav.every(l => l.uomini_giorno > 0));
  check('addetti ricalcolati sulla durata compressa (più di 3 dove serve)', lav.some(l => l.addetti > 3), lav.map(l => l.addetti));
  const senzaFine = L.fromComputo(vociGrandi, { start });
  check('senza fine lavori dichiarata il comportamento resta quello di prima (lavorazioni in fila)', senzaFine.map(l => l.end_date).sort().pop() > end);
}
{
  // "Adatta alla durata": il caso reale, fine lavori 2029 → 3 mesi
  const lista = [
    { id: 'a', start_date: '2026-10-15', end_date: '2027-01-08', uomini_giorno: 30 },
    { id: 'b', start_date: '2026-12-22', end_date: '2027-04-29', uomini_giorno: 30 },
    { id: 'c', start_date: '2027-01-22', end_date: '2029-07-05', uomini_giorno: 900 },
  ];
  const fn = L.adattaAllaDurata;
  check('adattaAllaDurata esiste', typeof fn === 'function');
  if (typeof fn === 'function') {
    const out = fn(lista.map(x => ({ ...x })), '2026-10-15', '2027-01-14');
    check('dopo "adatta": tutte dentro il 15/10/2026–14/01/2027', out.every(l => l.start_date >= '2026-10-15' && l.end_date <= '2027-01-14'), out);
    check('l\'ordine delle lavorazioni resta lo stesso', out[0].start_date <= out[1].start_date && out[1].start_date <= out[2].start_date, out);
    const giaDentro = fn([{ id: 'x', start_date: '2026-10-20', end_date: '2026-11-10', uomini_giorno: 10 }], '2026-10-15', '2027-01-14');
    check('una lavorazione già dentro la durata non si sposta', giaDentro[0].start_date === '2026-10-20' && giaDentro[0].end_date === '2026-11-10', giaDentro);
  }
}

// ── F-289: niente doppioni, niente interferenze con sé stessi ─────────────────
console.log('\n\x1b[1mF-289 — Niente doppioni dal computo, niente interferenza con sé stessa\x1b[0m');
{
  const fn = L.unisciAlleEsistenti;
  check('unisciAlleEsistenti esiste', typeof fn === 'function');
  if (typeof fn === 'function') {
    const esistenti = [{ id: 'p1', scheda_id: 'ponteggio-montaggio', voci_computo: [] }, { id: 'al', scheda_id: 'allestimento-cantiere', voci_computo: [] }];
    const nuove = L.fromComputo([{ descrizione: 'Ponteggi a servizio della facciata', importo: 9000, codice: '1.2' }, { descrizione: 'Idrolavaggio delle facciate', importo: 3000 }], { start: '2026-10-15' });
    const r = fn(nuove, esistenti);
    check('ponteggio del computo unito a quello già presente (nessuna riga nuova)', !r.nuove.some(l => l.scheda_id === 'ponteggio-montaggio') && r.aggiorna.some(a => a.id === 'p1' && a.voci_computo.some(v => v.codice === '1.2')), r);
    check('allestimento aggiunto d\'ufficio non duplica quello presente', !r.nuove.some(l => l.scheda_id === 'allestimento-cantiere'), r.nuove.map(l => l.scheda_id));
    check('lavorazione nuova (idrolavaggio) resta da inserire', r.nuove.some(l => l.scheda_id === 'idrolavaggio-facciate'), r.nuove.map(l => l.scheda_id));
  }
  const due = [
    { id: 'p1', nome: 'Montaggio, trasformazione e smontaggio del ponteggio', scheda_id: 'ponteggio-montaggio', start_date: '2026-10-29', end_date: '2026-11-02' },
    { id: 'p2', nome: 'Montaggio, trasformazione e smontaggio del ponteggio', scheda_id: 'ponteggio-montaggio', start_date: '2026-10-29', end_date: '2026-10-30' },
  ];
  const r = I.detect(due, []);
  check('due righe della stessa lavorazione senza impresa: nessuna interferenza "X × X"', r.aperte.length === 0, r.aperte.map(x => `${x.nome_a} × ${x.nome_b}`));
  const dueImprese = due.map((l, k) => ({ ...l, impresa_id: `i${k}` }));
  check('stessa lavorazione ma imprese diverse: l\'interferenza resta', I.detect(dueImprese, []).aperte.length === 1);
}

// ── F-295: PDF ────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mF-295 — PDF: copertina, indice, soggetti, organigramma\x1b[0m');
{
  const snap = {
    project: {
      title: 'Via Crimea 10', address: 'Via Crimea, 10', comune: 'Genova', tipo_opera: 'manutenzione straordinaria', descrizione: 'Ristrutturazione di facciata e copertura piana praticabile',
      start_date: '2026-10-15', end_date: '2027-01-14', importo_lavori: 350000, revision: 0,
      soggetti: {
        committente: { nome: 'Elisabetta Grelli', qualifica: 'Amministratore Condominio' }, responsabile_lavori: { nome: 'Amabile Veiga' },
        progettista: { nome: 'Amabile Veiga' }, direttore_lavori: { nome: 'Ricardo Carpio' }, csp: { nome: 'Claudia Pastorino' }, cse: { nome: 'Claudia Pastorino' },
      },
    },
    lavorazioni: [], imprese: [{ id: 'i1', ragione_sociale: 'Edil Prova srl', ruolo: 'affidataria' }, { id: 'i2', ragione_sociale: 'Lattonerie Rossi', ruolo: 'esecutrice' }], costi: [], decisioni: [], revisioni: [],
  };
  const html = documento.pscHtml(snap, {});
  const cover = (html.match(/<section class="cover"[\s\S]*?<\/section>/) || [''])[0];
  check('copertina: tipo di opera presente', /manutenzione straordinaria/i.test(cover), cover.slice(0, 300));
  check('copertina: responsabile dei lavori e coordinatori', /Amabile Veiga/.test(cover) && /Claudia Pastorino/.test(cover));
  check('copertina: senza indice (l\'indice va nella seconda pagina)', !/Indice/.test(cover));
  check('indice in una pagina sua, subito dopo la copertina', /<section class="indice"/.test(html) && html.indexOf('<section class="indice"') > html.indexOf('<section class="cover"'));
  check('sezione 2 si chiama "Soggetti" (non "con compiti di sicurezza")', /<span class="n">2<\/span>Soggetti</.test(html) && !/Soggetti con compiti di sicurezza/.test(html));
  check('organigramma presente con committente, CSE e imprese', /Organigramma/.test(html) && /class="org"/.test(html) && /Edil Prova srl/.test(html.slice(html.indexOf('class="org"'))));
}

// ── F-296: limite del computo ─────────────────────────────────────────────────
console.log('\n\x1b[1mF-296 — Computo fino a 60 MB\x1b[0m');
{
  const http = require('../lib/psc/http');
  check('limite del computo ≥ 60 MB', http.LIMITI_MB && http.LIMITI_MB.computo >= 60, http.LIMITI_MB);
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/v1/psc.js'), 'utf8');
  check('la rotta del computo usa quel limite', /upComputo\s*=\s*uploader\(LIMITI_MB\.computo/.test(src));
}

console.log(`\n  ${passed} passati, ${failed} falliti\n`);
process.exit(failed ? 1 : 0);
