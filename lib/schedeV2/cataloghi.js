'use strict';
/**
 * lib/schedeV2/cataloghi.js — F-350. Agenti chimici e cartelli citati dalle
 * schede nuove. Dati puri.
 */

// Agenti chimici e cancerogeni: pericoli (frasi H del CLP o allegato del
// D.Lgs. 81/08), valore limite se esiste, indicazioni, obblighi che fanno scattare.
const AGENTI = {
  cemento: {
    nome: 'Cemento, calcestruzzo fresco e malte cementizie',
    pericoli: 'H315 irritazione cutanea · H317 sensibilizzazione cutanea · H318 gravi lesioni oculari · H335 irritazione delle vie respiratorie (polvere)',
    note: 'Fortemente alcalino (pH > 12): il contatto prolungato con la pelle bagnata provoca ustioni chimiche anche senza dolore immediato. Cromo VI solubile ≤ 2 ppm (Reg. REACH, All. XVII voce 47).',
    sorveglianza: 'rischio cutaneo da cemento (valutazione del medico competente)',
  },
  calce: {
    nome: 'Calce idrata e malte di calce',
    pericoli: 'H315 irritazione cutanea · H318 gravi lesioni oculari · H335 irritazione delle vie respiratorie',
    note: 'Polvere molto irritante per gli occhi: impasto senza sollevare polvere, occhiali durante la preparazione.',
    sorveglianza: null,
  },
  silice: {
    nome: 'Polvere di silice cristallina respirabile',
    pericoli: 'Cancerogeno: lavori comportanti esposizione a silice cristallina respirabile (Allegato XLII). Valore limite 0,1 mg/m³ (Allegato XLIII)',
    note: 'Prodotta da demolizione, taglio, foratura, scanalatura e levigatura di calcestruzzo, laterizi, malte, intonaci e pietre. Si applica il Titolo IX Capo II: riduzione al minimo, registro degli esposti (art. 243), sorveglianza sanitaria (art. 242).',
    sorveglianza: 'silice cristallina (art. 242) con iscrizione nel registro degli esposti (art. 243)',
    cancerogeno: true,
    // riga della tabella 10.2 del POS: sostanza, classificazione, rischi, DPI e cautele
    riga10: ['Polvere di silice cristallina respirabile (da demolizione, taglio, foratura, levigatura)', 'Cancerogeno: Allegato XLII D.Lgs. 81/08; valore limite 0,1 mg/m³ (Allegato XLIII)', 'Silicosi e tumore del polmone per inalazione', 'Bagnatura o aspirazione alla fonte, facciale FFP3, registro degli esposti (art. 243), sorveglianza sanitaria (art. 242)'],
  },
  amianto: {
    nome: 'Materiali contenenti amianto',
    pericoli: 'H350 può provocare il cancro · H372 provoca danni ai polmoni per esposizione prolungata',
    note: 'Prima di demolire o rimuovere si accerta l\'assenza di amianto (art. 248). Se c\'è, lo rimuove solo una ditta iscritta all\'Albo gestori ambientali (cat. 10) con piano di lavoro (art. 256).',
    sorveglianza: null,
    cancerogeno: true,
  },
  disarmante: {
    nome: 'Disarmante per casseforme',
    pericoli: 'Secondo la scheda di dati di sicurezza del prodotto usato',
    note: 'Applicato a rullo o a spruzzo a bassa pressione, mai nebulizzato in spazi chiusi. Superfici trattate scivolose.',
    sorveglianza: null,
  },
};

// Cartelli ISO 7010 usati dalle schede (codice → nome in italiano, tipo).
const SEGNALI = {
  P001: ['Divieto generico', 'divieto'], P002: ['Vietato fumare', 'divieto'], P003: ['Vietato usare fiamme libere', 'divieto'],
  P004: ['Divieto di transito', 'divieto'], P024: ['Vietato camminare o sostare', 'divieto'],
  W001: ['Pericolo generico', 'pericolo'], W008: ['Pericolo di caduta dall\'alto', 'pericolo'], W011: ['Superficie scivolosa', 'pericolo'],
  W012: ['Pericolo elettrico', 'pericolo'], W014: ['Carrelli elevatori in movimento', 'pericolo'], W015: ['Carichi sospesi', 'pericolo'],
  W016: ['Sostanze tossiche', 'pericolo'], W017: ['Superficie calda', 'pericolo'], W021: ['Materiale infiammabile', 'pericolo'],
  W023: ['Sostanze corrosive', 'pericolo'], W035: ['Caduta di oggetti', 'pericolo'],
  M003: ['Obbligo di protezione dell\'udito', 'obbligo'], M004: ['Obbligo di protezione degli occhi', 'obbligo'], M008: ['Obbligo delle calzature di sicurezza', 'obbligo'],
  M009: ['Obbligo dei guanti', 'obbligo'], M010: ['Obbligo degli indumenti protettivi', 'obbligo'], M013: ['Obbligo della visiera', 'obbligo'],
  M014: ['Obbligo del casco', 'obbligo'], M015: ['Obbligo degli indumenti ad alta visibilità', 'obbligo'], M016: ['Obbligo della mascherina', 'obbligo'],
  M017: ['Obbligo di protezione delle vie respiratorie', 'obbligo'], M018: ['Obbligo dell\'imbracatura', 'obbligo'], M019: ['Obbligo della maschera per saldatura', 'obbligo'],
  E003: ['Pronto soccorso', 'salvataggio'], E011: ['Lavaggio degli occhi', 'salvataggio'], F001: ['Estintore', 'antincendio'],
};

module.exports = { AGENTI, SEGNALI };
