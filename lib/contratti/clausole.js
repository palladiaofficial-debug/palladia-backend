'use strict';
/**
 * lib/contratti/clausole.js — F-398 (AUDIT.md del frontend): il contratto di
 * subappalto, le clausole e il loro testo.
 *
 * Il titolare sceglie con un tocco (una scelta per clausola, la consigliata già
 * accesa); il testo legale lo scrive SOLO questo file, mai un modello: in un
 * documento da firmare nessuna parola va reinventata ogni volta (stessa regola
 * del generatore di luglio, routes/v1/chat.js buildContractHtml). Tutto puro,
 * provato da scripts/selftest_contratti.js.
 *
 * Cosa c'è sempre (non si toglie): oggetto e autonomia organizzativa,
 * corrispettivo con i costi della sicurezza (art. 26 c.5 D.Lgs. 81/2008, a pena
 * di nullità), tempi, sicurezza, regolarità contributiva e CCNL edile,
 * garanzia, risoluzione, comunicazioni, privacy, foro, allegati.
 */

const CLAUSOLE = [
  { id: 'pagamento', gruppo: 'Soldi', titolo: 'Quando paghi', consigliata: '30fm', opzioni: [
    { key: '30fm', label: '30 giorni fine mese' },
    { key: '60fm', label: '60 giorni fine mese' },
    { key: 'sal', label: 'A stati di avanzamento mensili' },
    { key: 'fine', label: 'Tutto alla fine dei lavori' },
  ] },
  { id: 'iva', gruppo: 'Soldi', titolo: 'IVA', consigliata: 'reverse', opzioni: [
    { key: 'reverse', label: 'Reverse charge', sotto: 'Il caso normale tra imprese edili' },
    { key: 'ordinaria', label: 'IVA ordinaria' },
  ] },
  { id: 'ritenuta', gruppo: 'Soldi', titolo: 'Ritenuta a garanzia', frase: 'Trattieni una parte di ogni pagamento fino alla fine dei lavori', consigliata: '5', opzioni: [
    { key: 'no', label: 'No' }, { key: '5', label: '5%' }, { key: '10', label: '10%' },
  ] },
  { id: 'penale', gruppo: 'Tempi', titolo: 'Penale per il ritardo', consigliata: '1', opzioni: [
    { key: 'no', label: 'No' },
    { key: '03', label: '0,3‰ al giorno', sotto: 'Leggera' },
    { key: '1', label: '1‰ al giorno', sotto: 'Massimo 10%' },
  ] },
  { id: 'recesso', gruppo: 'Tempi', titolo: 'Puoi fermare il lavoro quando vuoi', frase: 'Recesso ai sensi dell\'art. 1671 c.c.', consigliata: 'si', opzioni: [
    { key: 'si', label: 'Sì' }, { key: 'no', label: 'No' },
  ] },
  { id: 'solidale', gruppo: 'Tutele', titolo: 'Ogni mese ti mostra F24 e buste paga', frase: 'Rispondi anche tu di stipendi e contributi dei suoi operai (art. 29 D.Lgs. 276/2003): così lo controlli', consigliata: 'si', opzioni: [
    { key: 'si', label: 'Sì' }, { key: 'no', label: 'No' },
  ] },
  { id: 'subsub', gruppo: 'Tutele', titolo: 'Non può dare il lavoro ad altri', frase: 'Senza il tuo consenso scritto', consigliata: 'si', opzioni: [
    { key: 'si', label: 'Sì' }, { key: 'no', label: 'No' },
  ] },
  { id: 'polizza', gruppo: 'Tutele', titolo: 'Assicurazione RC', frase: 'Massimale minimo della sua polizza', consigliata: '2m', opzioni: [
    { key: 'no', label: 'Non la chiedo' },
    { key: '1m', label: '1 milione' }, { key: '2m', label: '2 milioni' }, { key: '5m', label: '5 milioni' },
  ] },
  { id: 'materiali', gruppo: 'Cantiere', titolo: 'Materiali', consigliata: 'sub', opzioni: [
    { key: 'sub', label: 'Li mette lui' }, { key: 'affidataria', label: 'Li metto io' },
  ] },
  { id: 'rifiuti', gruppo: 'Cantiere', titolo: 'Pulizia e rifiuti', consigliata: 'sub', opzioni: [
    { key: 'sub', label: 'A carico suo' }, { key: 'affidataria', label: 'Nei miei cassoni' },
  ] },
  { id: 'pubblico', gruppo: 'Cantiere', titolo: 'Il committente è un ente pubblico', frase: 'Aggiunge art. 119 D.Lgs. 36/2023 e tracciabilità dei pagamenti', consigliata: 'no', opzioni: [
    { key: 'no', label: 'No, privato' }, { key: 'si', label: 'Sì, lavoro pubblico' },
  ] },
  { id: 'foro', gruppo: 'Cantiere', titolo: 'Tribunale in caso di lite', consigliata: 'citta', opzioni: [
    { key: 'citta', label: 'Quello della tua città' }, { key: 'legge', label: 'Quello di legge' },
  ] },
];

