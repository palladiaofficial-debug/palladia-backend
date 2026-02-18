'use strict';

/**
 * sign-selector.js
 * Seleziona automaticamente i cartelli di sicurezza in base al POS.
 * Il cartello generale è SEMPRE incluso (obbligatorio per legge: D.lgs 81/2008).
 * Gli altri cartelli sono scelti dal codice in base alle lavorazioni — NON dall'AI.
 */

const path = require('path');

const BASE = path.join(__dirname, 'cartellonistica');

function img(folder, filename) {
  return { path: path.join(BASE, folder, filename), name: filename.replace('.jpg', ''), category: folder };
}
function imgRoot(filename) {
  return { path: path.join(BASE, filename), name: filename.replace('.jpg', ''), category: 'Generale' };
}

// ─── CATEGORIE COSTANTI ───────────────────────────────────────────────────────
const CAT_DIVIETO   = 'Cartelli di divieto fondo bianco contenuto rosso';
const CAT_OBBLIGO   = 'Cartelli fondo blu (obbligo)';
const CAT_PERICOLO  = 'Cartelli fondo giallo (pericolo)';
const CAT_VERDE     = 'Cartelli fondo verde';
const CAT_ANTINC    = 'Cartelli antincendio';

// ─── CARTELLI SEMPRE PRESENTI IN OGNI POS ────────────────────────────────────
const ALWAYS = [
  // ★ OBBLIGATORIO — senza questo il POS non ha valore legale
  imgRoot('Cartello generale.jpg'),

  // Pericolo cantiere — sempre
  img(CAT_PERICOLO, 'Pericolo cantiere (lavori in corso).jpg'),
  img(CAT_PERICOLO, 'Pericolo generale.jpg'),
  img(CAT_PERICOLO, 'Pericolo di inciampo.jpg'),

  // Divieto accesso — sempre
  img(CAT_DIVIETO, 'Divieto di accesso ai non addetti.jpg'),
  img(CAT_DIVIETO, "Vietato l'accesso al personale non autorizzato.jpg"),
  img(CAT_DIVIETO, 'Vietato fumare.jpg'),

  // Obbligo DPI base — sempre
  img(CAT_OBBLIGO, 'Obbligo casco di protezione.jpg'),
  img(CAT_OBBLIGO, 'Obbligo calzature di sicurezza.jpg'),
  img(CAT_OBBLIGO, 'Obbligo guanti di protezione.jpg'),
  img(CAT_OBBLIGO, 'Obbligo lavaggio mani.jpg'),

  // Emergenza — sempre
  img(CAT_VERDE,   'Pronto soccorso.jpg'),
  img(CAT_VERDE,   'Percorso di esodo.jpg'),
  img(CAT_VERDE,   'Punto di raccolta.jpg'),
  img(CAT_VERDE,   'Uscita di emergenza basso.jpg'),
  img(CAT_VERDE,   'Telefono di emergenza.jpg'),

  // Antincendio — sempre
  img(CAT_ANTINC,  'Estintore.jpg'),
  img(CAT_ANTINC,  'Allarme antincendio.jpg'),
  img(CAT_ANTINC,  'Pulsante di emergenza.jpg'),
];

