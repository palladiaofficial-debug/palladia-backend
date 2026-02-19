'use strict';

/**
 * sign-selector.js
 * Seleziona i cartelli di sicurezza corretti per il POS in base alle lavorazioni.
 * Ogni cartello ha: path, nome, zona di appartenenza, ubicazione raccomandata, riferimento normativo.
 * La selezione è automatica — NON delegata all'AI.
 */

const path = require('path');

const BASE = path.join(__dirname, 'cartellonistica');

// Zone di raggruppamento (come in un piano segnaletica professionale)
const Z_INGRESSO   = 'INGRESSO E PERIMETRO';
const Z_DPI        = 'OBBLIGHI E DPI';
const Z_LAVORO     = 'ZONE DI LAVORAZIONE SPECIFICA';
const Z_EMERGENZA  = 'EMERGENZA E PRIMO SOCCORSO';
const Z_ANTINC     = 'ANTINCENDIO';

const CAT_DIV   = 'Cartelli di divieto fondo bianco contenuto rosso';
const CAT_OBB   = 'Cartelli fondo blu (obbligo)';
const CAT_PER   = 'Cartelli fondo giallo (pericolo)';
const CAT_VER   = 'Cartelli fondo verde';
const CAT_ANT   = 'Cartelli antincendio';

function s(folder, filename, zone, location, norm) {
  return {
    path:     path.join(BASE, folder, filename),
    name:     filename.replace('.jpg', ''),
    category: folder,
    zone,
    location,
    norm
  };
}
function sRoot(filename, zone, location, norm) {
  return {
    path:     path.join(BASE, filename),
    name:     filename.replace('.jpg', ''),
    category: 'Generale',
    zone,
    location,
    norm
  };
}

