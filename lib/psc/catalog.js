'use strict';
/**
 * lib/psc/catalog.js — F-270 (AUDIT.md del frontend). Il "sapere" fisso del
 * modulo coordinatori: organizzazione del cantiere (All. XV 2.2.2), rischi
 * dell'area (2.2.1), voci tipiche dei costi della sicurezza (4.1.1), testi
 * proposti per coordinamento ed emergenze, contenuti minimi del POS (3.2.1).
 *
 * Tutti i testi qui sono PROPOSTE: nel PSC entrano solo dopo che il
 * coordinatore li approva (o li sostituisce con le sue frasi). I prezzi sono
 * INDICATIVI e marcati come tali: il controllo finale li segnala finché il
 * coordinatore non li conferma o li prende dal suo prezzario.
 *
 * Dati puri: nessun I/O.
 */

// ── Organizzazione del cantiere (Allegato XV, 2.2.2) ─────────────────────────
const ORGANIZZAZIONE = [
  { key: 'recinzione', titolo: 'Recinzione, accessi e segnalazioni', rif: '2.2.2 a',
    testo: 'L\'area di cantiere è delimitata per tutto il perimetro da recinzione alta almeno 2 m, in pannelli metallici su basi stabili, chiusa fuori dall\'orario di lavoro. Gli accessi carrabile e pedonale sono separati e segnalati; all\'ingresso sono esposti il cartello di cantiere e la segnaletica di sicurezza (divieto di accesso ai non addetti, obbligo di casco e calzature di sicurezza).' },
  { key: 'servizi', titolo: 'Servizi igienico-assistenziali', rif: '2.2.2 b',
    testo: 'Sono previsti spogliatoio riscaldato con armadietti, servizio igienico (bagno chimico o allacciato) con lavabo e acqua potabile, in numero adeguato agli addetti presenti contemporaneamente (Allegato XIII). La pulizia è a carico dell\'impresa affidataria.' },
  { key: 'viabilita', titolo: 'Viabilità principale di cantiere', rif: '2.2.2 c',
    testo: 'I percorsi dei mezzi sono separati da quelli pedonali, mantenuti in piano e sgombri. Velocità dei mezzi a passo d\'uomo; le manovre in retromarcia avvengono con l\'assistenza di un operatore a terra.' },
  { key: 'impianti', titolo: 'Impianti di alimentazione (elettricità, acqua)', rif: '2.2.2 d',
    testo: 'L\'impianto elettrico di cantiere è realizzato da impresa abilitata con quadri ASC conformi alla CEI EN 61439-4, protetto da interruttori differenziali; l\'installatore rilascia la dichiarazione di conformità prima dell\'uso. Cavi a terra protetti dal passaggio dei mezzi o posati in aereo.' },
  { key: 'terra', titolo: 'Impianto di terra e protezione dalle scariche atmosferiche', rif: '2.2.2 e',
    testo: 'L\'impianto di terra è realizzato prima dell\'uso delle macchine elettriche e denunciato entro 30 giorni (D.P.R. 462/2001). La necessità di protezione dalle scariche atmosferiche per gru e ponteggi è valutata con calcolo secondo CEI EN 62305.' },
  { key: 'rls', titolo: 'Consultazione degli RLS', rif: '2.2.2 f',
    testo: 'Prima dell\'accettazione del PSC e delle sue modifiche significative ogni datore di lavoro consulta il proprio rappresentante dei lavoratori per la sicurezza e gli fornisce i chiarimenti richiesti (art. 102).' },
  { key: 'coordinamento_imprese', titolo: 'Cooperazione e coordinamento tra imprese', rif: '2.2.2 g',
    testo: 'L\'impresa affidataria verifica le condizioni di sicurezza dei lavori affidati e coordina le imprese esecutrici (art. 97). Nessuna impresa o lavoratore autonomo entra in cantiere prima di aver ricevuto il PSC e di aver consegnato il proprio POS.' },
  { key: 'dislocazione', titolo: 'Dislocazione degli impianti di cantiere', rif: '2.2.2 h',
    testo: 'Baracche, quadri elettrici e depositi sono collocati come indicato nel layout di cantiere, fuori dal raggio di caduta dei carichi e lontano dai bordi degli scavi.' },
  { key: 'carico_scarico', titolo: 'Zone di carico e scarico', rif: '2.2.2 i',
    testo: 'Le operazioni di carico e scarico avvengono nell\'area dedicata, delimitata durante la manovra; nessuno sosta sotto i carichi sospesi. Le consegne si concordano con l\'impresa affidataria.' },
  { key: 'stoccaggio', titolo: 'Zone di deposito attrezzature e stoccaggio materiali', rif: '2.2.2 l',
    testo: 'I materiali sono stoccati in modo stabile, in altezza limitata, lontano dai bordi e dai percorsi. Le attrezzature non in uso sono riposte nel deposito.' },
  { key: 'rifiuti', titolo: 'Zone di stoccaggio dei rifiuti', rif: '2.2.2 l',
    testo: 'I rifiuti sono separati per tipologia in cassoni o big bag identificati, nell\'area indicata nel layout, e allontanati con regolarità secondo la normativa vigente.' },
  { key: 'infiammabili', titolo: 'Depositi di materiali con pericolo d\'incendio o esplosione', rif: '2.2.2 m',
    testo: 'Bombole, carburanti e prodotti infiammabili sono depositati in quantità minima, in area ventilata e segnalata, lontano da fonti di calore, con estintore nelle vicinanze. Le bombole sono fissate in posizione verticale.' },
];

