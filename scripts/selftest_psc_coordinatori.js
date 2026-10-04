#!/usr/bin/env node
/**
 * scripts/selftest_psc_coordinatori.js — F-270 (AUDIT.md del frontend).
 *
 * Palladia per coordinatori. Senza chiamare l'AI né le mappe (funzioni
 * iniettate o pure), verifica:
 *  - interferenze: sovrapposizione nel tempo + area + imprese diverse; le tre
 *    soluzioni; lo sfasamento temporale non lascia sovrapposizioni; una
 *    decisione "temporale" si riapre se le date tornano a sovrapporsi;
 *  - lavorazioni dal computo: raggruppamento per scheda, uomini-giorno stimati,
 *    cronoprogramma in giorni lavorativi, misure del coordinatore DAVANTI a
 *    quelle proposte e nessuna approvata in automatico;
 *  - costi: voci proposte da lavorazioni/contesto/interferenze, prezzi della
 *    libreria prima di quelli indicativi, totali per categoria e per impresa;
 *  - controllo Allegato XV (a–l) e "riletto come un ispettore";
 *  - XPWE (Primus) e Word (.docx) letti; contesto OpenStreetMap interpretato;
 *  - lettura di vecchi PSC e verifica POS: risposta del modello ricontrollata;
 *  - documento: nel PSC solo le misure approvate; numeri della notifica;
 *  - DB: un coordinatore non vede il PSC di un altro; codice di prova monouso.
 */
