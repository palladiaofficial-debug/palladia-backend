'use strict';
/**
 * lib/psc/interferenze.js — F-270. Interferenze tra lavorazioni dal
 * cronoprogramma: due lavorazioni si sovrappongono nel tempo, nella stessa
 * area (o in un'area non indicata) e sono di imprese diverse (o non ancora
 * assegnate). Per ognuna propone tre soluzioni (sfasamento temporale,
 * sfasamento spaziale, misure di coordinamento) con il testo già scritto.
 *
 * Funzioni pure: nessun I/O. Le date sono stringhe 'AAAA-MM-GG'.
 */
const { getScheda } = require('../lavorazioniSchede');

const DAY = 86400000;
const toMs = (d) => Date.parse(`${d}T12:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmt = (d) => new Date(toMs(d)).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function nextWorkday(iso) {
  let ms = toMs(iso) + DAY;
  for (;;) { const wd = new Date(ms).getUTCDay(); if (wd !== 0 && wd !== 6) return toIso(ms); ms += DAY; }
}

const normArea = (a) => String(a || '').trim().toLowerCase();
const GENERIC_AREA = /^(|tutto|tutto il cantiere|intero cantiere|cantiere|generale)$/;

function areasCompatible(a, b) {
  const x = normArea(a), y = normArea(b);
  if (GENERIC_AREA.test(x) || GENERIC_AREA.test(y)) return true;
  return x === y || x.includes(y) || y.includes(x);
}

function categoria(lav) {
  const s = lav.scheda_id ? getScheda(lav.scheda_id) : null;
  return s ? s.categoria : null;
}

const PRIORITA = ['quota', 'sollevamenti', 'demolizioni', 'scavi', 'caldo_chimico', 'elettrico'];

/** Il rischio principale dell'interferenza e chi lo genera. */
function rischioDi(a, b) {
  const ca = categoria(a), cb = categoria(b);
  for (const cat of PRIORITA) {
    const gen = ca === cat ? a : cb === cat ? b : null;
    if (!gen) continue;
    const other = gen === a ? b : a;
    const testi = {
      quota: `caduta di materiale dall'alto su chi lavora sotto o vicino a "${gen.nome}"`,
      sollevamenti: `carichi sospesi sopra le aree di lavoro di "${other.nome}"`,
      demolizioni: `polveri, caduta di materiale e crolli parziali vicino a "${other.nome}"`,
      scavi: `caduta nello scavo e investimento da parte dei mezzi di "${gen.nome}"`,
      caldo_chimico: `incendio e inalazione di fumi o vapori prodotti da "${gen.nome}"`,
      elettrico: `contatto con parti in tensione durante "${gen.nome}"`,
    };
    return { tipo: cat, generatore: gen.id, testo: testi[cat] };
  }
  return { tipo: 'generico', generatore: null, testo: 'lavorazioni contemporanee nello stesso spazio: urti, inciampi, ingombri e materiali in comune' };
}

function overlap(a, b) {
  if (!a.start_date || !a.end_date || !b.start_date || !b.end_date) return null;
  const from = a.start_date > b.start_date ? a.start_date : b.start_date;
  const to = a.end_date < b.end_date ? a.end_date : b.end_date;
  return from <= to ? { from, to } : null;
}

const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * @param {Array} lavorazioni
 * @param {Array} decisioni righe di psc_interferenze
 * @returns {{aperte: Array, risolte: Array}}
 */
function detect(lavorazioni, decisioni = []) {
  const dec = new Map(decisioni.map(d => [pairKey(d.lav_a, d.lav_b), d]));
  const aperte = [], risolte = [];
  const list = lavorazioni.filter(l => l.start_date && l.end_date);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.impresa_id && b.impresa_id && a.impresa_id === b.impresa_id) continue;
      // F-289: due righe della stessa lavorazione (stessa scheda) non interferiscono
      // tra loro se nessuna impresa le distingue: è un doppione, non due squadre.
      if (a.scheda_id && a.scheda_id === b.scheda_id && (a.impresa_id || null) === (b.impresa_id || null)) continue;
      if (!areasCompatible(a.area, b.area)) continue;
      const ov = overlap(a, b);
      const d = dec.get(pairKey(a.id, b.id));
      if (!ov) { if (d) risolte.push({ ...d, ancora_sovrapposte: false }); continue; }
      const rischio = rischioDi(a, b);
      const item = {
        key: pairKey(a.id, b.id), lav_a: a.id, lav_b: b.id, nome_a: a.nome, nome_b: b.nome,
        dal: ov.from, al: ov.to, area: a.area || b.area || null,
        gravita: rischio.tipo === 'generico' ? 'media' : 'alta', rischio: rischio.testo, tipo: rischio.tipo,
      };
      // Una decisione "temporale" vale solo finché le date non tornano a sovrapporsi.
      if (d && d.soluzione !== 'temporale') { risolte.push({ ...d, ...item, ancora_sovrapposte: true }); continue; }
      aperte.push(item);
    }
  }
  aperte.sort((x, y) => (x.gravita === y.gravita ? x.dal.localeCompare(y.dal) : x.gravita === 'alta' ? -1 : 1));
  return { aperte, risolte };
}

