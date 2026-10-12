'use strict';
// ── Contenuti del PDF del POS che dipendono dal cantiere (F-342 / F-343) ────
// Verifica del 12/10 (AUDIT.md del frontend): tabelle fisse uguali per tutti i
// POS (gru a torre "biennale" anche dove non c'è una gru, resine e amianto
// dove non si usano, rifiuti senza le guaine rimosse), norme superate
// (Accordi Stato-Regioni 2011 e 2012), nessuna formazione reale dei
// lavoratori. Qui ogni tabella si costruisce da ciò che il POS dice davvero:
// macchine, sostanze, lavorazioni (schede), lavoratori.
// Un POS del vecchio generatore (/pos/nuovo, Ladia) non porta questi campi:
// per lui restano le tabelle generali, con le norme aggiornate.
const { getScheda } = require('./lavorazioniSchede');

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const ph = '<span class="placeholder">[DA COMPILARE]</span>';
const fmtD = (iso) => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d && m && y ? `${d}/${m}/${y}` : String(iso); };
const oggi = () => new Date().toISOString().slice(0, 10);

/** Il POS viene dal nuovo percorso (/pos/crea) e porta macchine/sostanze/schede reali? */
const nuovoPercorso = (d) => Array.isArray(d.selectedSchede) || Array.isArray(d.sostanze);
const schede = (d) => (Array.isArray(d.selectedSchede) ? d.selectedSchede : []).map(id => getScheda(id)).filter(Boolean);
const testoLavori = (d) => [
  ...(d.macchine || []), ...(d.opereProvvisionali || []), ...(d.impiantiCantiere || []), d.lavoriInQuota || '',
  ...(d.selectedWorks || []), ...schede(d).map(s => `${s.id} ${s.nome}`),
].join(' | ').toLowerCase();