// ── Area di cantiere: rischi dal contesto (Allegato XV, 2.2.1) ───────────────
// Ogni rischio può nascere da un dato trovato (OSM) o da una risposta del
// coordinatore. `misure` è il testo proposto per il PSC.
const CONTESTO = {
  strada_traffico: { titolo: 'Strada a traffico intenso adiacente', rif: '2.2.1 c',
    misure: 'Ingresso e uscita dei mezzi con l\'assistenza di un moviere; segnaletica temporanea di cantiere secondo il D.M. 10/07/2002; consegne programmate fuori dalle ore di punta; pulizia della carreggiata dai detriti.' },
  strada: { titolo: 'Strada pubblica adiacente', rif: '2.2.1 c',
    misure: 'Segnalazione dell\'accesso carrabile e manovre dei mezzi assistite da un operatore a terra.' },
  fermata_bus: { titolo: 'Fermata dei mezzi pubblici vicina all\'accesso', rif: '2.2.1 c',
    misure: 'Recinzione con percorso pedonale protetto lungo il fronte del cantiere; nessun deposito di materiali sul marciapiede; teli di protezione sul ponteggio verso il lato pedonale.' },
  ferrovia: { titolo: 'Linea ferroviaria nelle vicinanze', rif: '2.2.1 c',
    misure: 'Nessun mezzo di sollevamento opera entro la fascia di rispetto ferroviaria senza accordo con il gestore della linea.' },
  scuola: { titolo: 'Scuola o asilo nelle vicinanze', rif: '2.2.1 c',
    misure: 'Nessuna manovra di mezzi pesanti negli orari di ingresso e uscita degli alunni; recinzione continua e non scalabile; lavorazioni rumorose concordate con l\'istituto.' },
  ospedale: { titolo: 'Struttura sanitaria nelle vicinanze', rif: '2.2.1 c',
    misure: 'Percorsi dei mezzi di soccorso sempre liberi; lavorazioni rumorose e polverose limitate e concordate.' },
  edificio_in_uso: { titolo: 'Edificio in uso durante i lavori', rif: '2.2.1 c',
    misure: 'Aree di lavoro separate fisicamente da quelle utilizzate dagli occupanti, con percorsi distinti e segnalati; lavorazioni rumorose e polverose concordate con il committente; vie di esodo dell\'edificio sempre libere e verificate ogni giorno dal preposto dell\'impresa affidataria.' },
  edifici_confinanti: { titolo: 'Edifici abitati confinanti', rif: '2.2.1 c',
    misure: 'Verifica dello stato delle strutture confinanti prima delle demolizioni; contenimento di polveri e rumore negli orari consentiti dal regolamento comunale.' },
  linee_aeree: { titolo: 'Linee elettriche aeree', rif: '2.2.1 a',
    misure: 'Rispetto delle distanze minime dalle parti attive (Allegato IX, Tab. 1); dove non è possibile, richiesta al gestore di messa fuori tensione o protezione delle linee prima dell\'inizio dei lavori.' },
  sottoservizi: { titolo: 'Sottoservizi (gas, acqua, elettricità, fognature)', rif: '2.2.1 a',
    misure: 'Prima degli scavi si acquisiscono le planimetrie dei sottoservizi dagli enti gestori e si individuano i tracciati sul terreno; in prossimità delle reti lo scavo procede a mano.' },
  alberi: { titolo: 'Alberature e vegetazione', rif: '2.2.1 a',
    misure: 'Protezione dei tronchi e verifica delle interferenze delle chiome con i mezzi di sollevamento.' },
  corsi_acqua: { titolo: 'Corsi d\'acqua o canali vicini', rif: '2.2.1 a',
    misure: 'Delimitazione delle sponde e sospensione dei lavori in caso di allerta idrogeologica.' },
  rischi_verso_esterno: { titolo: 'Rischi trasmessi all\'ambiente circostante', rif: '2.2.1 c',
    misure: 'Bagnatura delle superfici per limitare le polveri; macchine e attrezzature rumorose usate negli orari consentiti; teli e mantovane contro la caduta di materiali verso le aree esterne.' },
};