const MISURE_PER_TIPO = {
  quota: (gen, other, impGen) => `Durante la sovrapposizione la zona sotto "${gen.nome}" è interdetta con transenne e cartelli; ${/ponteg/i.test(gen.nome) ? 'sul ponteggio è installata la mantovana parasassi; ' : ''}"${other.nome}" lavora fuori dalla proiezione della zona in quota. Il preposto${impGen ? ` di ${impGen}` : ''} è presente e coordina gli accessi.`,
  sollevamenti: (gen, other, impGen) => `Le movimentazioni dei carichi avvengono con l'area di manovra interdetta e un segnalatore a terra${impGen ? ` di ${impGen}` : ''}; "${other.nome}" sospende il lavoro nell'area sotto il carico per la durata della manovra.`,
  demolizioni: (gen, other) => `"${gen.nome}" si svolge in area delimitata e bagnata per limitare le polveri; "${other.nome}" non accede all'area delimitata fino al termine giornaliero delle demolizioni.`,
  scavi: (gen, other) => `I bordi dello scavo sono delimitati con parapetti o transenne; i mezzi di "${gen.nome}" manovrano con l'assistenza di un operatore a terra e "${other.nome}" resta fuori dal raggio d'azione dei mezzi.`,
  caldo_chimico: (gen, other) => `"${gen.nome}" si svolge con estintore a portata di mano e area ventilata; "${other.nome}" non lavora nello stesso locale durante l'uso di fiamme o prodotti volatili.`,
  elettrico: (gen, other) => `Le parti dell'impianto su cui si lavora sono sezionate e segnalate; "${other.nome}" non usa prese o quadri in modifica durante "${gen.nome}".`,
  generico: () => `Le due lavorazioni si svolgono in zone dell'area separate e segnalate; i preposti delle imprese si accordano ogni mattina sugli spazi e sui materiali in comune.`,
};

/**
 * Le tre soluzioni per un'interferenza, con il testo per il PSC.
 * @param {object} inter elemento di detect().aperte
 * @param {Map} lavById
 * @param {Map} impreseById
 * @param {string|null} fineLavori
 */
function soluzioni(inter, lavById, impreseById, fineLavori) {
  const a = lavById.get(inter.lav_a), b = lavById.get(inter.lav_b);
  // Si sposta quella che inizia dopo (a parità, quella meno pericolosa).
  let first = a, second = b;
  if (b.start_date < a.start_date || (b.start_date === a.start_date && categoria(b) && PRIORITA.includes(categoria(b)) && !PRIORITA.includes(categoria(a)))) { first = b; second = a; }
  const durata = Math.round((toMs(second.end_date) - toMs(second.start_date)) / DAY);
  const nuovoInizio = nextWorkday(first.end_date);
  const nuovaFine = toIso(toMs(nuovoInizio) + durata * DAY);
  const sforaFine = fineLavori ? nuovaFine > fineLavori : false;

  const rischio = rischioDi(a, b);
  const gen = rischio.generatore ? lavById.get(rischio.generatore) : first;
  const other = gen === a ? b : a;
  const impGen = gen.impresa_id && impreseById.get(gen.impresa_id) ? impreseById.get(gen.impresa_id).ragione_sociale : null;

  const temporale = {
    soluzione: 'temporale',
    titolo: 'Sfasamento temporale',
    testo: `"${second.nome}" inizia il ${fmt(nuovoInizio)}, a "${first.nome}" conclusa, e termina il ${fmt(nuovaFine)}.`,
    effetto: sforaFine ? `La fine lavori si sposta al ${fmt(nuovaFine)}.` : 'La fine lavori non si sposta.',
    sposta: { lavorazione_id: second.id, start_date: nuovoInizio, end_date: nuovaFine },
    sfora_fine: sforaFine,
  };
  const spaziale = {
    soluzione: 'spaziale',
    titolo: 'Sfasamento spaziale',
    testo: `Finché "${first.nome}" è in corso, "${second.nome}" lavora in zone diverse dell'area${inter.area ? ` (${inter.area})` : ''}, separate e segnalate; entra nella zona di "${first.nome}" solo a lavorazione conclusa.`,
    effetto: 'Le date non cambiano.',
  };
  const fn = MISURE_PER_TIPO[rischio.tipo] || MISURE_PER_TIPO.generico;
  const misure = {
    soluzione: 'misure',
    titolo: 'Misure di coordinamento',
    testo: fn(gen, other, impGen),
    effetto: 'Le date non cambiano. Le misure entrano nei costi della sicurezza.',
  };
  const consigliata = !sforaFine ? 'temporale' : rischio.tipo === 'generico' ? 'spaziale' : 'misure';
  return { opzioni: [temporale, spaziale, misure], consigliata, rischio: rischio.testo };
}

module.exports = { detect, soluzioni, areasCompatible, overlap, nextWorkday, pairKey, rischioDi };