// ─── CARTELLI SEMPRE PRESENTI IN OGNI POS ─────────────────────────────────────
const ALWAYS = [

  // ★ CARTELLO GENERALE — OBBLIGATORIO PRIMA DI QUALSIASI LAVORAZIONE
  sRoot('Cartello generale.jpg',
    Z_INGRESSO,
    "Ingresso principale del cantiere — posizione ben visibile dall'esterno, h min. 2 m da terra",
    'D.lgs 81/2008 Art. 163 — All. XXIV'
  ),

  // INGRESSO E PERIMETRO
  s(CAT_PER,  'Pericolo cantiere (lavori in corso).jpg',
    Z_INGRESSO,
    'Recinzione perimetrale e su tutti gli accessi al cantiere',
    'ISO 7010 W001 — D.lgs 81/08 Art. 161'
  ),
  s(CAT_PER, 'Pericolo generale.jpg',
    Z_INGRESSO,
    'Zone a rischio specifico non coperte da altri cartelli — viabilità interna',
    'ISO 7010 W001 — D.lgs 81/08 Art. 163'
  ),
  s(CAT_PER, 'Pericolo di inciampo.jpg',
    Z_INGRESSO,
    'Percorsi pedonali, depositi materiali, aree con dislivelli o ostacoli a terra',
    'ISO 7010 W007 — D.lgs 81/08 Art. 163'
  ),
  s(CAT_DIV, 'Divieto di accesso ai non addetti.jpg',
    Z_INGRESSO,
    'Accesso principale e tutti i varchi perimetrali del cantiere',
    'ISO 7010 P006 — D.lgs 81/08 Art. 163'
  ),
  s(CAT_DIV, "Vietato l'accesso al personale non autorizzato.jpg",
    Z_INGRESSO,
    'Accessi secondari, cancelli di servizio, zone di deposito materiali pericolosi',
    'ISO 7010 P006 — D.lgs 81/08 Art. 163'
  ),
  s(CAT_DIV, 'Vietato fumare.jpg',
    Z_INGRESSO,
    'Depositi materiali, baraccamenti, aree chiuse, zone con materiali combustibili',
    'ISO 7010 P002 — Legge 3/2003 Art. 51'
  ),

  // DPI BASE — obbligatori in tutto il cantiere
  s(CAT_OBB, 'Obbligo casco di protezione.jpg',
    Z_DPI,
    'Tutto il cantiere — obbligo per tutti gli operatori presenti',
    'ISO 7010 M002 — UNI EN 397:2012 — D.lgs 81/08 Art. 75'
  ),
  s(CAT_OBB, 'Obbligo calzature di sicurezza.jpg',
    Z_DPI,
    'Tutto il cantiere — obbligo per tutti gli operatori presenti',
    'ISO 7010 M008 — UNI EN ISO 20345:2022 — D.lgs 81/08 Art. 75'
  ),
  s(CAT_OBB, 'Obbligo guanti di protezione.jpg',
    Z_DPI,
    'Zone di manipolazione materiali, attrezzature, strutture metalliche',
    'ISO 7010 M009 — UNI EN 388:2016 — D.lgs 81/08 Art. 75'
  ),
  s(CAT_OBB, 'Obbligo lavaggio mani.jpg',
    Z_DPI,
    'Servizi igienici, mensa, uscita dal cantiere, dopo manipolazione sostanze',
    'ISO 7010 M011 — D.lgs 81/08 Art. 163'
  ),

  // EMERGENZA E PRIMO SOCCORSO
  s(CAT_VER, 'Pronto soccorso.jpg',
    Z_EMERGENZA,
    'Presso la cassetta/armadietto di primo soccorso — D.M. 388/2003',
    'ISO 7010 E003 — D.M. 388/2003 — D.lgs 81/08 Art. 45'
  ),
  s(CAT_VER, 'Percorso di esodo.jpg',
    Z_EMERGENZA,
    'Lungo tutte le vie di fuga, in corrispondenza di ogni cambio di direzione',
    'ISO 7010 E001 — D.lgs 81/08 Art. 163'
  ),
  s(CAT_VER, 'Punto di raccolta.jpg',
    Z_EMERGENZA,
    'Area esterna al cantiere, facilmente raggiungibile da tutti i lavoratori',
    'ISO 7010 E007 — D.lgs 81/08 Art. 43'
  ),
  s(CAT_VER, 'Uscita di emergenza basso.jpg',
    Z_EMERGENZA,
    'Uscite di emergenza, vie di fuga principali e secondarie',
    'ISO 7010 E001 — D.lgs 81/08 All. IV punto 1.9'
  ),
  s(CAT_VER, 'Telefono di emergenza.jpg',
    Z_EMERGENZA,
    'Zona baraccamenti, vicino alla cassetta di primo soccorso',
    'ISO 7010 E004 — D.lgs 81/08 Art. 43'
  ),

  // ANTINCENDIO
  s(CAT_ANT, 'Estintore.jpg',
    Z_ANTINC,
    'Immediatamente a fianco di ogni estintore installato in cantiere',
    'ISO 7010 F001 — D.M. 10/03/1998 — D.lgs 81/08 Art. 46'
  ),
  s(CAT_ANT, 'Allarme antincendio.jpg',
    Z_ANTINC,
    'Punti strategici del cantiere — uscite, zone deposito materiali infiammabili',
    'ISO 7010 F005 — D.M. 10/03/1998 — D.lgs 81/08 Art. 46'
  ),
  s(CAT_ANT, 'Pulsante di emergenza.jpg',
    Z_ANTINC,
    'Presso i quadri elettrici generali e le uscite principali del cantiere',
    'ISO 7010 F005 — D.M. 10/03/1998 — D.lgs 81/08 Art. 46'
  ),
];