// Cose che dalla mappa non si vedono: vanno nel primo sopralluogo.
// Rischio da ordigni bellici inesplosi (art. 91 c. 2-bis): il CSP lo valuta
// quando ci sono scavi o perforazioni. Tre esiti, testo proposto per il PSC.
const ORDIGNI = {
  nessuno_scavo: { titolo: 'Non applicabile: nessuno scavo', testo: 'Non sono previsti scavi né perforazioni nel terreno: il rischio di rinvenimento di ordigni bellici inesplosi non è applicabile a questo cantiere.' },
  trascurabile: { titolo: 'Valutato: rischio trascurabile', testo: 'Il rischio da ordigni bellici inesplosi (art. 91, c. 2-bis) è stato valutato trascurabile sulla base delle informazioni storiche e dello stato dei luoghi. Se durante gli scavi si rinvengono oggetti sospetti: sospendere subito i lavori, allontanare i lavoratori, delimitare l\'area, avvisare il CSE e chiamare il 112. I lavori riprendono solo dopo l\'intervento delle autorità.' },
  bonifica: { titolo: 'Serve la bonifica bellica preventiva', testo: 'Dalla valutazione del rischio da ordigni bellici inesplosi (art. 91, c. 2-bis) è necessaria la bonifica bellica sistematica preventiva (BOB), a cura del committente con impresa specializzata iscritta all\'albo del Ministero della Difesa, prima dell\'inizio degli scavi. Gli scavi iniziano solo dopo l\'attestazione di avvenuta bonifica.' },
};

const DA_SOPRALLUOGO = [
  { key: 'linee_aeree', domanda: 'Linee elettriche aeree sopra o vicino all\'area?' },
  { key: 'sottoservizi', domanda: 'Sottoservizi sotto l\'area degli scavi?' },
  { key: 'edifici_confinanti', domanda: 'Stato degli edifici confinanti?' },
];

// ── Costi della sicurezza (Allegato XV, punto 4.1.1) ─────────────────────────
const CATEGORIE_COSTI = {
  a: 'Apprestamenti previsti nel PSC',
  b: 'Misure preventive e protettive e DPI per le lavorazioni interferenti',
  c: 'Impianti di terra, protezione dalle scariche atmosferiche, antincendio, evacuazione fumi',
  d: 'Mezzi e servizi di protezione collettiva',
  e: 'Procedure previste nel PSC per specifici motivi di sicurezza',
  f: 'Interventi per lo sfasamento spaziale o temporale delle lavorazioni interferenti',
  g: 'Misure di coordinamento per l\'uso comune di apprestamenti, attrezzature, infrastrutture, mezzi e servizi',
};