// ─── REGOLE CONDIZIONALI: keyword → cartelli aggiuntivi ──────────────────────
const RULES = [
  {
    label: 'Lavori in quota / Ponteggi / Demolizioni / Coperture',
    keywords: ['quota', 'ponteggio', 'ponteg', 'demoliz', 'tetto', 'copertura',
               'impalcatura', 'solaio', 'facciata', 'cappotto', 'terrazza', 'lastrico',
               'sostituzione tetto', 'grondaia', 'abbaino'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo di caduta.jpg'),
      img(CAT_OBBLIGO,  'Obbligo imbracatura di sicurezza.jpg'),
      img(CAT_PERICOLO, 'Pericolo carichi sospesi.jpg'),
      img(CAT_DIVIETO,  'Divieto di passaggio ai pedoni.jpg'),
    ]
  },
  {
    label: 'Gru / Sollevamento carichi',
    keywords: ['gru', 'autogrù', 'autogru', 'sollevamento', 'argano', 'braccio gru'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo carichi sospesi.jpg'),
      img(CAT_PERICOLO, 'Pericolo macchine in movimento.jpg'),
      img(CAT_DIVIETO,  'Divieto di passaggio ai pedoni.jpg'),
    ]
  },
  {
    label: 'Scavi / Movimento terra / Macchine operatrici',
    keywords: ['scavo', 'scavi', 'ruspa', 'escavator', 'pale meccanic', 'movimento terra',
               'sbancamento', 'trivella', 'fondazion', 'platea', 'pali'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo macchine in movimento.jpg'),
      img(CAT_PERICOLO, 'Pericolo di caduta.jpg'),
      img(CAT_DIVIETO,  'Divieto di transito ai veicoli.jpg'),
      img(CAT_DIVIETO,  'Divieto di passaggio ai pedoni.jpg'),
    ]
  },
  {
    label: 'Impianti elettrici / Alta tensione',
    keywords: ['elettric', 'impianto elettr', 'quadro elettr', 'cabina elettr',
               'alta tensione', 'cablaggio', 'impianto bt', 'mt/bt', 'trasformator'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo alta tensione.jpg'),
      img(CAT_PERICOLO, 'Pericolo elettrico generale.jpg'),
      img(CAT_DIVIETO,  'Divieto di spegnere con acqua.jpg'),
    ]
  },
  {
    label: 'Saldatura / Taglio termico / Fiamme libere',
    keywords: ['saldatura', 'saldatr', 'taglio term', 'fiamma', 'cannello',
               'ossiacetilenica', 'plasma', 'elettrodo', 'mig', 'tig'],
    signs: [
      img(CAT_DIVIETO,  'Vietato fumare e usare fiamme libere.jpg'),
      img(CAT_OBBLIGO,  'Obbligo protezione facciale.jpg'),
      img(CAT_OBBLIGO,  'Obbligo occhiali di protezione.jpg'),
      img(CAT_PERICOLO, 'Pericolo materiale infiammabile.jpg'),
    ]
  },
  {
    label: 'Verniciatura / Impermeabilizzazione / Prodotti chimici',
    keywords: ['vernic', 'pittur', 'tinteggiat', 'solvente', 'resina', 'impermeabil',
               'rivestim', 'finitur', 'prodotto chim', 'sostanza chim', 'eposs'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo materiale infiammabile.jpg'),
      img(CAT_PERICOLO, 'Pericolo sostanze irritanti.jpg'),
      img(CAT_PERICOLO, 'Pericolo sostanze corrosive.jpg'),
      img(CAT_OBBLIGO,  'Obbligo protezione vie respiratorie.jpg'),
      img(CAT_OBBLIGO,  'Obbligo occhiali di protezione.jpg'),
      img(CAT_DIVIETO,  'Vietato fumare e usare fiamme libere.jpg'),
    ]
  },
  {
    label: 'Impianti idraulici / Gas / Fognature',
    keywords: ['idraul', 'fognatura', ' gas', 'tubazione', 'gasdotto',
               'acquedotto', 'scarico', 'adduzione', 'impianto gas'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo gas.jpg'),
      img(CAT_DIVIETO,  'Divieto di bere acqua non potabile.jpg'),
    ]
  },
  {
    label: 'Rumore / Vibrazioni / Martello demolitore',
    keywords: ['rumore', 'demolitore', 'vibraz', 'martello', 'fresatura', 'fresatrice',
               'compressore', 'smerigliatrice', 'disco', 'scalpello pneumatico'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo rumore.jpg'),
      img(CAT_OBBLIGO,  'Obbligo protezione udito.jpg'),
    ]
  },
  {
    label: 'Polveri / Sabbiatura / Levigatura / Amianto',
    keywords: ['polvere', 'polveroso', 'silice', 'amianto', 'fibre', 'levigatura',
               'carteggiatura', 'sabbiatura', 'taglio lateriz', 'disco abrasiv'],
    signs: [
      img(CAT_OBBLIGO, 'Obbligo protezione vie respiratorie.jpg'),
      img(CAT_OBBLIGO, 'Obbligo occhiali di protezione.jpg'),
      img(CAT_PERICOLO,'Pericolo sostanze irritanti.jpg'),
    ]
  },
  {
    label: 'Murature / Intonaci / Calcestruzzo / Massetti',
    keywords: ['muratura', 'intonaco', 'intonaci', 'calcestruzzo', 'cls',
               'getto', 'cemento', 'mattone', 'blocchi', 'pavimentazione', 'massetto'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo di scivolamento.jpg'),
    ]
  },
  {
    label: 'Trasporti / Mezzi di cantiere',
    keywords: ['trasporto', 'autocarro', 'autobetoniera', 'betoniera',
               'carrello elevatore', 'muletto', 'autocarr', 'dumper'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo macchine in movimento.jpg'),
      img(CAT_OBBLIGO,  'Obbligo passaggio pedoni.jpg'),
    ]
  },
  {
    label: 'Sostanze pericolose / Chimici / Acidi',
    keywords: ['sostanza pericolosa', 'chimico', 'acido', 'base', 'corrosivo',
               'disinfettante', 'sgrassante', 'diluente'],
    signs: [
      img(CAT_PERICOLO, 'Pericolo sostanze corrosive.jpg'),
      img(CAT_PERICOLO, 'Pericolo sostanze velenose.jpg'),
      img(CAT_VERDE,    'Lavaocchi di emergenza.jpg'),
      img(CAT_VERDE,    'Doccia di emergenza.jpg'),
    ]
  },
];

// ─── FUNZIONE PRINCIPALE ──────────────────────────────────────────────────────
/**
 * Seleziona i cartelli corretti per il POS dato.
 * @param {Object} posData
 * @returns {Array<{path: string, name: string, category: string}>}
 */
function selectSigns(posData) {
  const d = posData || {};

  // Testo di riferimento per il matching
  const worksText = [
    ...(d.selectedWorks || []),
    d.workType || '',
    d.siteAddress || ''
  ].join(' ').toLowerCase();

  // Mappa per deduplicare per path
  const selected = new Map();

  // Prima: tutti i cartelli fissi
  for (const s of ALWAYS) {
    selected.set(s.path, s);
  }

  // Poi: cartelli condizionali in base alle lavorazioni
  for (const rule of RULES) {
    const matches = rule.keywords.some(kw => worksText.includes(kw.toLowerCase()));
    if (matches) {
      for (const s of rule.signs) {
        selected.set(s.path, s);
      }
    }
  }

  return Array.from(selected.values());
}

module.exports = { selectSigns };