// ─── REGOLE CONDIZIONALI: keyword → cartelli di lavorazione ───────────────────
const RULES = [
  {
    keywords: ['quota', 'ponteggio', 'ponteg', 'demoliz', 'tetto', 'copertura',
               'impalcatura', 'solaio', 'facciata', 'cappotto', 'terrazza',
               'lastrico', 'grondaia', 'abbaino', 'bordo'],
    signs: [
      s(CAT_PER, 'Pericolo di caduta.jpg',
        Z_LAVORO,
        'Zone ponteggi, bordi scavi, aperture nel vuoto, lavori in quota oltre 2 m',
        'ISO 7010 W009 — D.lgs 81/08 Artt. 107-122'
      ),
      s(CAT_OBB, 'Obbligo imbracatura di sicurezza.jpg',
        Z_LAVORO,
        'Accesso a tutte le zone di lavoro in quota superiori a 2 metri',
        'ISO 7010 M014 — UNI EN 361:2002 — D.lgs 81/08 Art. 115'
      ),
      s(CAT_PER, 'Pericolo carichi sospesi.jpg',
        Z_LAVORO,
        'Proiezione verticale della gru e delle zone di sollevamento carichi',
        'ISO 7010 W015 — D.lgs 81/08 Art. 190'
      ),
      s(CAT_DIV, 'Divieto di passaggio ai pedoni.jpg',
        Z_LAVORO,
        'Zone sotto lavori in quota, sotto carichi in sollevamento, bordi scavi',
        'ISO 7010 P004 — D.lgs 81/08 Art. 108'
      ),
    ]
  },
  {
    keywords: ['gru', 'autogrù', 'autogru', 'sollevamento', 'argano', 'braccio gru'],
    signs: [
      s(CAT_PER, 'Pericolo carichi sospesi.jpg',
        Z_LAVORO,
        'Area di azione della gru e di manovra in sollevamento carichi',
        'ISO 7010 W015 — D.lgs 81/08 Art. 190'
      ),
      s(CAT_PER, 'Pericolo macchine in movimento.jpg',
        Z_LAVORO,
        'Viabilità interna nelle zone di manovra della gru e dei mezzi di cantiere',
        'ISO 7010 W024 — D.lgs 81/08 Art. 70'
      ),
      s(CAT_DIV, 'Divieto di passaggio ai pedoni.jpg',
        Z_LAVORO,
        'Proiezione verticale della gru, zone di rotazione e di atterraggio carichi',
        'ISO 7010 P004 — D.lgs 81/08 Art. 108'
      ),
    ]
  },
  {
    keywords: ['scavo', 'scavi', 'ruspa', 'escavator', 'pale meccanic',
               'movimento terra', 'sbancamento', 'trivella', 'fondazion', 'platea', 'pali'],
    signs: [
      s(CAT_PER, 'Pericolo macchine in movimento.jpg',
        Z_LAVORO,
        'Viabilità interna nelle zone di manovra di escavatori, ruspe e dumper',
        'ISO 7010 W024 — D.lgs 81/08 Art. 70'
      ),
      s(CAT_PER, 'Pericolo di caduta.jpg',
        Z_LAVORO,
        'Bordi degli scavi, rampe di accesso, zone di sbancamento',
        'ISO 7010 W009 — D.lgs 81/08 Artt. 118-120'
      ),
      s(CAT_DIV, 'Divieto di transito ai veicoli.jpg',
        Z_LAVORO,
        'Zone pedonali, aree di scavo attivo, percorsi riservati ai pedoni',
        'ISO 7010 P006 — D.lgs 81/08 Art. 108'
      ),
      s(CAT_DIV, 'Divieto di passaggio ai pedoni.jpg',
        Z_LAVORO,
        'Zone di manovra dei mezzi meccanici, aree di scarico materiale',
        'ISO 7010 P004 — D.lgs 81/08 Art. 108'
      ),
    ]
  },
  {
    keywords: ['elettric', 'impianto elettr', 'quadro elettr', 'cabina elettr',
               'alta tensione', 'cablaggio', 'impianto bt', 'mt/bt', 'trasformator'],
    signs: [
      s(CAT_PER, 'Pericolo alta tensione.jpg',
        Z_LAVORO,
        'Quadri elettrici, cabine di trasformazione, zone con impianti MT/BT',
        'ISO 7010 W012 — D.lgs 81/08 Artt. 80-86'
      ),
      s(CAT_PER, 'Pericolo elettrico generale.jpg',
        Z_LAVORO,
        'Zone con cavi in posa, attrezzature elettriche, prolunghe e prese',
        'ISO 7010 W012 — D.lgs 81/08 Art. 80'
      ),
      s(CAT_DIV, 'Divieto di spegnere con acqua.jpg',
        Z_LAVORO,
        'Quadri elettrici, cabine, zone con impianti elettrici in tensione',
        'ISO 7010 P011 — D.lgs 81/08 Art. 80'
      ),
    ]
  },
  {
    keywords: ['saldatura', 'saldatr', 'taglio term', 'fiamma', 'cannello',
               'ossiacetilenica', 'plasma', 'elettrodo', 'mig', 'tig', 'arco'],
    signs: [
      s(CAT_DIV, 'Vietato fumare e usare fiamme libere.jpg',
        Z_LAVORO,
        'Zone di saldatura, depositi bombole gas, aree con materiali infiammabili',
        'ISO 7010 P003 — D.lgs 81/08 Art. 163'
      ),
      s(CAT_OBB, 'Obbligo protezione facciale.jpg',
        Z_LAVORO,
        'Zone di saldatura ad arco, plasma, ossiacetilenica e taglio termico',
        'ISO 7010 M013 — UNI EN 175:1999 — D.lgs 81/08 Art. 75'
      ),
      s(CAT_OBB, 'Obbligo occhiali di protezione.jpg',
        Z_LAVORO,
        'Zone saldatura, molatura, taglio con disco, proiezione schegge',
        'ISO 7010 M004 — UNI EN 166:2002 — D.lgs 81/08 Art. 75'
      ),
      s(CAT_PER, 'Pericolo materiale infiammabile.jpg',
        Z_LAVORO,
        'Deposito bombole, aree di stoccaggio materiali infiammabili',
        'ISO 7010 W021 — D.lgs 81/08 Art. 163'
      ),
    ]
  },
  {
    keywords: ['vernic', 'pittur', 'tinteggiat', 'solvente', 'resina',
               'impermeabil', 'rivestim', 'finitur', 'prodotto chim', 'eposs'],
    signs: [
      s(CAT_PER, 'Pericolo materiale infiammabile.jpg',
        Z_LAVORO,
        'Zone di stoccaggio e utilizzo vernici, solventi, prodotti a base di resine',
        'ISO 7010 W021 — Reg. REACH — D.lgs 81/08 Art. 163'
      ),
      s(CAT_PER, 'Pericolo sostanze irritanti.jpg',
        Z_LAVORO,
        'Zone di applicazione vernici, primer, adesivi e prodotti con pittogramma GHS07',
        'ISO 7010 W026 — Reg. CLP (UE) 1272/2008'
      ),
      s(CAT_PER, 'Pericolo sostanze corrosive.jpg',
        Z_LAVORO,
        'Zone di utilizzo acidi, basi, prodotti con pittogramma GHS05',
        'ISO 7010 W023 — Reg. CLP (UE) 1272/2008'
      ),
      s(CAT_OBB, 'Obbligo protezione vie respiratorie.jpg',
        Z_LAVORO,
        'Zone polverose e di applicazione vernici, solventi, primer, fibre',
        'ISO 7010 M017 — UNI EN 149:2009 — D.lgs 81/08 Art. 75'
      ),
      s(CAT_OBB, 'Obbligo occhiali di protezione.jpg',
        Z_LAVORO,
        'Zone di applicazione prodotti con rischio di schizzi e proiezioni',
        'ISO 7010 M004 — UNI EN 166:2002 — D.lgs 81/08 Art. 75'
      ),
      s(CAT_DIV, 'Vietato fumare e usare fiamme libere.jpg',
        Z_LAVORO,
        'Depositi e zone di utilizzo vernici, solventi, prodotti infiammabili',
        'ISO 7010 P003 — D.lgs 81/08 Art. 163'
      ),
    ]
  },
  {
    keywords: ['idraul', 'fognatura', 'tubazione', 'gasdotto', 'acquedotto',
               'scarico', 'adduzione', 'impianto gas', ' gas '],
    signs: [
      s(CAT_PER, 'Pericolo gas.jpg',
        Z_LAVORO,
        'Zone scavi in prossimità di gasdotti, impianti gas, zone di posa tubazioni',
        'ISO 7010 W019 — D.lgs 81/08 Art. 163'
      ),
      s(CAT_DIV, 'Divieto di bere acqua non potabile.jpg',
        Z_LAVORO,
        'Punti idrici di cantiere non collegati direttamente all\'acquedotto civile',
        'ISO 7010 P005 — D.lgs 81/08 Art. 163'
      ),
    ]
  },
  {
    keywords: ['rumore', 'demolitore', 'vibraz', 'martello', 'fresatura',
               'fresatrice', 'compressore', 'smerigliatrice', 'disco', 'scalpello'],
    signs: [
      s(CAT_PER, 'Pericolo rumore.jpg',
        Z_LAVORO,
        'Zone con utilizzo di macchinari rumorosi con esposizione superiore a 85 dB(A)',
        'ISO 7010 W038 — D.lgs 81/08 Artt. 189-198'
      ),
      s(CAT_OBB, 'Obbligo protezione udito.jpg',
        Z_LAVORO,
        'Zone con rumore superiore a 85 dB(A) — obbligo per tutti i presenti',
        'ISO 7010 M003 — UNI EN 352-1/2:2020 — D.lgs 81/08 Art. 193'
      ),
    ]
  },
  {
    keywords: ['polvere', 'polveroso', 'silice', 'amianto', 'fibre',
               'levigatura', 'carteggiatura', 'sabbiatura', 'taglio lateriz'],
    signs: [
      s(CAT_OBB, 'Obbligo protezione vie respiratorie.jpg',
        Z_LAVORO,
        'Zone polverose, taglio materiali silicei, rimozione materiali fibrosi',
        'ISO 7010 M017 — UNI EN 149:2009 — D.lgs 81/08 Art. 75'
      ),
      s(CAT_OBB, 'Obbligo occhiali di protezione.jpg',
        Z_LAVORO,
        'Zone con proiezione polveri e schegge durante taglio e levigatura',
        'ISO 7010 M004 — UNI EN 166:2002 — D.lgs 81/08 Art. 75'
      ),
      s(CAT_PER, 'Pericolo sostanze irritanti.jpg',
        Z_LAVORO,
        'Zone di produzione polveri irritanti: cemento, calce, silice, fibre',
        'ISO 7010 W026 — Reg. CLP — D.lgs 81/08 Art. 163'
      ),
    ]
  },
  {
    keywords: ['muratura', 'intonaco', 'intonaci', 'calcestruzzo', 'cls',
               'getto', 'cemento', 'mattone', 'blocchi', 'pavimentazione', 'massetto'],
    signs: [
      s(CAT_PER, 'Pericolo di scivolamento.jpg',
        Z_LAVORO,
        'Superfici bagnate durante getto cls, zone di stesura massetti e intonaci',
        'ISO 7010 W011 — D.lgs 81/08 Art. 163'
      ),
    ]
  },
  {
    keywords: ['trasporto', 'autocarro', 'autobetoniera', 'betoniera',
               'carrello elevatore', 'muletto', 'autocarr', 'dumper'],
    signs: [
      s(CAT_PER, 'Pericolo macchine in movimento.jpg',
        Z_LAVORO,
        'Viabilità interna del cantiere, zone di manovra e scarico mezzi',
        'ISO 7010 W024 — D.lgs 81/08 Art. 70'
      ),
      s(CAT_OBB, 'Obbligo passaggio pedoni.jpg',
        Z_LAVORO,
        'Percorsi pedonali obbligatori separati dalla viabilità dei mezzi',
        'ISO 7010 M024 — D.lgs 81/08 Art. 108'
      ),
    ]
  },
  {
    keywords: ['sostanza pericolosa', 'chimico', 'acido', 'base', 'corrosivo',
               'disinfettante', 'sgrassante', 'diluente'],
    signs: [
      s(CAT_PER, 'Pericolo sostanze corrosive.jpg',
        Z_LAVORO,
        'Deposito e zone di utilizzo sostanze con pittogramma GHS05 (corrosivo)',
        'ISO 7010 W023 — Reg. CLP (UE) 1272/2008'
      ),
      s(CAT_PER, 'Pericolo sostanze velenose.jpg',
        Z_LAVORO,
        'Deposito e zone di utilizzo sostanze con pittogramma GHS06 (tossico)',
        'ISO 7010 W016 — Reg. CLP (UE) 1272/2008'
      ),
      s(CAT_VER, 'Lavaocchi di emergenza.jpg',
        Z_EMERGENZA,
        'In prossimità delle zone di utilizzo sostanze con rischio di contatto oculare',
        'ISO 7010 E011 — D.lgs 81/08 Art. 163'
      ),
      s(CAT_VER, 'Doccia di emergenza.jpg',
        Z_EMERGENZA,
        'In prossimità delle zone di utilizzo sostanze corrosive o causticanti',
        'ISO 7010 E012 — D.lgs 81/08 Art. 163'
      ),
    ]
  },
];

// ─── FUNZIONE PRINCIPALE ───────────────────────────────────────────────────────
function selectSigns(posData) {
  const d = posData || {};

  const worksText = [
    ...(d.selectedWorks || []),
    d.workType || '',
    d.siteAddress || ''
  ].join(' ').toLowerCase();

  // Deduplicazione per path
  const selected = new Map();
  for (const sign of ALWAYS) {
    selected.set(sign.path, sign);
  }
  for (const rule of RULES) {
    if (rule.keywords.some(kw => worksText.includes(kw))) {
      for (const sign of rule.signs) {
        selected.set(sign.path, sign);
      }
    }
  }

  return Array.from(selected.values());
}

// Ordine delle zone nel documento
const ZONE_ORDER = [Z_INGRESSO, Z_DPI, Z_LAVORO, Z_EMERGENZA, Z_ANTINC];

module.exports = { selectSigns, ZONE_ORDER, Z_INGRESSO, Z_DPI, Z_LAVORO, Z_EMERGENZA, Z_ANTINC };