'use strict';
require('dotenv').config();
const AdmZip = require('adm-zip');
const supabase = require('../lib/supabase');
const I = require('../lib/psc/interferenze');
const L = require('../lib/psc/lavorazioni');
const C = require('../lib/psc/costi');
const { controlla } = require('../lib/psc/controllo');
const { parseXpwe, docxText } = require('../lib/psc/files');
const { interpreta, chiaviAttive } = require('../lib/psc/contesto');
const imp = require('../lib/psc/importPsc');
const pv = require('../lib/psc/posVerify');
const documento = require('../lib/psc/documento');
const store = require('../lib/psc/store');
const beta = require('../lib/psc/beta');
const { riconosci } = require('../lib/psc/firma');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F270-${Date.now()}`;

function testInterferenze() {
  console.log('\n\x1b[1mInterferenze\x1b[0m');
  const lav = [
    { id: 'a1', nome: 'Ponteggio facciata nord', scheda_id: 'ponteggio-montaggio', area: 'facciata nord', impresa_id: 'i1', start_date: '2026-10-19', end_date: '2026-11-06' },
    { id: 'b2', nome: 'Impianto elettrico', scheda_id: 'impianti-elettrici', area: 'facciata nord', impresa_id: 'i2', start_date: '2026-10-26', end_date: '2026-11-20' },
    { id: 'c3', nome: 'Tinteggiature interne', scheda_id: 'tinteggiature', area: 'aule secondo piano', impresa_id: 'i3', start_date: '2026-10-26', end_date: '2026-11-06' },
    { id: 'd4', nome: 'Intonaci facciata', scheda_id: 'intonaci', area: 'facciata nord', impresa_id: 'i1', start_date: '2026-10-26', end_date: '2026-11-06' },
  ];
  const r = I.detect(lav, []);
  check('ponteggio × elettrico sulla stessa facciata = interferenza', r.aperte.some(x => x.key === 'a1|b2'), r.aperte.map(x => x.key));
  check('aree diverse = nessuna interferenza (tinteggiature interne)', !r.aperte.some(x => x.key.includes('c3') && !x.key.includes('b2')), r.aperte.map(x => x.key));
  check('stessa impresa = nessuna interferenza tra le sue lavorazioni', !r.aperte.some(x => x.key === 'a1|d4'));
  const x = r.aperte.find(y => y.key === 'a1|b2');
  check('rischio: caduta di materiale dall\'alto generato dal ponteggio, gravità alta', x && /caduta di materiale/.test(x.rischio) && x.gravita === 'alta', x);
  check('periodo sovrapposto calcolato', x && x.dal === '2026-10-26' && x.al === '2026-11-06', x);
  const lavById = new Map(lav.map(l => [l.id, l]));
  const sol = I.soluzioni(x, lavById, new Map([['i1', { ragione_sociale: 'Ponteggi Riviera' }]]), '2026-12-23');
  const t = sol.opzioni.find(o => o.soluzione === 'temporale');
  check('tre soluzioni con testo', sol.opzioni.length === 3 && sol.opzioni.every(o => o.testo.length > 20));
  check('temporale: l\'elettrico parte il primo giorno lavorativo dopo il ponteggio (lun 9/11)', t.sposta.lavorazione_id === 'b2' && t.sposta.start_date === '2026-11-09', t.sposta);
  check('temporale consigliato se la fine lavori non si sposta', sol.consigliata === 'temporale' && t.sfora_fine === false);
  check('misure: nomina l\'impresa del ponteggio e la mantovana', /Ponteggi Riviera/.test(sol.opzioni[2].testo) && /mantovana/.test(sol.opzioni[2].testo), sol.opzioni[2].testo);
  const moved = lav.map(l => (l.id === 'b2' ? { ...l, start_date: t.sposta.start_date, end_date: t.sposta.end_date } : l));
  check('dopo lo sfasamento temporale non c\'è più sovrapposizione', !I.detect(moved, []).aperte.some(y => y.key === 'a1|b2'));
  const dec = [{ id: 'd', lav_a: 'a1', lav_b: 'b2', soluzione: 'temporale', testo: 't' }];
  check('decisione temporale + date di nuovo sovrapposte = si riapre', I.detect(lav, dec).aperte.some(y => y.key === 'a1|b2'));
  check('decisione con misure = risolta anche se sovrapposte', !I.detect(lav, [{ ...dec[0], soluzione: 'misure' }]).aperte.some(y => y.key === 'a1|b2'));
  const late = I.soluzioni(x, lavById, new Map(), '2026-11-15');
  check('se lo sfasamento sfora la fine lavori, consiglia le misure', late.consigliata === 'misure' && late.opzioni[0].sfora_fine === true, late.consigliata);
  check('area vuota = compatibile con tutte', I.areasCompatible('', 'facciata sud') && !I.areasCompatible('facciata nord', 'aule'));
}

function testLavorazioni() {
  console.log('\n\x1b[1mLavorazioni dal computo\x1b[0m');
  const voci = [
    { descrizione: 'Demolizione di tramezzi in laterizio', categoria: 'Demolizioni', importo: 8000 },
    { descrizione: 'Rimozione di pavimenti', categoria: 'Demolizioni', importo: 4000 },
    { descrizione: 'Nolo di ponteggio metallico fisso', categoria: 'Opere provvisionali', importo: 12000 },
    { descrizione: 'Rifacimento manto di copertura in coppi', categoria: 'Coperture', importo: 30000 },
    { descrizione: 'Impianto elettrico aule', categoria: 'Impianti', importo: 20000 },
    { descrizione: 'Voce senza parole note', categoria: 'Varie', importo: 1000 },
  ];
  const lib = [{ id: 'L1', kind: 'misura', scheda_id: 'coperture-lavori', testo: 'Parapetti perimetrali su tutto il filo di gronda prima della rimozione del manto.', source_name: 'PSC Scuola Pertini 2025', uses: 4 }];
  const out = L.fromComputo(voci, { start: '2026-10-12', library: lib });
  const names = out.map(l => l.scheda_id || l.nome);
  check('demolizioni raggruppate in una lavorazione', out.filter(l => l.scheda_id === 'demolizioni-interne').length === 1, names);
  check('ponteggio riconosciuto prima di altre parole', out.some(l => l.scheda_id === 'ponteggio-montaggio'), names);
  check('allestimento aggiunto in testa al cronoprogramma', out[0].scheda_id === 'allestimento-cantiere', names);
  check('voce sconosciuta resta come lavorazione libera della sua categoria', out.some(l => !l.scheda_id && l.nome === 'Varie'), names);
  const cop = out.find(l => l.scheda_id === 'coperture-lavori');
  check('uomini-giorno stimati da importo × incidenza / giornata', cop && Math.abs(cop.uomini_giorno - Math.round(30000 * 0.35 / 256 * 2) / 2) < 0.01, cop && cop.uomini_giorno);
  check('misure del coordinatore DAVANTI, con il nome del PSC da cui vengono', cop.misure[0].fonte === 'mia' && cop.misure[0].fonte_nome === 'PSC Scuola Pertini 2025', cop.misure[0]);
  check('nessuna misura approvata in automatico', out.every(l => l.misure.every(m => m.approvata === false)));
  check('rischi valutati P×D con livello', cop.rischi.every(r => r.r === r.p * r.d && r.livello));
  check('date in giorni lavorativi (mai sabato o domenica)', out.every(l => ![0, 6].includes(new Date(`${l.start_date}T12:00:00Z`).getUTCDay()) && ![0, 6].includes(new Date(`${l.end_date}T12:00:00Z`).getUTCDay())), out.map(l => [l.start_date, l.end_date]));
  const el = out.find(l => l.scheda_id === 'impianti-elettrici');
  const prev = out[out.indexOf(el) - 1];
  check('impianti in parallelo alla fase precedente (interferenza visibile al coordinatore)', el.start_date === prev.start_date, [prev.nome, prev.start_date, el.start_date]);
  check('addWorkdays: 5 giorni da venerdì = giovedì dopo', L.addWorkdays('2026-10-16', 5) === '2026-10-22', L.addWorkdays('2026-10-16', 5));
}

function testCosti() {
  console.log('\n\x1b[1mCosti della sicurezza\x1b[0m');
  const project = { start_date: '2026-10-12', end_date: '2026-12-23' };
  const lav = [{ scheda_id: 'ponteggio-montaggio' }, { scheda_id: 'coperture-lavori' }];
  const lib = [{ kind: 'costo', testo: 'Bagno chimico (mio prezzario)', data: { key: 'wc', um: 'mese', prezzo: 165 } }];
  const rows = C.proponi({ project, lavorazioni: lav, contestoKeys: new Set(['strada_traffico']), decisioni: [{ soluzione: 'misure' }], nImprese: 4, library: lib });
  const keys = rows.map(r => r.origine);
  check('sempre: recinzione, baracca, wc, terra, estintori, riunioni', ['recinzione', 'baracca', 'wc', 'terra', 'estintori', 'riunioni'].every(k => keys.includes(`catalogo:${k}`)), keys);
  check('dal ponteggio: ponteggio, mantovana, teli', ['ponteggio', 'mantovana', 'teli'].every(k => keys.includes(`catalogo:${k}`)));
  check('dalla copertura: parapetti e linea vita', ['parapetti', 'linea_vita'].every(k => keys.includes(`catalogo:${k}`)));
  check('dalla strada trafficata: segnaletica e moviere', ['segnaletica_stradale', 'moviere'].every(k => keys.includes(`catalogo:${k}`)));
  check('scavi assenti: niente armature', !keys.includes('catalogo:armatura_scavi'));
  const wc = rows.find(r => r.origine === 'catalogo:wc');
  check('prezzo e testo della libreria del coordinatore prima dell\'indicativo', wc.prezzo === 165 && wc.prezzo_fonte === 'libreria' && /mio prezzario/.test(wc.descrizione), wc);
  check('quantità mesi = durata lavori (ott–dic = 3)', wc.quantita === 3, wc.quantita);
  check('riunioni = (settimane/2 + 1) × imprese', rows.find(r => r.origine === 'catalogo:riunioni').quantita === (Math.ceil(Math.ceil((Date.parse('2026-12-23') - Date.parse('2026-10-12')) / (7 * 86400000)) / 2) + 1) * 4);
  check('voci già presenti non si ripropongono', C.proponi({ project, lavorazioni: lav, esistenti: rows }).length === 0);
  const riep = C.riepilogo([{ categoria: 'a', quantita: 2, prezzo: 10.5, impresa_id: 'i1', prezzo_fonte: 'manuale' }, { categoria: 'g', quantita: 3, prezzo: 35, impresa_id: null, prezzo_fonte: 'indicativo' }, { categoria: 'a', quantita: 0, prezzo: 12, prezzo_fonte: 'indicativo' }], [{ id: 'i1', ragione_sociale: 'Edil' }]);
  check('totali: 21 + 105 = 126, per impresa 21, da ripartire 105', riep.totale === 126 && riep.perImpresa[0].importo === 21 && riep.daRipartire === 105, riep);
  check('conta prezzi indicativi e voci senza quantità', riep.indicativi === 2 && riep.daMisurare === 1, riep);
}

function testControllo() {
  console.log('\n\x1b[1mControllo Allegato XV e "ispettore"\x1b[0m');
  const project = {
    address: 'Via Roma 12', descrizione: 'Ristrutturazione interna della scuola', start_date: '2026-10-12', end_date: '2026-12-23',
    soggetti: { committente: { nome: 'Comune' }, cse: { nome: 'Ing. Bianchi' }, csp: { nome: 'Ing. Bianchi' } },
    contesto: { analizzato: true, da_sopralluogo: [{ key: 'linee_aeree', titolo: 'Linee elettriche aeree', verificato: false }] },
    organizzazione: { a: { testo: 'xxxxxxxxxxxx' }, b: { testo: 'xxxxxxxxxxxx' }, c: { testo: 'xxxxxxxxxxxx' }, d: { testo: 'xxxxxxxxxxxx' } },
    uso_comune: [{ titolo: 'x', testo: 'Testo uso comune abbastanza lungo' }], coordinamento: {}, emergenze: { procedura: 'p'.repeat(30), gestione: 'g'.repeat(30), pronto_soccorso: { nome: 'Galliera' } },
  };
  const lavorazioni = [
    { nome: 'Copertura', rischi: [{ testo: 'r' }], misure: [{ testo: 'Linea vita provvisoria sul colmo', approvata: true }], start_date: '2026-10-20', end_date: '2026-12-30', uomini_giorno: 40 },
  ];
  const costi = [{ descrizione: 'Recinzione', quantita: 10, prezzo: 12, prezzo_fonte: 'indicativo', categoria: 'a' }];
  const riep = C.riepilogo(costi, []);
  const lib = [{ kind: 'frase', sezione: 'coordinamento', testo: 'Riunione ogni due settimane con verbale firmato.', uses: 6 }];
  const r = controlla({ project, lavorazioni, imprese: [], costi, decisioni: [{ soluzione: 'misure', testo: 'mantovana parasassi e area interdetta' }], interferenzeAperte: [], library: lib, riep });
  const g = r.contenuti.find(c => c.key === 'g');
  check('10 contenuti minimi a–l', r.contenuti.length === 10 && r.contenuti.map(c => c.key).join('') === 'abcdefghil');
  check('g) mancante propone la frase più usata del coordinatore', !g.ok && g.proposta && /due settimane/.test(g.proposta.testo), g);
  check('b) segnala l\'impresa affidataria mancante', r.contenuti.find(c => c.key === 'b').mancanze.some(m => /affidataria/.test(m)));
  check('i) riporta gli uomini-giorno', r.contenuti.find(c => c.key === 'i').valore === '40 uomini-giorno');
  const oss = r.osservazioni.map(o => o.testo).join(' | ');
  check('ispettore: mantovana prevista ma non nei costi', /mantovana/i.test(oss), oss);
  check('ispettore: linea vita nelle misure ma non nei costi', /linea vita/i.test(oss), oss);
  check('ispettore: lavorazione oltre la fine lavori', /dopo la fine lavori/.test(oss), oss);
  check('ispettore: prezzi indicativi segnalati', /prezzo indicativo/.test(oss), oss);
  check('ispettore: cose da verificare al sopralluogo', /linee elettriche aeree/.test(oss), oss);
  check('si può firmare con punti aperti (restano nella revisione)', r.puoFirmare === true && r.aperti.length >= 1);
}

function testFiles() {
  console.log('\n\x1b[1mXPWE e Word\x1b[0m');
  const xml = `<?xml version="1.0"?><PweDocumento><PweDatiGenerali><PweDGProgetto><PweDGDatiGenerali><Oggetto>Scuola Mazzini</Oggetto></PweDGDatiGenerali></PweDGProgetto>
  <PweDGCapitoliCategorie><PweDGCategorie><DGCategorieItem ID="1"><DesSintetica>Demolizioni</DesSintetica></DGCategorieItem></PweDGCategorie></PweDGCapitoliCategorie></PweDatiGenerali>
  <PweMisurazioni><PweElencoPrezzi><EPItem ID="7"><Tariffa>LIG.A.10</Tariffa><DesEstesa>Demolizione di tramezzi</DesEstesa><UnMisura>m²</UnMisura><Prezzo1>12,50</Prezzo1></EPItem>
  <EPItem ID="8"><Tariffa>LIG.B.20</Tariffa><DesEstesa>Ponteggio metallico fisso</DesEstesa><UnMisura>m²</UnMisura><Prezzo1>9</Prezzo1></EPItem></PweElencoPrezzi>
  <PweVociComputo><VCItem ID="1"><IDEP>7</IDEP><Quantita>100</Quantita><IDCat>1</IDCat></VCItem><VCItem ID="2"><IDEP>8</IDEP><Quantita>250.5</Quantita></VCItem></PweVociComputo></PweMisurazioni></PweDocumento>`;
  const r = parseXpwe(Buffer.from(xml));
  check('XPWE: due voci con codice, quantità, prezzo (virgola decimale) e importo', r.voci.length === 2 && r.voci[0].codice === 'LIG.A.10' && r.voci[0].importo === 1250 && r.voci[1].importo === 2254.5, r.voci);
  check('XPWE: categoria e titolo dell\'opera', r.voci[0].categoria === 'Demolizioni' && r.nome === 'Scuola Mazzini', r);
  let threw = false; try { parseXpwe(Buffer.from('<html></html>')); } catch (e) { threw = e.status === 400; }
  check('file che non è un XPWE: errore chiaro 400', threw);
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>PIANO DI SICUREZZA</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Riunione &amp; verbale</w:t></w:r><w:tab/><w:r><w:t>ogni due settimane</w:t></w:r></w:p></w:body></w:document>'));
  const d = docxText(zip.toBuffer());
  check('Word: paragrafi, entità e tabulazioni', d.text === 'PIANO DI SICUREZZA\nRiunione & verbale ogni due settimane', d.text);
}

function testContesto() {
  console.log('\n\x1b[1mContesto da OpenStreetMap\x1b[0m');
  const lat = 44.4054, lon = 8.9397;
  const els = [
    { type: 'way', center: { lat: 44.40545, lon: 8.93975 }, tags: { highway: 'primary', name: 'Via XX Settembre' } },
    { type: 'way', center: { lat: 44.4058, lon: 8.9399 }, tags: { highway: 'residential', name: 'Via Laterale' } },
    { type: 'node', lat: 44.4060, lon: 8.9400, tags: { highway: 'bus_stop', name: 'Fermata 1' } },
    { type: 'way', center: { lat: 44.40541, lon: 8.93971 }, tags: { amenity: 'school', name: 'Scuola Mazzini' } },
    { type: 'way', center: { lat: 44.4065, lon: 8.9410 }, tags: { power: 'line' } },
  ];
  const r = interpreta(els, lat, lon);
  const keys = r.trovati.map(t => t.key);
  check('strada trafficata, fermata, scuola, linea elettrica trovate', ['strada_traffico', 'fermata_bus', 'scuola', 'linee_aeree'].every(k => keys.includes(k)), keys);
  check('la strada trafficata assorbe quella semplice', !keys.includes('strada'));
  check('cantiere dentro una scuola → suggerisce la domanda "edificio in uso"', r.dentroScuola === true);
  check('ogni dato porta fonte e distanza', r.trovati.every(t => t.fonte === 'OpenStreetMap' && Number.isInteger(t.distanza_m)));
  check('linea mappata: "va verificata al sopralluogo", mai data per certa', /verificata al sopralluogo/.test(r.trovati.find(t => t.key === 'linee_aeree').dettaglio));
  const att = chiaviAttive({ trovati: [{ key: 'strada', attivo: true }, { key: 'scuola', attivo: false }], domande: { edificio_in_uso: true } });
  check('chiavi attive: voci accese + risposte sì', att.has('strada') && !att.has('scuola') && att.has('edificio_in_uso'));
}

function testAiSanitize() {
  console.log('\n\x1b[1mRisposte del modello ricontrollate\x1b[0m');
  const raw = {
    e_un_psc: true, opera: 'Ristrutturazione Scuola Pertini', anno: 2025,
    lavorazioni: [{ nome: 'Rifacimento copertura', rischi: ['Caduta dall\'alto'], misure: ['Parapetti su tutto il perimetro prima della rimozione del manto', 'x'], pagina: 999 }],
    frasi: [{ sezione: 'coordinamento', testo: 'Riunione di coordinamento ogni due settimane con verbale.' }, { sezione: 'inventata', testo: 'Testo con sezione non ammessa dal tool.' }],
    costi: [{ descrizione: 'Bagno chimico nolo mensile', um: 'mese', prezzo: 160, tipo: 'wc' }, { descrizione: 'Voce', prezzo: -5, tipo: 'boh' }],
  };
  const s = imp.sanitize(raw, 40);
  check('pagina oltre la fine del documento scartata', s.lavorazioni[0].pagina === null);
  check('misura troppo corta scartata', s.lavorazioni[0].misure.length === 1);
  check('sezione non ammessa scartata', s.frasi.length === 1);
  check('prezzo negativo → nullo; tipo sconosciuto → altro; descrizione corta scartata', s.costi.length === 1 && s.costi[0].tipo === 'wc');
  const rows = imp.libraryRows('c1', 'imp1', imp.sourceNameOf('vecchio.pdf', s), s);
  check('libreria: lavorazione, misura con scheda riconosciuta, frase, costo con chiave', rows.some(r => r.kind === 'misura' && r.scheda_id === 'coperture-lavori') && rows.some(r => r.kind === 'frase') && rows.some(r => r.kind === 'costo' && r.data.key === 'wc'), rows.map(r => [r.kind, r.scheda_id]));
  check('nome della fonte leggibile: "PSC Ristrutturazione Scuola Pertini 2025"', rows[0].source_name === 'PSC Ristrutturazione Scuola Pertini 2025', rows[0].source_name);

  const presc = [{ id: 'int-1', titolo: 'interferenza Ponteggio × Elettrico', testo: 'Elettro Sud dal 9 novembre' }];
  const pos = pv.sanitize({
    e_un_pos: true,
    contenuti: [{ key: 'a', presente: true, pagina: 2 }, { key: 'i', presente: false, nota: 'Elenco DPI assente' }, { key: 'zz', presente: true }],
    lavoratori: [{ nome: 'Marco Ferri', formazione: ['Preposto'] }, { nome: 'Luca Neri', formazione: ['Ponteggi PiMUS'] }],
    attrezzature: [{ nome: 'Piattaforma elevabile', verifiche_indicate: false, pagina: 18 }],
    lavorazioni: ['Montaggio ponteggio facciata'],
    prescrizioni: [{ id: 'int-1', recepita: false }, { id: 'inventata', recepita: true }],
  }, 30, presc);
  const checks = pv.controlli(pos, { lavorazioniImpresa: [{ nome: 'Ponteggio facciata nord', scheda_id: 'ponteggio-montaggio' }], prescrizioni: presc });
  const t = checks.map(c => `${c.esito}:${c.titolo}`).join(' | ');
  check('POS: contenuto minimo mancante (DPI) con nota', checks.some(c => c.esito === 'manca' && /dispositivi di protezione/.test(c.titolo)), t);
  check('POS: PLE senza nessun lavoratore abilitato', checks.some(c => c.esito === 'manca' && /abilitato PLE/.test(c.titolo)), t);
  check('POS: piattaforma senza verifica periodica, con pagina', checks.some(c => c.esito === 'da_verificare' && /verifica periodica/.test(c.titolo) && c.pagina === 18), t);
  check('POS: prescrizione dell\'interferenza non recepita', checks.some(c => c.esito === 'manca' && /Non recepita/.test(c.titolo)), t);
  check('POS: formazione ponteggi presente (richiesta dalla scheda)', checks.some(c => c.esito === 'ok' && /montaggio e smontaggio dei ponteggi/.test(c.titolo)), t);
  check('POS: chiave inventata dal modello ignorata', !pos.contenuti.has('zz') && !pos.prescrizioni.has('inventata'));
  const msg = pv.messaggio({ impresa: 'Ponteggi Riviera', cantiere: 'Scuola', cse: 'Ing. Bianchi', esitoCheck: checks });
  check('messaggio pronto: elenca cosa integrare con le pagine', /integrarlo/.test(msg) && /pag\. 18/.test(msg) && /Ing\. Bianchi$/.test(msg), msg);
}

function testDocumento() {
  console.log('\n\x1b[1mDocumento\x1b[0m');
  const snap = {
    project: { title: 'Scuola Mazzini', address: 'Via Roma 1', comune: 'Genova', start_date: '2026-10-12', end_date: '2026-12-23', revision: 1, soggetti: { cse: { nome: 'Ing. Laura Bianchi', telefono: '010 1' }, committente: { nome: 'Comune di Genova' } }, contesto: { trovati: [{ key: 'scuola', titolo: 'Scuola vicina', misure: 'Niente mezzi all\'uscita', attivo: true }, { key: 'strada', titolo: 'Strada spenta', misure: 'x', attivo: false }] }, organizzazione: {}, emergenze: { pronto_soccorso: { nome: 'Galliera', distanza_km: 0.9, minuti: 3 } }, coordinamento: { riunioni: 'Ogni due settimane' } },
    lavorazioni: [{ id: 'l1', nome: 'Copertura', ordine: 0, start_date: '2026-10-12', end_date: '2026-10-30', addetti: 4, uomini_giorno: 60, rischi: [{ testo: 'Caduta', p: 3, d: 4, r: 12, livello: 'Molto alto' }], misure: [{ testo: 'MISURA-APPROVATA', approvata: true }, { testo: 'MISURA-NON-APPROVATA', approvata: false }] },
      { id: 'l2', nome: 'Elettrico', ordine: 1, start_date: '2026-10-20', end_date: '2026-11-10', addetti: 2 }],
    imprese: [{ id: 'i1', ragione_sociale: 'Edil Rossi', ruolo: 'affidataria' }], costi: [{ categoria: 'a', descrizione: 'Recinzione', quantita: 100, prezzo: 12, ordine: 0 }], decisioni: [], revisioni: [],
  };
  const html = documento.pscHtml(snap, { pagine: { 1: 2, 10: 9 } });
  check('nel PSC solo le misure approvate', html.includes('MISURA-APPROVATA') && !html.includes('MISURA-NON-APPROVATA'));
  check('rischi del contesto spenti esclusi', html.includes('Scuola vicina') && !html.includes('Strada spenta'));
  check('indice con i numeri di pagina', /<b>10<\/b>Costi della sicurezza<em>9<\/em>/.test(html));
  check('totale costi 1.200,00 € e "non soggetti a ribasso"', html.includes('1.200,00') && /non soggetti a ribasso/.test(html));
  check('pronto soccorso con distanza e tempo', /Galliera.*0,9 km, 3 minuti/.test(html));
  check('copertina con @page 26/24 mm e cover 247 mm (regola PDF fissa)', html.includes('@page { size: A4; margin: 26mm 0 24mm 0; }') && html.includes('height: 247mm !important'));
  const snap2 = { ...snap, project: { ...snap.project, organizzazione: { recinzione: { attivo: true, testo: 'ORG-APPROVATA', approvata: true }, servizi: { attivo: true, testo: 'ORG-PROPOSTA', approvata: false } }, coordinamento: { riunioni: 'RIUNIONI-PROPOSTE', approvato: false }, uso_comune: [{ titolo: 'Ponteggio', testo: 'USO-PROPOSTO', approvata: false }] } };
  const html2 = documento.pscHtml(snap2);
  check('organizzazione: nel PDF solo le voci approvate', html2.includes('ORG-APPROVATA') && !html2.includes('ORG-PROPOSTA'));
  check('coordinamento e uso comune proposti e non approvati restano fuori', !html2.includes('RIUNIONI-PROPOSTE') && !html2.includes('USO-PROPOSTO'));
  const n = documento.notificaDati(snap);
  check('notifica: numero massimo lavoratori contemporanei (4+2 = 6)', n.find(r => r[0] === '10')[2] === '6', n.find(r => r[0] === '10'));
  check('notifica: 13 voci dell\'Allegato XII', n.length === 13);
  const word = documento.pscWord(snap);
  check('Word: involucro che Word apre come documento', word.startsWith('<html xmlns:o="urn:schemas-microsoft-com:office:office"') && word.includes('MISURA-APPROVATA'));
  check('fascicolo: scheda copertura per i lavori successivi', /Copertura/.test(documento.fascicoloHtml(snap)) && /UNI EN 795/.test(documento.fascicoloHtml(snap)));
  check('firma: un PDF senza firma non viene preso per firmato', riconosci(Buffer.from('%PDF-1.4 niente firma'), 'x.pdf') === null);
  check('firma: PAdES riconosciuto con nome e data', (() => { const r = riconosci(Buffer.from('%PDF-1.7 /Type /Sig /SubFilter /ETSI.CAdES.detached /ByteRange [0 1 2 3] /Name (Laura Bianchi) /M (D:20261012103000+02\'00\')'), 'f.pdf'); return r && r.tipo === 'PAdES' && r.firmatari[0].nome === 'Laura Bianchi' && r.firmatari[0].quando.startsWith('2026-10-12'); })());
}

async function testDb() {
  console.log('\n\x1b[1mDB: isolamento e codice di prova\x1b[0m');
  const mk = async (name) => { const { data, error } = await supabase.from('companies').insert({ name, account_type: 'coordinatore' }).select().single(); if (error) throw error; return data; };
  const c1 = await mk(`${T}-cse1`), c2 = await mk(`${T}-cse2`);
  let code = null;
  try {
    const { data: p1, error } = await supabase.from('psc_projects').insert({ company_id: c1.id, title: `${T} cantiere` }).select().single();
    if (error) throw error;
    check('il coordinatore vede il suo PSC', !!(await store.loadAll(c1.id, p1.id)));
    check('un altro coordinatore NON vede quel PSC', (await store.loadAll(c2.id, p1.id)) === null);
    check('id non valido: nessuna query, null', (await store.getProject(c1.id, 'not-a-uuid')) === null);
    // Lettura diretta con chiave anon: RLS senza policy = niente
    const ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (ANON) {
      const { createClient } = require('@supabase/supabase-js');
      const anon = createClient(process.env.SUPABASE_URL, ANON);
      const { data: leak } = await anon.from('psc_projects').select('id').eq('id', p1.id);
      check('RLS: con la chiave pubblica il PSC non si legge', !leak || leak.length === 0, leak);
    }
    code = beta.newCode();
    await supabase.from('psc_beta_invites').insert({ code, note: T });
    check('codice di prova valido', (await beta.checkCode(code.toLowerCase())).ok === true);
    check('attivazione: codice usato, modulo acceso, prova 90 giorni', await beta.activate(c1.id, code));
    const { data: ff } = await supabase.from('company_feature_flags').select('enabled').eq('company_id', c1.id).eq('feature', 'psc_coordinatori').maybeSingle();
    check('flag psc_coordinatori acceso per quella sola company', ff && ff.enabled === true);
    check('lo stesso codice non vale una seconda volta', (await beta.checkCode(code)).reason === 'GIA_USATO' && (await beta.activate(c2.id, code)) === false);
    check('codice inventato rifiutato', (await beta.checkCode('CSE-AAAA-BBBB')).ok === false);
  } finally {
    if (code) await supabase.from('psc_beta_invites').delete().eq('code', code);
    await supabase.from('company_feature_flags').delete().in('company_id', [c1.id, c2.id]);
    await supabase.from('psc_projects').delete().in('company_id', [c1.id, c2.id]);
    await supabase.from('companies').delete().in('id', [c1.id, c2.id]);
  }
}

function testParte2() {
  console.log('\n\x1b[1mParte 2: ordigni, segnalazioni, accettazione\x1b[0m');
  const base = { address: 'Via Roma 1', descrizione: 'Nuova palazzina con scavo di fondazione', start_date: '2026-10-12', end_date: '2026-12-23', soggetti: {}, contesto: { analizzato: true }, organizzazione: {}, emergenze: {}, coordinamento: {} };
  const scavo = [{ nome: 'Scavo', scheda_id: 'scavo-sbancamento', rischi: [{ testo: 'r' }], misure: [{ testo: 'm', approvata: true }] }];
  const c1 = controlla({ project: base, lavorazioni: scavo, imprese: [], costi: [], decisioni: [], interferenzeAperte: [], library: [], riep: C.riepilogo([], []) });
  check('scavi senza valutazione ordigni bellici → manca in c)', c1.contenuti.find(c => c.key === 'c').mancanze.some(m => /ordigni bellici/.test(m)));
  const c2 = controlla({ project: { ...base, contesto: { analizzato: true, ordigni: { esito: 'trascurabile' } } }, lavorazioni: scavo, imprese: [], costi: [], decisioni: [], interferenzeAperte: [], library: [], riep: C.riepilogo([], []) });
  check('con valutazione "trascurabile" non manca più', !c2.contenuti.find(c => c.key === 'c').mancanze.some(m => /ordigni/.test(m)));
  const c3 = controlla({ project: { ...base, contesto: { analizzato: true, ordigni: { esito: 'nessuno_scavo' } } }, lavorazioni: scavo, imprese: [], costi: [], decisioni: [], interferenzeAperte: [], library: [], riep: C.riepilogo([], []) });
  check('"nessuno scavo" mentre ci sono scavi: segnalato', c3.contenuti.find(c => c.key === 'c').mancanze.some(m => /ordigni/.test(m)));
  const html = documento.pscHtml({ project: { title: 'X', soggetti: {}, contesto: { ordigni: { esito: 'bonifica' } }, organizzazione: {}, emergenze: {}, coordinamento: {} }, lavorazioni: [], imprese: [], costi: [], decisioni: [], revisioni: [] });
  check('PSC: sezione ordigni bellici con il testo della bonifica', /ordigni bellici inesplosi/.test(html) && /bonifica bellica sistematica/.test(html));
  const p = { title: 'Scuola', address: 'Via Roma 1, Genova', comune: 'Genova', soggetti: { cse: { nome: 'Ing. Bianchi' } } };
  const t1 = documento.testoSegnalazione({ project: p, impresa: { ragione_sociale: 'Ponteggi Riviera' }, nc: [{ descrizione: 'Manca il parapetto' }], destinatario: 'committente', proposta: 'allontanamento' });
  check('lettera al committente: art. 92 c.1 e, inosservanze, proposta scelta', /art\. 92, comma 1, lettera e\)/.test(t1) && /Manca il parapetto/.test(t1) && /allontanamento dell'impresa/.test(t1));
  check('indirizzo senza comune ripetuto nella lettera', /Via Roma 1, Genova\./.test(t1) && !/Genova, Genova/.test(t1));
  const t2 = documento.testoSegnalazione({ project: p, impresa: null, nc: [], destinatario: 'asl', precedente: '2026-10-05T10:00:00Z' });
  check('lettera all\'ASL: committente inadempiente, data della segnalazione precedente', /non ha adottato alcun provvedimento/.test(t2) && /05\/10\/2026/.test(t2) && /Ispettorato/.test(t2));
  const acc = controlla({ project: base, lavorazioni: [], imprese: [{ ragione_sociale: 'Edil', invite_token: 'x', psc_accettato_rev: null, ruolo: 'affidataria' }], costi: [], decisioni: [], interferenzeAperte: [], library: [], riep: C.riepilogo([], []), revisioni: [{ revision: 1 }] });
  check('ispettore: impresa invitata che non ha accettato l\'ultima revisione', acc.osservazioni.some(o => /non ha ancora accettato il PSC rev\. 1/.test(o.testo)), acc.osservazioni.map(o => o.testo));
}

async function testDb2() {
  console.log('\n\x1b[1mParte 2 su DB: esempio e "Da fare" dell\'impresa\x1b[0m');
  const mk = async (name, account_type) => { const { data, error } = await supabase.from('companies').insert({ name, account_type }).select().single(); if (error) throw error; return data; };
  const cse = await mk(`${T}-cse-es`, 'coordinatore');
  const imp = await mk(`${T}-impresa`, 'impresa');
  try {
    const { creaEsempio } = require('../lib/psc/esempio');
    const ex = await creaEsempio(cse.id, { id: '00000000-0000-0000-0000-000000000000', email: 'cse@test.it' });
    const all = await store.loadAll(cse.id, ex.id);
    const st = await store.stato(cse.id, all);
    check('esempio: 7 lavorazioni, 3 imprese senza email, costi, 1 interferenza decisa e 2 da provare', all.lavorazioni.length === 7 && all.imprese.length === 3 && all.imprese.every(i => !i.email) && all.costi.length > 10 && all.decisioni.length === 1 && st.interferenze.aperte.length === 2, { l: all.lavorazioni.length, i: all.imprese.length, d: all.decisioni.length, a: st.interferenze.aperte.length });
    check('esempio: tutte le misure approvate, marcato come esempio', all.lavorazioni.every(l => l.misure.every(m => m.approvata)) && all.project.esempio === true);
    // impresa collegata a un invito
    const im = all.imprese[1];
    await supabase.from('psc_imprese').update({ linked_company_id: imp.id, invite_token: `${T}tok`.replace(/[^A-Za-z0-9]/g, '').padEnd(24, 'x'), pos_status: 'richiesto', pos_due_date: '2026-10-09' }).eq('id', im.id);
    await supabase.from('psc_nc').insert({ project_id: ex.id, company_id: cse.id, impresa_id: im.id, descrizione: 'Manca il parapetto', sospensione: true, close_token: `${T}nc`.replace(/[^A-Za-z0-9]/g, '').padEnd(24, 'y') });
    const { buildDaFare } = require('../lib/daFare');
    const df = await buildDaFare(imp.id, null, { todayStr: '2026-10-10' });
    const items = (df.items || df).filter ? (df.items || df) : [];
    const coord = items.filter(i => i.kind === 'coordinatore');
    check('Da fare dell\'impresa: POS richiesto (in ritardo, urgente) con link al suo invito', coord.some(i => i.type === 'pos_richiesto' && i.urgent && /^\/psc\/invito\//.test(i.link)), coord);
    check('Da fare dell\'impresa: lavorazione sospesa con link per chiuderla', coord.some(i => i.type === 'non_conformita' && i.severity === 'critical' && /^\/psc\/nc\//.test(i.link)));
    const df2 = await buildDaFare(cse.id, null, { todayStr: '2026-10-10' });
    check('il Da fare di altre aziende non vede niente', !((df2.items || df2).filter ? (df2.items || df2) : []).some(i => i.kind === 'coordinatore'));
  } finally {
    await supabase.from('psc_projects').delete().eq('company_id', cse.id);
    await supabase.from('companies').delete().in('id', [cse.id, imp.id]);
  }
}

(async () => {
  console.log('\x1b[1mF-270 — Palladia per coordinatori\x1b[0m');
  testInterferenze(); testLavorazioni(); testCosti(); testControllo(); testFiles(); testContesto(); testAiSanitize(); testDocumento();
  testParte2();
  await testDb();
  await testDb2();
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
