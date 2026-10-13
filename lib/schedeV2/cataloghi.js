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
  biologico: {
    nome: 'Agenti biologici di liquami, fanghi e terreno',
    pericoli: 'Agenti del gruppo 2 (Allegato XLVI): leptospire, virus dell\'epatite A, batteri enterici; spore del tetano nel terreno',
    note: 'Guanti impermeabili e stivali, niente cibo, bevande o fumo durante il lavoro, lavaggio delle mani, ferite coperte. Vaccinazione antitetanica obbligatoria per i lavoratori edili (L. 292/1963); altre vaccinazioni secondo il medico competente.',
    sorveglianza: 'agenti biologici (art. 279)',
    riga10: ['Agenti biologici di liquami, fanghi e terreno', 'Gruppo 2 (Allegato XLVI D.Lgs. 81/08)', 'Leptospirosi, epatite A, infezioni enteriche, tetano', 'Guanti impermeabili, igiene delle mani, vaccinazione antitetanica (L. 292/1963), sorveglianza sanitaria (art. 279)'],
  },
  gas_fognatura: {
    nome: 'Gas di fognature e scavi (idrogeno solforato, metano) e carenza di ossigeno',
    pericoli: 'Idrogeno solforato: tossico per inalazione anche a basse concentrazioni, non più avvertito dall\'olfatto ad alte concentrazioni · metano: infiammabile ed esplosivo · aria povera di ossigeno: asfissia',
    note: 'Misura con rilevatore multigas prima di entrare e durante il lavoro, ventilazione, addetto all\'esterno; in pozzetti e reti esistenti si lavora come in spazio confinato (D.P.R. 177/2011).',
    sorveglianza: null,
    riga10: ['Gas di fognature e scavi (idrogeno solforato, metano), carenza di ossigeno', 'H2S: gas tossico e infiammabile; metano: H220', 'Intossicazione, asfissia, esplosione', 'Rilevatore multigas, ventilazione, addetto all\'esterno, procedura per spazi confinati (D.P.R. 177/2011)'],
  },
  resine_epossidiche: {
    nome: 'Resine epossidiche e primer per rinforzi e incollaggi',
    pericoli: 'H315 irritazione cutanea · H317 sensibilizzazione cutanea · H319 irritazione oculare · EUH205 contiene componenti epossidici (secondo la scheda di sicurezza)',
    note: 'La sensibilizzazione è permanente: guanti in nitrile adatti alle resine, maniche lunghe, mai pulire la pelle con solventi. Locale ventilato durante la miscelazione e la stesura.',
    sorveglianza: 'rischio chimico cutaneo da resine (valutazione del medico competente)',
  },
  bitume: {
    nome: 'Bitume, membrane bituminose e primer',
    pericoli: 'Fumi di bitume caldo irritanti per occhi e vie respiratorie; primer a solvente infiammabili (secondo la scheda di sicurezza)',
    note: 'Lavorare sopravento rispetto ai fumi, primer lontani da fiamme e lasciati asciugare prima di usare il cannello.',
    sorveglianza: null,
  },
  gpl: {
    nome: 'Gas propano / GPL in bombole',
    pericoli: 'H220 gas altamente infiammabile · H280 contiene gas sotto pressione',
    note: 'Bombole in piedi e assicurate, lontane da fonti di calore e mai in locali interrati: il GPL è più pesante dell\'aria e ristagna in basso.',
    sorveglianza: null,
  },
  solventi: {
    nome: 'Solventi, diluenti, vernici e sverniciatori',
    pericoli: 'Secondo la scheda di sicurezza; tipicamente H225/H226 infiammabili, H336 sonnolenza e vertigini, H304 tossici in caso di ingestione e penetrazione nelle vie respiratorie',
    note: 'Ventilazione, niente fiamme o scintille, contenitori chiusi ed etichettati, maschera con filtri per vapori organici negli ambienti chiusi.',
    sorveglianza: 'agenti chimici (art. 229) se la valutazione indica un rischio non basso',
  },
  fumi_saldatura: {
    nome: 'Fumi di saldatura e di taglio termico',
    pericoli: 'Cancerogeni per l\'uomo secondo lo IARC (gruppo 1, 2017); contengono ossidi metallici; con acciaio inox anche cromo esavalente',
    note: 'Aspirazione localizzata o lavoro all\'aperto sopravento, facciale filtrante adatto ai fumi metallici; mai saldare su superfici verniciate o zincate senza aspirazione.',
    sorveglianza: 'agenti chimici e cancerogeni secondo la valutazione del medico competente',
    riga10: ['Fumi di saldatura e di taglio termico', 'Cancerogeni per l\'uomo (IARC gruppo 1)', 'Danni respiratori, febbre da fumi metallici, tumori', 'Aspirazione localizzata o lavoro all\'aperto, facciale filtrante FFP2/FFP3 per fumi, schermi per chi è vicino'],
  },
  isocianati: {
    nome: 'Schiume poliuretaniche e prodotti con diisocianati',
    pericoli: 'Tipicamente H334 sensibilizzazione delle vie respiratorie · H317 sensibilizzazione cutanea · H351 sospettato di provocare il cancro (secondo la scheda di sicurezza)',
    note: 'Dal 24 agosto 2023 chi usa prodotti con diisocianati oltre lo 0,1% deve aver completato la formazione obbligatoria (Reg. UE 2020/1149). Guanti in nitrile, ambienti aerati.',
    sorveglianza: 'sensibilizzanti respiratori (valutazione del medico competente)',
    riga10: ['Schiume poliuretaniche e prodotti con diisocianati', 'H334, H317, H351 (secondo SDS)', 'Asma da isocianati, sensibilizzazione della pelle', 'Formazione obbligatoria sui diisocianati (Reg. UE 2020/1149), guanti in nitrile, ambienti aerati'],
  },
  legno_duro: {
    nome: 'Polvere di legno duro',
    pericoli: 'Cancerogeno: lavori che espongono a polvere di legno duro (Allegato XLII); valore limite 2 mg/m³ (Allegato XLIII)',
    note: 'Taglio, levigatura e fresatura di legni duri (rovere, faggio, noce e simili) con aspirazione alla fonte; registro degli esposti (art. 243).',
    sorveglianza: 'polvere di legno duro (art. 242) con iscrizione nel registro degli esposti (art. 243)',
    cancerogeno: true,
    riga10: ['Polvere di legno duro (rovere, faggio, noce e simili)', 'Cancerogeno: Allegato XLII D.Lgs. 81/08; valore limite 2 mg/m³ (Allegato XLIII)', 'Tumori delle cavità nasali, irritazione', 'Aspirazione alla fonte, facciale FFP3, registro degli esposti (art. 243), sorveglianza sanitaria (art. 242)'],
  },
  fibre_minerali: {
    nome: 'Lane minerali (vetro, roccia) e fibre isolanti',
    pericoli: 'Irritazione meccanica di pelle, occhi e vie respiratorie; le lane biosolubili sono escluse dalla classificazione come cancerogene (Nota Q del Reg. CLP)',
    note: 'Taglio con lama e non con disco, tute e guanti, mascherina FFP2, pulizia ad aspirazione.',
    sorveglianza: null,
  },
  piombo: {
    nome: 'Vecchie vernici al piombo',
    pericoli: 'Piombo e composti: tossici per la riproduzione e per inalazione e ingestione; valore limite di esposizione e valore limite biologico (Allegati XXXVIII e XXXIX)',
    note: 'Analisi delle vernici prima di carteggiarle o sabbiarle; se c\'è piombo: rimozione a umido o con sverniciatore, aspirazione con filtro di classe H, igiene rigorosa.',
    sorveglianza: 'piombo (controllo del piombo nel sangue secondo il medico competente)',
    riga10: ['Vecchie vernici al piombo (se presenti)', 'Piombo e composti: Allegati XXXVIII e XXXIX D.Lgs. 81/08', 'Intossicazione da piombo per inalazione e ingestione', 'Analisi preventiva, rimozione a umido, aspirazione con filtro H, igiene e sorveglianza sanitaria'],
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
  P004: ['Divieto di transito', 'divieto'], P010: ['Vietato toccare', 'divieto'], P024: ['Vietato camminare o sostare', 'divieto'],
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