// ── 2.2 Lavoratori, con formazione e idoneità ────────────────────────────────
function scad(label, iso) {
  if (!iso) return `${label}: da verificare`;
  return iso < oggi() ? `${label}: <strong>scaduta il ${esc(fmtD(iso))}</strong>` : `${label}: valida fino al ${esc(fmtD(iso))}`;
}
function tabellaLavoratori(d) {
  const ws = Array.isArray(d.workers) ? d.workers : [];
  if (!ws.length) {
    return `<table class="allow-break"><thead><tr><th style="width:6%">N.</th><th style="width:40%">Nominativo</th><th>Qualifica</th></tr></thead>
<tbody><tr><td>1</td><td>${ph}</td><td>${ph}</td></tr></tbody></table>`;
  }
  const conMatricola = ws.some(w => w.matricola);
  const conFormazione = ws.some(w => Array.isArray(w.corsi) || 'formazioneScad' in w || 'idoneitaScad' in w);
  const head = `<th style="width:5%">N.</th><th style="width:${conFormazione ? 24 : 35}%">Nominativo</th><th style="width:${conFormazione ? 18 : 30}%">Qualifica</th>`
    + (conMatricola ? '<th style="width:13%">Matricola</th>' : '')
    + (conFormazione ? '<th>Formazione e idoneità (registro Palladia)</th>' : '');
  const rows = ws.map((w, i) => {
    const corsi = Array.isArray(w.corsi) && w.corsi.length ? esc(w.corsi.join(', ')) : 'Nessun corso specifico registrato';
    return `<tr><td>${i + 1}</td><td>${w.name ? esc(w.name) : ph}</td><td>${w.qualification ? esc(w.qualification) : ph}</td>`
      + (conMatricola ? `<td>${w.matricola ? esc(w.matricola) : '—'}</td>` : '')
      + (conFormazione ? `<td>${corsi}<br>${scad('Formazione sicurezza', w.formazioneScad)}<br>${scad('Idoneità sanitaria', w.idoneitaScad)}</td>` : '')
      + '</tr>';
  }).join('');
  return `<table class="allow-break"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ── 2.4 Senza fasi del PSC: le lavorazioni nell'ordine scelto ───────────────
function lavorazioniPreviste(d) {
  const nomi = schede(d).map(s => s.nome);
  const lista = nomi.length ? nomi : (d.selectedWorks || []);
  if (!lista.length) return '<p class="muted">Nessuna fase di lavoro inserita.</p>';
  return `<p>Lavorazioni previste dall'impresa in questo cantiere:</p><ol style="margin-left:16pt;">${lista.map(n => `<li>${esc(n)}</li>`).join('')}</ol>
<p class="muted">Fasi operative, rischi e misure di ciascuna lavorazione sono descritti nella Sezione 5. Tempi e sovrapposizioni seguono il cronoprogramma del PSC, ove presente, e le indicazioni del CSE.</p>`;
}

// ── 9.2 Verifiche delle attrezzature ─────────────────────────────────────────
const VERIFICHE = [
  { re: /gru a torre|gru-torre/, row: ['Gru a torre', 'Prima verifica INAIL e verifiche periodiche', 'Annuale (settore costruzioni)', 'Art. 71 c. 11 e All. VII D.lgs 81/08'] },
  { re: /autogru|gru su autocarro|gru mobile/, row: ['Gru mobile o su autocarro', 'Prima verifica INAIL e verifiche periodiche', 'Annuale (settore costruzioni)', 'Art. 71 c. 11 e All. VII D.lgs 81/08'] },
  { re: /\bple\b|piattaforma elevabile/, row: ['Piattaforma di lavoro elevabile (PLE)', 'Prima verifica INAIL e verifiche periodiche', 'Annuale', 'Art. 71 c. 11 e All. VII D.lgs 81/08'] },
  { re: /montacarichi|argano/, row: ['Montacarichi e argani (portata oltre 200 kg)', 'Prima verifica INAIL e verifiche periodiche', 'Annuale (settore costruzioni)', 'Art. 71 c. 11 e All. VII D.lgs 81/08'] },
  { re: /sollevatore telescopico|carrello elevatore/, row: ['Sollevatore telescopico / carrello elevatore', 'Prima verifica INAIL e verifiche periodiche', 'Annuale', 'Art. 71 c. 11 e All. VII D.lgs 81/08'] },
  { re: /ponteggio/, row: ['Ponteggio metallico fisso', 'Controllo degli elementi prima del montaggio; verifica dopo vento forte, pioggia o lunghe interruzioni', 'A ogni montaggio e dopo ogni evento', 'Art. 137 e All. XIX D.lgs 81/08'] },
  { re: /trabattello/, row: ['Trabattello', 'Controllo di ruote, freni, stabilizzatori e parapetti', 'Prima di ogni uso', 'Art. 140 D.lgs 81/08, UNI EN 1004'] },
  { re: /.*/, row: ['Scale portatili', 'Controllo visivo di montanti, pioli e piedini', 'Prima di ogni uso', 'Art. 113 D.lgs 81/08, UNI EN 131'] },
  { re: /messa a terra|impianto elettrico/, row: ['Impianto di messa a terra del cantiere', 'Verifica periodica', 'Biennale', 'DPR 462/2001'] },
  { re: /gru a torre|gru-torre|autogru|gru su autocarro|montacarichi|argano/, row: ['Funi e catene degli apparecchi di sollevamento', 'Controllo dello stato di conservazione', 'Trimestrale', 'All. VI punto 3.1.2 D.lgs 81/08'] },
];
const VERIFICHE_GENERALI = VERIFICHE.filter(v => !/Funi|Sollevatore|Trabattello|Montacarichi/.test(v.row[0])).concat(VERIFICHE.filter(v => /Funi/.test(v.row[0])));
function tabellaVerifiche(d) {
  const t = testoLavori(d);
  const righe = nuovoPercorso(d) ? VERIFICHE.filter(v => v.re.test(t)) : VERIFICHE_GENERALI;
  return `<table class="allow-break"><thead><tr><th style="width:26%">Attrezzatura</th><th style="width:30%">Tipo di verifica</th><th style="width:18%">Frequenza</th><th>Riferimento normativo</th></tr></thead>
<tbody>${righe.map(v => `<tr>${v.row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ── 9.3 Abilitazioni degli operatori ─────────────────────────────────────────
const ACCORDO = 'Accordo Stato-Regioni 17/04/2025 (Rep. 59/CSR)';
const ABILITAZIONI = [
  { re: /gru a torre|gru-torre/, row: ['Gru a torre', 'Abilitazione operatore gru a torre'] },
  { re: /autogru|gru su autocarro|gru mobile/, row: ['Gru mobile e gru per autocarro', 'Abilitazione operatore gru mobile / per autocarro'] },
  { re: /\bple\b|piattaforma elevabile/, row: ['Piattaforme di lavoro elevabili (PLE)', 'Abilitazione operatore PLE'] },
  { re: /escavator|pala|terna|movimento terra/, row: ['Macchine movimento terra (escavatori, pale, terne)', 'Abilitazione operatore macchine movimento terra'] },
  { re: /sollevatore telescopico|carrello elevatore/, row: ['Carrelli elevatori e sollevatori telescopici', 'Abilitazione operatore carrelli'] },
  { re: /autopompa|pompa per calcestruzzo/, row: ['Pompa per calcestruzzo', 'Abilitazione operatore pompa per calcestruzzo'] },
];
function tabellaAbilitazioni(d) {
  const t = testoLavori(d);
  const righe = nuovoPercorso(d) ? ABILITAZIONI.filter(a => a.re.test(t)) : ABILITAZIONI;
  if (!righe.length) return '<p>Nessuna delle attrezzature indicate richiede un\'abilitazione specifica dell\'operatore (art. 73 c. 5 D.lgs 81/08).</p>';
  return `<table class="allow-break"><thead><tr><th style="width:36%">Attrezzatura</th><th style="width:34%">Abilitazione richiesta</th><th>Riferimento</th></tr></thead>
<tbody>${righe.map(a => `<tr><td>${esc(a.row[0])}</td><td>${esc(a.row[1])}</td><td>Art. 73 c. 5 D.lgs 81/08, ${ACCORDO}</td></tr>`).join('')}</tbody></table>`;
}

// ── 10.2 Sostanze ────────────────────────────────────────────────────────────
const SOSTANZE = {
  'Malte, cementi e calce': ['Cemento, malte e calce', 'H315, H317, H318 (calce: H315, H318, H335)', 'Ustioni chimiche della pelle, lesioni agli occhi, sensibilizzazione, polveri', 'Guanti, occhiali, facciale filtrante FFP2'],
  'Vernici e solventi': ['Vernici e solventi', 'H225, H304, H336 (secondo SDS)', 'Infiammabili, vapori nocivi per inalazione', 'Maschera con filtri A, guanti chimici, occhiali'],
  'Resine e collanti': ['Resine e collanti (epossidici, poliuretanici)', 'H315, H317, H319 (secondo SDS)', 'Sensibilizzazione della pelle, irritazione degli occhi', 'Guanti in nitrile, occhiali'],
  'Bitumi, guaine e primer': ['Bitumi, membrane bituminose e primer', 'Secondo SDS (primer a solvente: H226, H304, H336)', 'Fumi di bitume e ustioni nella posa a fiamma, primer infiammabili', 'Guanti anticalore, occhiali, facciale filtrante per fumi'],
  'Gas in bombole (propano, GPL)': ['Gas propano / GPL in bombole', 'H220, H280', 'Gas altamente infiammabile, recipienti sotto pressione: incendio ed esplosione', 'Bombole in piedi e assicurate, lontane da calore; estintore vicino'],
  'Oli disarmanti': ['Oli disarmanti', 'Secondo SDS', 'Irritazione della pelle, superfici scivolose', 'Guanti, occhiali'],
  'Carburanti': ['Gasolio per macchine', 'H226, H304, H332 (secondo SDS)', 'Infiammabile, nocivo per inalazione', 'Guanti, rifornimento a motore spento'],
  'Amianto': ['Materiali contenenti amianto', 'H350 — cancerogeno', 'Fibre cancerogene', 'Solo ditta iscritta all\'Albo (cat. 10), piano di lavoro art. 256 D.lgs 81/08'],
};
const SOSTANZE_GENERALI = ['Malte, cementi e calce', 'Vernici e solventi', 'Resine e collanti', 'Carburanti', 'Amianto'];
function tabellaSostanze(d) {
  const scelte = Array.isArray(d.sostanze) ? d.sostanze.filter(x => SOSTANZE[x]) : SOSTANZE_GENERALI;
  if (!scelte.length) return '<p>L\'impresa non prevede l\'uso di sostanze o preparati pericolosi in questo cantiere. Se ne verranno introdotti, la scheda di sicurezza (SDS) sarà disponibile in cantiere prima dell\'uso.</p>';
  return `<table class="allow-break"><thead><tr><th style="width:24%">Sostanza</th><th style="width:22%">Classificazione CLP</th><th style="width:28%">Rischi principali</th><th>DPI e cautele</th></tr></thead>
<tbody>${scelte.map(k => `<tr>${SOSTANZE[k].map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ── 11.2 Rifiuti ─────────────────────────────────────────────────────────────
const NP = 'Non pericoloso', P = '<strong>Pericoloso</strong>';
const CER_BASE = [
  ['17 01 01', 'Cemento', NP, 'Recupero / discarica'],
  ['17 01 02', 'Mattoni', NP, 'Recupero / discarica'],
  ['17 02 01', 'Legno', NP, 'Recupero'],
  ['17 04 05', 'Ferro e acciaio', NP, 'Recupero'],
  ['17 09 04', 'Rifiuti misti dell\'attività di costruzione e demolizione', NP, 'Recupero / discarica'],
];
const CER_EXTRA = [
  { re: /guain|bitum|impermeabilizz/, rows: [['17 03 02', 'Miscele bituminose (guaine e membrane rimosse)', NP, 'Recupero / discarica autorizzata']] },
  { re: /lattoner|gronde|pluvial/, rows: [['17 04 01', 'Rame, bronzo, ottone', NP, 'Recupero'], ['17 04 02', 'Alluminio', NP, 'Recupero'], ['17 04 04', 'Zinco', NP, 'Recupero']] },
  { re: /tinteggiat|vernic/, rows: [['08 01 11*', 'Pitture e vernici di scarto con solventi organici', P, 'Impianto autorizzato'], ['08 01 12', 'Pitture e vernici diverse da 08 01 11', NP, 'Impianto autorizzato']] },
  { re: /serrament|vetrat|vetro/, rows: [['17 02 02', 'Vetro', NP, 'Recupero']] },
  { re: /cappotto|isolament/, rows: [['17 06 04', 'Materiali isolanti diversi da 17 06 01 e 17 06 03', NP, 'Recupero / discarica']] },
  { re: /amianto/, rows: [['17 06 05*', 'Materiali da costruzione contenenti amianto', P, 'Solo ditta iscritta all\'Albo (cat. 10)'], ['17 06 01*', 'Materiali isolanti contenenti amianto', P, 'Solo ditta iscritta all\'Albo (cat. 10)']] },
  { re: /carburant|oli disarmant/, rows: [['13 02 08*', 'Altri oli per motori, ingranaggi e lubrificazione', P, 'Consorzio CONOU']] },
];
const CER_GENERALI = [...CER_BASE, ['17 02 02', 'Vetro', NP, 'Recupero'], ['17 06 01*', 'Materiali isolanti contenenti amianto', P, 'Ditta specializzata'], ['08 01 11*', 'Pitture e vernici con solventi organici', P, 'Impianto autorizzato'], ['13 02 08*', 'Oli esausti', P, 'Consorzio CONOU']];
function tabellaRifiuti(d) {
  let righe = CER_GENERALI;
  if (nuovoPercorso(d)) {
    const t = `${testoLavori(d)} | ${(d.sostanze || []).join(' | ').toLowerCase()}`;
    righe = [...CER_BASE];
    for (const x of CER_EXTRA) if (x.re.test(t)) for (const r of x.rows) if (!righe.some(y => y[0] === r[0])) righe.push(r);
  }
  return `<table class="allow-break"><thead><tr><th style="width:16%">Codice CER</th><th style="width:40%">Descrizione</th><th style="width:18%">Tipo</th><th>Gestione</th></tr></thead>
<tbody>${righe.map(r => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td><td>${r[2]}</td><td>${esc(r[3])}</td></tr>`).join('')}</tbody></table>`;
}

// ── 12 Formazione (art. 37 e Accordo Stato-Regioni 17/04/2025) ──────────────
function tabellaFormazione(d) {
  const t = testoLavori(d);
  const nuovo = nuovoPercorso(d);
  const righe = [
    ['Formazione generale dei lavoratori', '4 ore', '—', ACCORDO],
    ['Formazione specifica, rischio alto (edilizia)', '12 ore', '6 ore ogni 5 anni', ACCORDO],
    ['Preposto', '12 ore', '6 ore ogni 2 anni, in presenza', 'Art. 37 c. 7-ter D.lgs 81/08, ' + ACCORDO],
    ['Addetti primo soccorso (Gruppo B)', '12 ore', '4 ore ogni 3 anni', 'D.M. 388/2003'],
    ['Addetti antincendio (livello 2)', '8 ore', '5 ore ogni 5 anni', 'D.M. 2/9/2021'],
    ['RLS', '32 ore', '4 ore l\'anno (15-50 lavoratori), 8 ore oltre 50', 'Art. 37 c. 11 D.lgs 81/08'],
  ];
  if (!nuovo || /ponteggio-montaggio|montaggio, trasformazione|montaggio ponteggio/.test(t)) righe.push(['Montaggio, trasformazione e smontaggio ponteggi', '28 ore', '4 ore ogni 4 anni', 'All. XXI D.lgs 81/08']);
  if (!nuovo || (d.lavoriInQuota && !/^no/i.test(d.lavoriInQuota))) righe.push(['Uso dei DPI anticaduta (III categoria)', 'Addestramento', 'Secondo il fabbricante', 'Art. 77 c. 5 D.lgs 81/08']);
  return `<table class="allow-break"><thead><tr><th style="width:34%">Formazione</th><th style="width:13%">Durata</th><th style="width:22%">Aggiornamento</th><th>Riferimento</th></tr></thead>
<tbody>${righe.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

module.exports = { tabellaLavoratori, lavorazioniPreviste, tabellaVerifiche, tabellaAbilitazioni, tabellaSostanze, tabellaRifiuti, tabellaFormazione, ACCORDO, nuovoPercorso };