// q: come si calcola la quantità proposta ('mesi' | 'uno' | 'riunioni' | 'zero' = da misurare)
const VOCI_COSTO = [
  { key: 'recinzione', cat: 'a', descrizione: 'Recinzione di cantiere h 2 m in pannelli di rete elettrosaldata zincata su basi in calcestruzzo: montaggio, nolo per la durata dei lavori e smontaggio', um: 'm', prezzo: 12.0, q: 'zero', sempre: true },
  { key: 'cancello', cat: 'a', descrizione: 'Accesso carrabile con cancello in pannelli metallici: montaggio, nolo e smontaggio', um: 'cad', prezzo: 180.0, q: 'uno', sempre: true },
  { key: 'baracca', cat: 'a', descrizione: 'Box prefabbricato uso spogliatoio, compreso trasporto, posa e rimozione, nolo mensile', um: 'mese', prezzo: 220.0, q: 'mesi', sempre: true },
  { key: 'wc', cat: 'a', descrizione: 'Bagno chimico portatile, nolo mensile compresa pulizia settimanale', um: 'mese', prezzo: 150.0, q: 'mesi', sempre: true },
  { key: 'ponteggio', cat: 'a', descrizione: 'Ponteggio metallico fisso: montaggio, nolo per il primo mese e smontaggio, misurato in proiezione di facciata', um: 'm²', prezzo: 14.0, q: 'zero', schede: ['ponteggio-montaggio', 'ponteggio-uso'] },
  { key: 'ponteggio_nolo', cat: 'a', descrizione: 'Ponteggio metallico fisso: nolo per ogni mese successivo al primo', um: 'm²·mese', prezzo: 1.5, q: 'zero', schede: ['ponteggio-montaggio', 'ponteggio-uso'] },
  { key: 'mantovana', cat: 'a', descrizione: 'Mantovana parasassi su ponteggio: montaggio, nolo e smontaggio', um: 'm', prezzo: 22.0, q: 'zero', schede: ['ponteggio-montaggio'] },
  { key: 'teli', cat: 'a', descrizione: 'Telo o rete di protezione contro la caduta di materiali e le polveri, su ponteggio', um: 'm²', prezzo: 3.5, q: 'zero', schede: ['ponteggio-montaggio'] },
  { key: 'parapetti', cat: 'a', descrizione: 'Parapetto provvisorio di protezione dei bordi (UNI EN 13374) con tavola fermapiede: montaggio, nolo e smontaggio', um: 'm', prezzo: 18.0, q: 'zero', schede: ['coperture-lavori', 'aperture-vuoti', 'solai-posa'] },
  { key: 'linea_vita', cat: 'a', descrizione: 'Linea di ancoraggio provvisoria orizzontale (UNI EN 795 tipo C): installazione, nolo e rimozione', um: 'm', prezzo: 25.0, q: 'zero', schede: ['coperture-lavori', 'coperture-fragili'] },
  { key: 'armatura_scavi', cat: 'a', descrizione: 'Armatura delle pareti di scavo con pannelli metallici (blindaggio): posa, nolo e rimozione', um: 'm²', prezzo: 18.0, q: 'zero', schede: ['scavo-sbancamento', 'scavo-trincea', 'scavo-sottoservizi'] },
  { key: 'parapetti_scavi', cat: 'a', descrizione: 'Delimitazione del bordo degli scavi con parapetto o transenne', um: 'm', prezzo: 6.0, q: 'zero', schede: ['scavo-sbancamento', 'scavo-trincea', 'scavo-sottoservizi'] },
  { key: 'tunnel', cat: 'a', descrizione: 'Percorso pedonale protetto lungo il fronte del cantiere: montaggio, nolo e smontaggio', um: 'm', prezzo: 45.0, q: 'zero', contesto: ['fermata_bus', 'edificio_in_uso'] },
  { key: 'transenne_interferenze', cat: 'b', descrizione: 'Delimitazione dell\'area interdetta sotto le lavorazioni in quota durante le lavorazioni interferenti', um: 'm', prezzo: 5.0, q: 'zero', interferenza: true },
  { key: 'cartelli', cat: 'b', descrizione: 'Cartellonistica di sicurezza (divieto, obbligo, pericolo, emergenza) per il cantiere', um: 'cad', prezzo: 15.0, q: 'zero', sempre: true },
  { key: 'terra', cat: 'c', descrizione: 'Impianto di messa a terra del cantiere con dispersori e collegamenti equipotenziali, compresa verifica', um: 'a corpo', prezzo: 450.0, q: 'uno', sempre: true },
  { key: 'estintori', cat: 'c', descrizione: 'Estintore portatile a polvere 6 kg, nolo per la durata dei lavori, compresa verifica semestrale', um: 'cad', prezzo: 35.0, q: 'zero', sempre: true },
  { key: 'segnaletica_stradale', cat: 'd', descrizione: 'Segnaletica stradale temporanea di cantiere (D.M. 10/07/2002): posa, nolo e rimozione', um: 'a corpo', prezzo: 250.0, q: 'uno', contesto: ['strada_traffico', 'strada'] },
  { key: 'moviere', cat: 'd', descrizione: 'Moviere per la regolazione del traffico durante le manovre dei mezzi', um: 'ora', prezzo: 30.0, q: 'zero', contesto: ['strada_traffico'] },
  { key: 'pronto_soccorso', cat: 'd', descrizione: 'Cassetta di pronto soccorso (D.M. 388/2003), fornitura e reintegro', um: 'cad', prezzo: 60.0, q: 'uno', sempre: true },
  { key: 'sfasamento', cat: 'f', descrizione: 'Oneri per lo sfasamento spaziale delle lavorazioni interferenti (delimitazioni e percorsi alternativi)', um: 'a corpo', prezzo: 0, q: 'zero', sfasamento: true },
  { key: 'riunioni', cat: 'g', descrizione: 'Partecipazione dei datori di lavoro o preposti delle imprese alle riunioni di coordinamento', um: 'ora', prezzo: 35.0, q: 'riunioni', sempre: true },
  { key: 'informazione', cat: 'g', descrizione: 'Informazione dei lavoratori sui contenuti del PSC alla riunione di inizio lavori', um: 'ora', prezzo: 30.0, q: 'uno', sempre: true },
];