const SEMPRE = [
  'Oggetto, con i suoi mezzi e la sua organizzazione',
  'Costi della sicurezza (obbligatori, art. 26 D.Lgs. 81/2008)',
  'POS, formazione, tesserino, elenco degli operai',
  'DURC e contratto edile applicato',
  'Garanzia sui lavori (artt. 1667-1669 c.c.)',
  'Risoluzione, comunicazioni, privacy, allegati',
];

const MASSIMALI = { '1m': 1000000, '2m': 2000000, '5m': 5000000 };
const QUOTA_RE = /tett|copertur|ponteg|facciat|quota|lattoner|grond|cappotto|camin|lucernar/i;

/** Le scelte complete: ogni clausola ha una scelta valida (quelle mancanti o sbagliate prendono la consigliata). */
function scelteComplete(s = {}) {
  const out = {};
  for (const c of CLAUSOLE) out[c.id] = c.opzioni.some(o => o.key === s[c.id]) ? s[c.id] : c.consigliata;
  return out;
}

// ── Formati ──────────────────────────────────────────────────────────────────
// useGrouping 'always': in italiano senza il punto delle migliaia sotto 10.000 («2320,00»)
const euro = (n) => `€ ${Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' })}`;
const giorno = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const VUOTO = '____________';

/** Partita IVA italiana: 11 cifre e la cifra di controllo giusta. */
function pivaValida(p) {
  const s = String(p || '').replace(/^IT/i, '').replace(/\s/g, '');
  if (!/^\d{11}$/.test(s)) return false;
  let t = 0;
  for (let i = 0; i < 10; i++) {
    let d = Number(s[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    t += d;
  }
  return (10 - (t % 10)) % 10 === Number(s[10]);
}
const pivaPulita = (p) => String(p || '').replace(/^IT/i, '').replace(/\s/g, '');

/** Il totale delle voci (prezzo × quantità), ricalcolato sempre qui. */
function totaleVoci(voci = []) {
  return Math.round(voci.reduce((t, v) => t + Number(v.quantita) * Number(v.prezzo), 0) * 100) / 100;
}
function importoContratto(prezzo) {
  if (prezzo?.modo === 'corpo') return Number(prezzo.importo) || null;
  if (prezzo?.modo === 'misura') return totaleVoci(prezzo.voci) || null;
  return null;
}

/**
 * Gli articoli, numerati, dal contratto e dalle scelte. Ogni articolo:
 * { titolo, testo: [paragrafi], tabella?: { voci, totale } | { vuota: n } }.
 */
function articoli(d, scelteIn) {
  const s = scelteComplete(scelteIn);
  const A = d.affidataria, S = d.subappaltatrice, L = d.lavoro, P = d.prezzo || { modo: 'tabella' };
  const importo = importoContratto(P);
  const quota = QUOTA_RE.test(L.descrizione || '');
  const out = [];
  const art = (titolo, testo, extra = {}) => out.push({ titolo, testo: testo.filter(Boolean), ...extra });

  art('Oggetto', [
    `L'Impresa Affidataria affida alla Subappaltatrice, che accetta, l'esecuzione delle seguenti lavorazioni: ${L.descrizione}, presso il cantiere sito in ${L.cantiere}${L.committente ? `, per conto del Committente ${L.committente}` : ''}.`,
    `La Subappaltatrice esegue i lavori con organizzazione dei mezzi necessari e gestione a proprio rischio, con proprio personale da essa diretto e retribuito, a regola d'arte e secondo le indicazioni della Direzione Lavori. ${s.materiali === 'sub' ? 'Materiali, attrezzature e mezzi d\'opera sono forniti dalla Subappaltatrice e compresi nel corrispettivo.' : 'I materiali sono forniti dall\'Impresa Affidataria; attrezzature e mezzi d\'opera sono della Subappaltatrice.'}`,
    s.pubblico === 'si'
      ? `Il presente subappalto è stipulato ai sensi dell'art. 119 del D.Lgs. 36/2023, previa autorizzazione della Stazione Appaltante${L.cig ? ` (CIG ${L.cig}${L.cup ? `, CUP ${L.cup}` : ''})` : ''}.`
      : 'L\'Impresa Affidataria dichiara di aver ottenuto, ove necessaria, l\'autorizzazione del Committente al subappalto ai sensi dell\'art. 1656 c.c.',
  ]);

  const iva = s.iva === 'reverse'
    ? 'Le fatture sono emesse in regime di inversione contabile (reverse charge) ai sensi dell\'art. 17, comma 6, lettera a), del D.P.R. 633/1972, ove ne ricorrano i presupposti.'
    : 'Gli importi si intendono oltre IVA di legge.';
  const sicurezza = `I costi della sicurezza relativi ai rischi da interferenze, non soggetti a ribasso, sono pari a ${L.costiSicurezza != null && L.costiSicurezza !== '' ? euro(L.costiSicurezza) : `€ ${VUOTO}`} (art. 26, comma 5, D.Lgs. 81/2008).`;
  if (P.modo === 'corpo') {
    art('Corrispettivo', [
      `Il corrispettivo è fissato a corpo in ${euro(importo)}, fisso e invariabile, comprensivo di ogni onere per dare le opere finite a regola d'arte.`, sicurezza, iva,
    ]);
  } else if (P.modo === 'misura') {
    art('Corrispettivo', [
      `Il corrispettivo è determinato a misura, applicando i prezzi unitari seguenti alle quantità effettivamente eseguite e contabilizzate in contraddittorio. L'importo presunto è di ${euro(importo)}.`, sicurezza, iva,
    ], { tabella: { voci: P.voci.map(v => ({ ...v, importo: Math.round(Number(v.quantita) * Number(v.prezzo) * 100) / 100 })), totale: importo } });
  } else {
    art('Corrispettivo', [
      'Il corrispettivo è determinato applicando i prezzi unitari indicati nella tabella seguente, compilata e sottoscritta dalle Parti, alle quantità effettivamente eseguite e contabilizzate in contraddittorio.', sicurezza, iva,
    ], { tabella: { vuota: 8 } });
  }

  const pagamento = {
    '30fm': 'Il pagamento avviene a 30 giorni data fattura fine mese.',
    '60fm': 'Il pagamento avviene a 60 giorni data fattura fine mese.',
    sal: 'I pagamenti avvengono sulla base di stati di avanzamento lavori mensili redatti in contraddittorio; ciascuna fattura è pagata a 30 giorni data fattura fine mese.',
    fine: 'Il pagamento avviene in un\'unica soluzione al termine dei lavori, previa verifica in contraddittorio della loro regolare esecuzione, a 30 giorni data fattura fine mese.',
  }[s.pagamento];
  art('Pagamenti', [
    `${pagamento} Ogni pagamento è subordinato alla verifica della regolarità contributiva della Subappaltatrice${s.solidale === 'si' ? ' e alla consegna dei documenti di cui all\'articolo «Regolarità contributiva e retributiva»' : ''}.`,
    s.ritenuta !== 'no' ? `Su ciascun pagamento è operata una ritenuta a garanzia del ${s.ritenuta}%, svincolata entro 60 giorni dal termine dei lavori, previa verifica dell'assenza di vizi e della regolarità contributiva.` : null,
    s.pubblico === 'si' ? 'Le Parti assumono gli obblighi di tracciabilità dei flussi finanziari di cui alla L. 136/2010: i pagamenti avvengono esclusivamente su conto corrente dedicato, con l\'indicazione del CIG e, ove presente, del CUP.' : null,
  ]);

  const inizio = L.inizio ? `in data ${giorno(L.inizio)}` : `in data ${VUOTO}`;
  const fine = L.fine ? `entro il ${giorno(L.fine)}` : L.durataGiorni ? `entro ${L.durataGiorni} giorni naturali e consecutivi dall'inizio` : `entro il ${VUOTO}`;
  art('Tempi', [
    `I lavori hanno inizio ${inizio} e devono essere ultimati ${fine}, salvo cause di forza maggiore documentate o sospensioni disposte per iscritto dall'Impresa Affidataria.`,
    s.penale !== 'no' ? `Per ogni giorno naturale di ritardo non imputabile all'Impresa Affidataria si applica una penale pari al ${s.penale === '03' ? '0,3' : '1'} per mille dell'importo contrattuale${importo ? ` (${euro(importo * (s.penale === '03' ? 0.0003 : 0.001))} al giorno)` : ''}, fino a un massimo del 10% dello stesso importo, salvo il risarcimento del maggior danno.` : null,
  ]);

  art('Sicurezza', [
    'La Subappaltatrice rispetta il D.Lgs. 81/2008 e consegna all\'Impresa Affidataria, prima dell\'inizio dei lavori, il proprio Piano Operativo di Sicurezza (POS); non può iniziare i lavori prima della verifica della sua congruenza. Si attiene al Piano di Sicurezza e Coordinamento, ove previsto, e alle disposizioni del Coordinatore per l\'esecuzione.',
    'Comunica prima dell\'ingresso l\'elenco nominativo dei lavoratori impiegati; ogni lavoratore è formato, idoneo alla mansione, dotato dei DPI necessari ed espone la tessera di riconoscimento (artt. 18 e 26, comma 8, D.Lgs. 81/2008). Il personale non in regola può essere allontanato dal cantiere.',
    quota ? 'Trattandosi di lavorazioni con rischio di caduta dall\'alto, la Subappaltatrice opera solo da opere provvisionali conformi, nel rispetto del PiMUS e previo verbale di consegna del ponteggio, con lavoratori formati per i lavori in quota.' : null,
  ]);

  art('Regolarità contributiva e retributiva', [
    'La Subappaltatrice applica ai propri dipendenti il CCNL dell\'edilizia e gli accordi territoriali, li iscrive alla Cassa Edile competente e mantiene la regolarità contributiva (DURC) per tutta la durata dei lavori; collabora alla verifica di congruità dell\'incidenza della manodopera (D.M. 143/2021).',
    s.solidale === 'si' ? 'Considerata la responsabilità solidale dell\'Impresa Affidataria per retribuzioni e contributi (art. 29, comma 2, D.Lgs. 276/2003), la Subappaltatrice consegna ogni mese copia delle buste paga e dei modelli F24 quietanzati relativi ai lavoratori impiegati nel cantiere; in mancanza i pagamenti sono sospesi fino alla consegna.' : null,
    s.subsub === 'si' ? 'È vietato alla Subappaltatrice affidare a terzi, in tutto o in parte, le lavorazioni del presente contratto senza il preventivo consenso scritto dell\'Impresa Affidataria.' : null,
  ]);

  art('Garanzia e responsabilità', [
    'La Subappaltatrice garantisce le opere eseguite e risponde dei vizi e delle difformità ai sensi degli artt. 1667, 1668 e 1669 c.c.; tiene indenne l\'Impresa Affidataria da ogni pretesa di terzi derivante dall\'esecuzione dei lavori.',
    s.polizza !== 'no' ? `La Subappaltatrice è titolare di polizza di responsabilità civile verso terzi e verso prestatori di lavoro (RCT/RCO) con massimale non inferiore a ${euro(MASSIMALI[s.polizza])} per sinistro, valida per tutta la durata dei lavori, e ne consegna copia prima del loro inizio.` : null,
    s.rifiuti === 'sub'
      ? 'Provvede a proprie spese alla pulizia quotidiana delle aree di lavoro e allo smaltimento dei rifiuti prodotti dalle proprie lavorazioni, nel rispetto del D.Lgs. 152/2006.'
      : 'Mantiene pulite le aree di lavoro e conferisce i rifiuti prodotti negli appositi contenitori messi a disposizione dall\'Impresa Affidataria, separati per tipologia.',
  ]);

  const casi = [
    'DURC irregolare non sanato entro 15 giorni dalla contestazione',
    'gravi o ripetute violazioni degli obblighi di sicurezza',
    s.solidale === 'si' ? 'mancata consegna delle buste paga e dei modelli F24 per due mesi' : null,
    s.subsub === 'si' ? 'affidamento a terzi delle lavorazioni senza consenso' : null,
    s.penale !== 'no' ? 'raggiungimento del massimo delle penali' : null,
  ].filter(Boolean);
  art('Risoluzione e recesso', [
    `L'Impresa Affidataria può risolvere di diritto il contratto ai sensi dell'art. 1456 c.c., con comunicazione scritta, in caso di: ${casi.join('; ')}.`,
    s.recesso === 'si' ? 'L\'Impresa Affidataria può recedere dal contratto in qualsiasi momento ai sensi dell\'art. 1671 c.c.' : null,
  ]);

  const pec = [A.pec ? `${A.ragioneSociale}: ${A.pec}` : null, S.pec ? `${S.ragioneSociale}: ${S.pec}` : null].filter(Boolean);
  art('Comunicazioni e dati personali', [
    `Le comunicazioni tra le Parti avvengono per iscritto${pec.length ? `, anche a mezzo PEC agli indirizzi ${pec.join('; ')}` : ''}.`,
    'Le Parti trattano i dati personali scambiati per l\'esecuzione del contratto nel rispetto del Regolamento (UE) 2016/679.',
  ]);

  art('Foro competente', [
    s.foro === 'citta' && A.citta
      ? `Per ogni controversia è competente in via esclusiva il Foro di ${A.citta}. Si applica la legge italiana.`
      : 'Per ogni controversia è competente il foro individuato secondo la legge. Si applica la legge italiana.',
  ]);

  art('Allegati', [
    `Sono parte del contratto: POS della Subappaltatrice; DURC in corso di validità; visura camerale; elenco nominativo dei lavoratori${s.polizza !== 'no' ? '; copia della polizza RCT/RCO' : ''}${P.modo !== 'corpo' ? '; elenco prezzi sottoscritto' : ''}.`,
  ]);

  return out.map((a, i) => ({ n: i + 1, ...a }));
}

/**
 * Cosa dire al titolare prima di firmare: avvisi (da sistemare) e consigli.
 * ctx = { durcScadenza, visuraData, oggi }
 */
function suggerimenti(d, scelteIn, ctx = {}) {
  const s = scelteComplete(scelteIn);
  const oggi = ctx.oggi || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const out = [];
  const nome = d.subappaltatrice?.ragioneSociale || 'L\'impresa';
  if (!ctx.durcScadenza) out.push({ tipo: 'avviso', testo: `Non ho il DURC di ${nome}: fattelo mandare prima che inizi.` });
  else if (ctx.durcScadenza < oggi) out.push({ tipo: 'avviso', testo: `Il DURC di ${nome} è scaduto: fattelo rifare prima che inizi.` });
  if (ctx.visuraData) {
    const m = new Date(`${ctx.visuraData}T12:00:00Z`); m.setUTCMonth(m.getUTCMonth() + 6);
    if (m.toISOString().slice(0, 10) < oggi) out.push({ tipo: 'avviso', testo: 'La visura ha più di 6 mesi: i dati potrebbero essere cambiati.' });
  }
  if (QUOTA_RE.test(d.lavoro?.descrizione || '')) out.push({ tipo: 'consiglio', testo: 'Lavori in alto: ho aggiunto ponteggio, PiMUS e formazione per i lavori in quota.' });
  if (d.lavoro?.costiSicurezza == null || d.lavoro.costiSicurezza === '') out.push({ tipo: 'consiglio', testo: 'I costi della sicurezza vanno scritti, anche a mano: senza, il contratto può essere nullo.' });
  const imp = importoContratto(d.prezzo);
  if (imp && imp >= 50000 && s.ritenuta === 'no') out.push({ tipo: 'consiglio', testo: 'Per questo importo conviene una ritenuta a garanzia del 5%.' });
  if (s.polizza === 'no') out.push({ tipo: 'consiglio', testo: 'Senza assicurazione RC, un danno fatto da loro può ricadere su di te.' });
  return out;
}

module.exports = { CLAUSOLE, SEMPRE, scelteComplete, articoli, suggerimenti, pivaValida, pivaPulita, totaleVoci, importoContratto, euro, giorno };