// ── Testi proposti ────────────────────────────────────────────────────────────
const TESTI_PROPOSTI = {
  coordinamento: 'Il coordinatore per l\'esecuzione convoca una riunione di coordinamento prima dell\'inizio dei lavori, prima dell\'ingresso in cantiere di ogni nuova impresa o lavoratore autonomo e almeno ogni due settimane, con verbale firmato dai presenti. Le imprese comunicano con almeno 3 giorni lavorativi di anticipo l\'ingresso di nuovi subappaltatori, mezzi o lavorazioni non previste dal cronoprogramma.',
  informazione: 'Ogni datore di lavoro informa i propri lavoratori sui contenuti del PSC che li riguardano e sulle misure di coordinamento, e mette a disposizione degli RLS copia del PSC e del POS almeno 10 giorni prima dell\'inizio dei lavori (art. 100, c. 4).',
  emergenze_procedura: 'In caso di infortunio o malore: chi è presente chiama il 112, avvisa il preposto e l\'addetto al primo soccorso, non sposta l\'infortunato salvo pericolo immediato. In caso di incendio: allontanamento dei lavoratori verso il punto di raccolta, intervento con estintori solo da parte degli addetti formati, chiamata ai Vigili del Fuoco tramite il 112. Il preposto dell\'impresa affidataria verifica al punto di raccolta che tutti siano presenti.',
  gestione_emergenze: 'La gestione delle emergenze è affidata all\'impresa affidataria, che garantisce in cantiere per tutta la durata dei lavori almeno un addetto al primo soccorso e uno all\'antincendio formati, la cassetta di pronto soccorso e gli estintori. Le imprese esecutrici comunicano i nominativi dei propri addetti.',
  orari: 'Orario di lavoro: dal lunedì al venerdì, 8:00-12:00 e 13:00-17:00, salvo diverse prescrizioni del regolamento comunale per le attività rumorose.',
};

// ── Contenuti minimi del POS (Allegato XV, punto 3.2.1) ──────────────────────
const POS_CONTENUTI = [
  { key: 'a', titolo: 'Dati identificativi dell\'impresa esecutrice', dettaglio: 'nominativo del datore di lavoro, indirizzi, sede del cantiere' },
  { key: 'a2', titolo: 'Attività e lavorazioni in cantiere dell\'impresa e dei suoi subappaltatori' },
  { key: 'a3', titolo: 'Addetti al primo soccorso, antincendio ed emergenze', dettaglio: 'nominativi' },
  { key: 'a4', titolo: 'RLS', dettaglio: 'nominativo del rappresentante dei lavoratori per la sicurezza' },
  { key: 'a5', titolo: 'Medico competente', dettaglio: 'nominativo, se previsto' },
  { key: 'a6', titolo: 'RSPP', dettaglio: 'nominativo del responsabile del servizio di prevenzione e protezione' },
  { key: 'a7', titolo: 'Direttore tecnico di cantiere e capocantiere' },
  { key: 'a8', titolo: 'Numero e qualifiche dei lavoratori in cantiere' },
  { key: 'b', titolo: 'Mansioni di sicurezza svolte in cantiere dai lavoratori dell\'impresa' },
  { key: 'c', titolo: 'Descrizione dell\'attività di cantiere, modalità organizzative e turni di lavoro' },
  { key: 'd', titolo: 'Ponteggi, opere provvisionali di rilievo, macchine e impianti utilizzati' },
  { key: 'e', titolo: 'Sostanze e preparati pericolosi utilizzati, con schede di sicurezza' },
  { key: 'f', titolo: 'Esito del rapporto di valutazione del rumore' },
  { key: 'g', titolo: 'Misure preventive e protettive integrative rispetto a quelle del PSC' },
  { key: 'h', titolo: 'Procedure complementari e di dettaglio richieste dal PSC' },
  { key: 'i', titolo: 'Elenco dei dispositivi di protezione individuale forniti ai lavoratori' },
  { key: 'l', titolo: 'Documentazione sull\'informazione e formazione dei lavoratori occupati in cantiere' },
];

// ── Contenuti minimi del PSC (Allegato XV, punto 2.1.2) ──────────────────────
const PSC_CONTENUTI = [
  { key: 'a', titolo: 'Identificazione e descrizione dell\'opera' },
  { key: 'b', titolo: 'Soggetti con compiti di sicurezza' },
  { key: 'c', titolo: 'Rischi dell\'area, dell\'organizzazione, delle lavorazioni e loro interferenze' },
  { key: 'd', titolo: 'Scelte progettuali e organizzative, procedure e misure preventive e protettive' },
  { key: 'e', titolo: 'Prescrizioni operative per le interferenze tra le lavorazioni' },
  { key: 'f', titolo: 'Uso comune di apprestamenti, attrezzature, infrastrutture, mezzi e servizi' },
  { key: 'g', titolo: 'Cooperazione, coordinamento e reciproca informazione' },
  { key: 'h', titolo: 'Pronto soccorso, antincendio ed evacuazione' },
  { key: 'i', titolo: 'Cronoprogramma ed entità presunta in uomini-giorno' },
  { key: 'l', titolo: 'Stima dei costi della sicurezza' },
];

// Uso comune: proposte tipiche (chi installa, chi usa, chi verifica)
const USO_COMUNE = [
  { key: 'ponteggio', titolo: 'Ponteggio', schede: ['ponteggio-montaggio', 'ponteggio-uso'],
    testo: 'Montato, modificato e smontato solo dall\'impresa che lo installa, secondo il PiMUS. Le altre imprese lo usano senza modificarlo; ogni modifica si chiede all\'impresa installatrice. Il preposto dell\'impresa installatrice lo verifica dopo eventi meteo e lunghe interruzioni.' },
  { key: 'impianto_elettrico', titolo: 'Impianto elettrico di cantiere', sempre: true,
    testo: 'Installato e mantenuto dall\'impresa affidataria; le altre imprese si collegano solo ai quadri di cantiere, con prolunghe e attrezzature in buono stato. Nessuno modifica i quadri.' },
  { key: 'servizi', titolo: 'Servizi igienico-assistenziali', sempre: true,
    testo: 'Messi a disposizione dall\'impresa affidataria per tutte le imprese e i lavoratori autonomi; pulizia a carico dell\'affidataria.' },
  { key: 'recinzione', titolo: 'Recinzione e accessi', sempre: true,
    testo: 'Installati e mantenuti dall\'impresa affidataria. Chi apre un varco lo richiude; a fine giornata l\'ultimo preposto in uscita verifica la chiusura.' },
  { key: 'sollevamento', titolo: 'Apparecchi di sollevamento', schede: ['gru-torre-uso', 'gru-torre-montaggio', 'autogru', 'sollevatore-telescopico'],
    testo: 'Usati solo da operatori abilitati dell\'impresa proprietaria; le altre imprese chiedono le movimentazioni al preposto di quell\'impresa, che coordina imbracature e area di manovra.' },
];

module.exports = {
  ORDIGNI,
  ORGANIZZAZIONE, CONTESTO, DA_SOPRALLUOGO, CATEGORIE_COSTI, VOCI_COSTO, TESTI_PROPOSTI,
  POS_CONTENUTI, PSC_CONTENUTI, USO_COMUNE,
};
