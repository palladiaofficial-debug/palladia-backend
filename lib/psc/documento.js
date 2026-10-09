'use strict';
/**
 * lib/psc/documento.js — F-270. I documenti del coordinatore in HTML per
 * Puppeteer (pdf-renderer: @page 26/24 mm, header/footer nativi):
 *  - PSC completo (copertina con indice e pagine, 12 sezioni, firme);
 *  - Fascicolo dell'opera, bozza (Allegato XVI);
 *  - Dati per la notifica preliminare (art. 99, Allegato XII);
 *  - Verbale di sopralluogo o riunione.
 * Lo stesso HTML del PSC, con un involucro per Word, diventa il file .doc.
 *
 * Nel PSC entra SOLO ciò che il coordinatore ha approvato: misure con
 * approvata=true, voci di organizzazione attive, rischi del contesto accesi.
 */
const { ORGANIZZAZIONE, CATEGORIE_COSTI } = require('./catalog');
const { riepilogo } = require('./costi');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const d = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) : '—');
const dLong = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
// Sempre col punto delle migliaia (1.200,00): Intl it-IT non raggruppa i numeri di 4 cifre.
const eur = (n) => { const v = Number(n) || 0; const [i, d] = Math.abs(v).toFixed(2).split('.'); return `${v < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`; };
const num = (n) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: 3 });

const SEZIONI = [
  ['1', 'Identificazione e descrizione dell\'opera'],
  ['2', 'Soggetti'],
  ['3', 'Area di cantiere, contesto e rischi esterni'],
  ['4', 'Organizzazione del cantiere'],
  ['5', 'Lavorazioni: rischi e misure di prevenzione'],
  ['6', 'Interferenze e prescrizioni operative'],
  ['7', 'Uso comune di apprestamenti, attrezzature e servizi'],
  ['8', 'Cooperazione, coordinamento e informazione'],
  ['9', 'Cronoprogramma dei lavori'],
  ['10', 'Costi della sicurezza'],
  ['11', 'Gestione delle emergenze'],
  ['12', 'Procedure complementari e di dettaglio'],
];

function css() {
  // F-300: tipografia e spazi rivisti dopo la prima prova di un coordinatore
  // vero ("non sembra ancora abbastanza professionale"). Corpo 10 pt, titoli a
  // scala 15/11.5, colori più scuri per la lettura su carta, tabelle ariose.
  return `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300..800&display=swap');
@page { size: A4; margin: 26mm 0 24mm 0; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; overflow-wrap: break-word; }
html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Plus Jakarta Sans', Arial, Helvetica, sans-serif; font-size: 10pt; font-weight: 420; line-height: 1.5; color: #15120E; background: #FFFFFF; font-feature-settings: 'tnum' 0; }
b, strong { font-weight: 700; }
.doc { width: 100%; padding: 0 16mm; }
h1, h2, h3 { break-after: avoid-page; page-break-after: avoid; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
.eyebrow { font-size: 7.6pt; font-weight: 750; letter-spacing: 1.1pt; color: #6A635A; text-transform: uppercase; }
.muted { color: #5F584F; }
.small { font-size: 8.6pt; }
p { margin: 0 0 2.2mm; }

/* Copertina */
.cover { height: 247mm !important; overflow: hidden !important; display: flex; flex-direction: column; break-after: page; page-break-after: always; }
.cover .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; padding-bottom: 5mm; border-bottom: 2pt solid #22384F; }
.cover h1 { font-size: 30pt; font-weight: 800; letter-spacing: -0.6pt; line-height: 1.05; margin-top: 2mm; }
.cover .sub { font-size: 9.4pt; color: #5F584F; margin-top: 2mm; }
.rev { text-align: right; white-space: nowrap; }
.rev b { display: block; font-size: 20pt; font-weight: 800; color: #22384F; line-height: 1; }
.rev span { font-size: 9pt; color: #5F584F; }
.cover .opera { margin-top: 9mm; padding: 5mm 6mm; background: #F6F4F0; border-left: 2.4mm solid #22384F; border-radius: 0 2mm 2mm 0; }
.cover .opera .t { font-size: 18pt; font-weight: 800; line-height: 1.2; letter-spacing: -0.2pt; }
.cover .opera .a { font-size: 11pt; margin-top: 1mm; }
.cover .tipo { display: inline-block; margin-top: 2.5mm; background: #22384F; color: #FFFFFF; font-weight: 700; font-size: 8.4pt; padding: 0.9mm 3mm; border-radius: 3mm; }
.cover .opera .desc { margin-top: 2.5mm; font-size: 9.6pt; color: #3D3832; }
.cover .dati { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-top: 5mm; border-top: 0.6pt solid #D9D3C9; }
.cover .dati div { padding: 2.5mm 3mm 0 0; }
.cover .dati span { display: block; font-size: 7.4pt; font-weight: 750; letter-spacing: 0.8pt; text-transform: uppercase; color: #6A635A; }
.cover .dati b { font-size: 11pt; }
.cover .persone { margin-top: 8mm; }
.cover .persone table { margin: 2mm 0 0; font-size: 10pt; }
.cover .persone td { padding: 2.4mm 2mm 2.4mm 0; border-bottom: 0.6pt solid #E4DED5; }
.cover .persone td.k { width: 68mm; color: #5F584F; }
.cover .rv { margin-top: 7mm; }
.cover .foot { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; padding-top: 5mm; }
.cover .firma { border: 0.6pt solid #D9D3C9; border-radius: 2mm; padding: 3mm 4mm; height: 30mm; display: flex; flex-direction: column; }
.cover .firma .n { font-weight: 700; margin-top: 0.6mm; }
.cover .firma .spazio { margin-top: auto; border-bottom: 0.6pt solid #9C948A; }
.cover .redatto { margin-top: 3mm; font-size: 7.6pt; color: #8A8278; text-align: right; }

/* Indice */
.indice { break-after: page; page-break-after: always; }
.indice h2 { font-size: 18pt; font-weight: 800; margin: 0 0 6mm; padding-bottom: 2.5mm; border-bottom: 2pt solid #22384F; }
.idx { display: flex; align-items: baseline; gap: 4mm; font-size: 10.6pt; padding: 2.6mm 0; border-bottom: 0.6pt dotted #CFC8BD; }
.idx b { width: 9mm; color: #22384F; font-weight: 800; }
.idx em { margin-left: auto; font-style: normal; font-weight: 700; font-variant-numeric: tabular-nums; }

/* Sezioni */
h2.sec { display: flex; align-items: center; gap: 3mm; font-size: 15pt; font-weight: 800; letter-spacing: -0.2pt; margin: 9mm 0 4mm; padding-bottom: 2mm; border-bottom: 1.2pt solid #22384F; color: #15120E; }
h2.sec .n { display: inline-flex; align-items: center; justify-content: center; min-width: 8mm; height: 8mm; padding: 0 1.5mm; border-radius: 1.6mm; background: #22384F; color: #FFFFFF; font-size: 11pt; }
h2.sec.first { margin-top: 0; }
h2.sec.newpage { break-before: page; page-break-before: always; margin-top: 0; }
h3 { font-size: 11.5pt; font-weight: 750; margin: 5mm 0 2mm; color: #15120E; }
.nota { font-size: 8.8pt; color: #5F584F; background: #F6F4F0; border-radius: 1.5mm; padding: 2mm 3mm; margin: 0 0 3mm; }

/* Tabelle */
table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 1.5mm 0 4mm; font-size: 9.2pt; }
th { text-align: left; background: #EEF2F6; color: #22384F; font-weight: 750; padding: 2mm 2.4mm; font-size: 7.8pt; letter-spacing: 0.4pt; text-transform: uppercase; }
td { padding: 2mm 2.4mm; border-bottom: 0.6pt solid #E4DED5; vertical-align: top; }
td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
td.k { color: #5F584F; }
td.cod { font-size: 7.8pt; white-space: nowrap; font-variant-numeric: tabular-nums; }
th.r { white-space: nowrap; }
tr.tot td { font-weight: 800; border-top: 1.2pt solid #15120E; border-bottom: 0; }
tr.sub td { font-weight: 700; background: #FAF8F5; }
ul.m { margin: 0 0 3mm 5mm; }
ul.m li { margin: 0 0 1.2mm; padding-left: 0.5mm; }
.lv { display: inline-block; padding: 0.4mm 2.2mm; border-radius: 4mm; font-size: 7.8pt; font-weight: 750; white-space: nowrap; }
.lv.molto-alto { background: #A8453B; color: #FFFFFF; }
.lv.alto { background: #FBE9E6; color: #A8453B; }
.lv.medio { background: #FDF1E7; color: #B25A14; }
.lv.basso { background: #EEF4EF; color: #4A7358; }

/* Lavorazioni */
.lav { margin-bottom: 7mm; }
.lav-head { display: flex; justify-content: space-between; align-items: baseline; gap: 5mm; background: #22384F; color: #FFFFFF; padding: 2.6mm 4mm; border-radius: 1.6mm; break-after: avoid-page; page-break-after: avoid; }
.lav-head b { font-size: 11pt; font-weight: 750; }
.lav-head span { font-size: 8.6pt; color: #D5DEE8; white-space: nowrap; }
.lav-meta { display: flex; flex-wrap: wrap; gap: 1.5mm 4mm; margin: 2mm 0 2.5mm; font-size: 8.8pt; color: #3D3832; }
.lav-meta span b { color: #15120E; }
.lav h4 { font-size: 9.6pt; font-weight: 750; margin: 3mm 0 1.2mm; color: #22384F; }
.kvt td { padding: 1.6mm 2.4mm; font-size: 8.8pt; }
.kvt td.k { width: 42mm; font-weight: 700; color: #3D3832; }

/* Interferenze */
.intf { border: 0.6pt solid #D9D3C9; border-radius: 2mm; padding: 3.5mm 4.5mm; margin: 0 0 4mm; break-inside: avoid; page-break-inside: avoid; }
.intf .t { font-size: 10.6pt; font-weight: 750; line-height: 1.35; }
.intf .t i { font-style: normal; color: #A8453B; padding: 0 1mm; }
.intf .meta { font-size: 8.6pt; color: #5F584F; margin: 1mm 0 2.5mm; }
.intf .riga { display: grid; grid-template-columns: 30mm 1fr; gap: 3mm; padding: 1.6mm 0; border-top: 0.6pt solid #EEE9E1; font-size: 9.2pt; }
.intf .riga span { font-weight: 700; color: #3D3832; }

/* Organigramma */
.org { position: relative; width: 178mm; margin: 3mm 0 5mm; break-inside: avoid; page-break-inside: avoid; }
.org svg { position: absolute; left: 0; top: 0; }
.org .nodo { position: absolute; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; border: 0.8pt solid #22384F; border-radius: 1.8mm; background: #FFFFFF; padding: 1mm 2mm; overflow: hidden; }
.org .nodo.forte { background: #22384F; color: #FFFFFF; }
.org .nodo .r { font-size: 6.6pt; font-weight: 800; letter-spacing: 0.5pt; text-transform: uppercase; color: #6A635A; line-height: 1.2; }
.org .nodo.forte .r { color: #CFD8E2; }
.org .nodo b { font-size: 8.6pt; line-height: 1.25; margin-top: 0.5mm; }
.org .leg { position: absolute; font-size: 7.2pt; color: #6A635A; }

/* Cronoprogramma */
.gt { position: relative; width: 178mm; margin: 2mm 0 4mm; break-inside: avoid; page-break-inside: avoid; }
.gt .lab { position: absolute; left: 0; width: 58mm; padding-right: 3mm; overflow: hidden; }
.gt .lab b { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; font-size: 8.2pt; line-height: 1.2; overflow: hidden; }
.gt .lab span { display: block; margin-top: 0.4mm; font-size: 7.2pt; color: #5F584F; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gt .bar { position: absolute; height: 4.2mm; border-radius: 1mm; color: #FFFFFF; font-size: 6.8pt; font-weight: 700; line-height: 4.2mm; padding: 0 1.2mm; white-space: nowrap; overflow: hidden; }
.gt .hd { position: absolute; font-size: 6.8pt; color: #5F584F; text-align: center; white-space: nowrap; }
.gt .hd.m { font-weight: 750; color: #22384F; text-align: left; font-size: 7.4pt; }
.gt .vl { position: absolute; width: 0; border-left: 0.4pt solid #ECE7DF; }
.gt .vl.m { border-left: 0.7pt solid #CFC8BD; }
.gt .hl { position: absolute; left: 0; width: 178mm; height: 0; border-top: 0.5pt solid #ECE7DF; }
.leg-imp { display: flex; flex-wrap: wrap; gap: 2mm 5mm; font-size: 8.4pt; margin: 1mm 0 2mm; }
.leg-imp i { display: inline-block; width: 3mm; height: 3mm; border-radius: 0.6mm; margin-right: 1.2mm; vertical-align: -0.4mm; }

/* Firme */
.firme { break-inside: avoid; page-break-inside: avoid; margin-top: 8mm; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 3mm; }
.sign .box { border: 0.6pt solid #D9D3C9; border-radius: 2mm; padding: 3mm 4mm; height: 32mm; display: flex; flex-direction: column; }
.sign .box .spazio { margin-top: auto; border-bottom: 0.6pt solid #9C948A; }
.sign .line { border-bottom: 0.6pt solid #9C948A; height: 14mm; margin-top: 2mm; }
.layout-img { max-width: 100%; max-height: 200mm; display: block; margin: 2mm 0; border: 0.5pt solid #ECE7DF; }
.photo { width: 52mm; height: 39mm; object-fit: cover; border-radius: 1mm; border: 0.5pt solid #ECE7DF; }
`;
}

function wrap(body, title) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css()}</style></head><body><div class="doc">${body}</div></body></html>`;
}

const ok = (v) => v && v.approvata !== false && v.approvato !== false;

// Indirizzo + comune, senza ripetere il comune se è già scritto nell'indirizzo
const luogo = (address, comune) => (address && comune && address.toLowerCase().includes(comune.toLowerCase()) ? address : [address, comune].filter(Boolean).join(', '));

const PALETTE = ['#22384F', '#B7832F', '#3E7C78', '#7A4F6E', '#9A8F80', '#4A7358', '#A8453B', '#5B6B8C'];

function sogg(p) {
  const s = p.soggetti || {};
  const row = (k, o) => (o && (o.nome || o.ragione_sociale) ? `<tr><td style="width:62mm" class="muted">${esc(k)}</td><td><b>${esc(o.nome || o.ragione_sociale)}</b>${o.qualifica ? `, ${esc(o.qualifica)}` : ''}${[o.indirizzo, o.telefono, o.email, o.pec].filter(Boolean).length ? `<br><span class="small muted">${esc([o.indirizzo, o.telefono, o.email, o.pec].filter(Boolean).join(' · '))}</span>` : ''}</td></tr>` : '');
  return [
    row('Committente', s.committente), row('Responsabile dei lavori', s.responsabile_lavori),
    row('Progettista', s.progettista), row('Direttore dei lavori', s.direttore_lavori),
    row('Coordinatore per la progettazione (CSP)', s.csp), row('Coordinatore per l\'esecuzione (CSE)', s.cse),
  ].join('');
}

/**
 * F-295: chi risponde a chi. Tabelle e non flex, così regge anche nel file Word.
 * Committente → responsabile dei lavori → progettista, direttore dei lavori,
 * coordinatori → impresa affidataria → esecutrici e lavoratori autonomi.
 */
function organigrammaTabella(p, imprese = []) {
  const s = p.soggetti || {};
  const nodo = (ruolo, nome, forte = false) => `<span class="nodo${forte ? ' forte' : ''}"><span class="r">${esc(ruolo)}</span><b>${esc(nome || '—')}</b></span>`;
  const riga = (celle) => `<tr>${celle.map(c => `<td style="width:${Math.floor(100 / celle.length)}%">${c}</td>`).join('')}</tr>`;
  const lin = (n = 1) => `<tr class="lin">${Array.from({ length: n }, () => '<td><span></span></td>').join('')}</tr>`;
  const tab = (rows) => `<table class="org"><tbody>${rows.join('')}</tbody></table>`;
  const tecnici = [
    ['Progettista', s.progettista], ['Direttore dei lavori', s.direttore_lavori],
    ['Coordinatore per la progettazione', s.csp], ['Coordinatore per l\'esecuzione', s.cse],
  ].filter(([, o]) => o && o.nome).map(([r, o]) => nodo(r, o.nome, /esecuzione/.test(r)));
  const affidatarie = imprese.filter(i => i.ruolo === 'affidataria');
  const altre = imprese.filter(i => i.ruolo !== 'affidataria');
  const ruoloImp = (i) => ({ affidataria: 'Impresa affidataria', esecutrice: 'Impresa esecutrice', autonomo: 'Lavoratore autonomo' }[i.ruolo] || 'Impresa');
  const blocchi = [
    tab([riga([nodo('Committente', s.committente && s.committente.nome)])]),
    s.responsabile_lavori && s.responsabile_lavori.nome ? tab([lin(), riga([nodo('Responsabile dei lavori', s.responsabile_lavori.nome)])]) : '',
    tecnici.length ? tab([lin(), riga(tecnici)]) : '',
    tab([lin(), riga(affidatarie.length ? affidatarie.map(i => nodo('Impresa affidataria', i.ragione_sociale)) : [nodo('Impresa affidataria', 'da individuare')])]),
    altre.length ? tab([lin(), ...chunk(altre, 4).map(g => riga(g.map(i => nodo(ruoloImp(i), i.ragione_sociale))))]) : '',
  ];
  return `<div style="break-inside:avoid;page-break-inside:avoid">${blocchi.join('')}</div>${imprese.length ? '' : '<p class="small muted">Imprese esecutrici e lavoratori autonomi si aggiungono alle revisioni successive, prima del loro ingresso in cantiere.</p>'}`;
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// F-305: l'entità presunta è quella scritta dal coordinatore; se manca, la
// somma delle stime delle lavorazioni (dichiarata come tale).
function entitaPresunta(p, lav) {
  const scritta = Number(p.uomini_giorno);
  if (scritta > 0) return { ug: scritta, stima: false };
  return { ug: lav.reduce((s, l) => s + (Number(l.uomini_giorno) || 0), 0), stima: true };
}

// F-315: Allegato XV 2.2.1 — rischi che arrivano dall'esterno e rischi che il
// cantiere trasmette all'area circostante, separati come nei PSC dei
// coordinatori. I secondi vengono anche dalle lavorazioni, non solo dalla mappa.
const DA_ESTERNO = new Set(['strada_traffico', 'ferrovia', 'linee_aeree', 'sottoservizi', 'alberi', 'corsi_acqua']);
const VERSO_ESTERNO = [
  { key: 'rumore', titolo: 'Rumore', re: /rumor/i,
    misure: 'Lavorazioni rumorose negli orari consentiti dal regolamento comunale, con eventuale autorizzazione in deroga; macchine conformi alla direttiva 2000/14/CE e spente quando non in uso.' },
  { key: 'polveri', titolo: 'Polveri', re: /polver/i,
    misure: 'Bagnatura delle superfici e dei materiali, teli antipolvere sul ponteggio, macerie in contenitori chiusi e allontanate senza depositi sulla via pubblica.' },
  // nome della lavorazione (ponteggio, facciata, copertura) o un rischio di caduta di MATERIALI,
  // non la caduta del lavoratore "dal ponteggio" (Intonaci, Tinteggiature)
  { key: 'caduta', titolo: 'Caduta di materiali verso l\'esterno', reNome: /ponteggi|facciat|copertur/i, re: /caduta (di |dei |degli )?(material|oggett|modul|element|frammenti|attrezz|calcinacci)/i,
    misure: 'Mantovana parasassi e teli sul ponteggio; nessun carico sospeso sopra aree aperte al pubblico; area sottostante interdetta o protetta (tunnel o percorso pedonale deviato).' },
  { key: 'mezzi', titolo: 'Mezzi in entrata e uscita dal cantiere', re: /investiment|manovr|autocarr|autogru|automezz/i,
    misure: 'Accesso carrabile segnalato; manovre in entrata e in uscita assistite da un operatore a terra; ruote pulite prima di uscire sulla via pubblica.' },
];
/** Pura (testabile): rischi trasmessi all'area circostante, con le lavorazioni che li generano. */
function rischiVersoEsterno(lav) {
  const out = [];
  for (const v of VERSO_ESTERNO) {
    const da = lav.filter(l => (v.reNome && v.reNome.test(l.nome || '')) || v.re.test([l.nome, ...(l.rischi || []).map(r => r.testo)].join(' | ')));
    if (da.length) out.push({ key: v.key, titolo: v.titolo, misure: v.misure, lavorazioni: da.map(l => l.nome) });
  }
  return out;
}

// F-315: macchine e attrezzature in un capitolo solo, con le lavorazioni che le usano.
function attrezzatureDi(lav) {
  const m = new Map();
  for (const l of lav) for (const a of l.apprestamenti || []) {
    const k = String(a.nome || '').trim();
    if (!k) continue;
    if (!m.has(k)) m.set(k, { nome: k, verifica: a.verifica || '', lavorazioni: [] });
    const x = m.get(k);
    if (!x.verifica && a.verifica) x.verifica = a.verifica;
    if (!x.lavorazioni.includes(l.nome)) x.lavorazioni.push(l.nome);
  }
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

// F-311: i dati dell'impresa, solo quelli compilati
function datiImpresa(i, lav) {
  const sede = [i.indirizzo, [i.cap, i.citta].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const righe = [
    ['Ruolo', { affidataria: 'Impresa affidataria', esecutrice: 'Impresa esecutrice', autonomo: 'Lavoratore autonomo' }[i.ruolo] || ''],
    ['Datore di lavoro', i.datore_lavoro], ['Sede', sede], ['Telefono', i.telefono], ['E-mail', i.email],
    ['Codice fiscale', i.codice_fiscale], ['Partita IVA', i.piva], ['Posizione INPS', i.posizione_inps],
    ['Posizione INAIL', i.posizione_inail], ['Cassa Edile', i.cassa_edile], ['Referente', i.referente],
    ['Incaricato art. 97', [i.art97_nome, i.art97_mansione].filter(Boolean).join(', ')],
    ['Lavorazioni affidate', lav.filter(l => l.impresa_id === i.id).map(l => l.nome).join(', ')],
  ].filter(([, v]) => v);
  return `<div style="break-inside:avoid;page-break-inside:avoid"><h4>${esc(i.ragione_sociale)}</h4><table class="kvt"><tbody>${righe.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>`;
}

/**
 * @param {object} snap { project, lavorazioni, imprese, costi, decisioni, revisioni, layoutDataUri, pagine }
 */
function pscBody(snap, { pagine = {}, perWord = false } = {}) {
  const p = snap.project;
  const lav = [...(snap.lavorazioni || [])].sort((a, b) => (a.start_date || '9').localeCompare(b.start_date || '9') || a.ordine - b.ordine);
  const imprese = snap.imprese || [];
  const impById = new Map(imprese.map(i => [i.id, i]));
  const lavById = new Map(lav.map(l => [l.id, l]));
  const color = new Map(imprese.map((i, k) => [i.id, i.color || PALETTE[k % PALETTE.length]]));
  const { ug, stima: ugStima } = entitaPresunta(p, lav);
  const riep = riepilogo(snap.costi || [], imprese);
  const rev = p.revision || 0;
  const cse = (p.soggetti && p.soggetti.cse && p.soggetti.cse.nome) || '';
  // F-298: cronoprogramma a settimane (default) o a giorni
  const sett = p.crono_scala !== 'giorni' && !!p.start_date;

  // ── Copertina ──
  const revRows = (snap.revisioni || []).map(r => `<tr><td style="width:14mm">${r.revision}</td><td style="width:26mm">${d(r.created_at)}</td><td>${esc(r.motivo)}</td></tr>`).join('');
  const idx = SEZIONI.map(([n, t]) => `<div class="idx"><b>${n}</b>${esc(t)}<em>${pagine[n] || ''}</em></div>`).join('');
  // F-295: copertina con i soli dati dell'opera e delle persone (come la vuole
  // il coordinatore), l'indice in una pagina sua, subito dopo.
  const S_ = p.soggetti || {};
  const nomeDi = (k) => (S_[k] && S_[k].nome) || '—';
  const durataG = p.start_date && p.end_date ? Math.round((Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000) + 1 : null;
  const persona = (k) => { const o = S_[k]; return o && o.nome ? `<b>${esc(o.nome)}</b>${o.qualifica ? `<span class="muted">, ${esc(o.qualifica)}</span>` : ''}` : '<span class="muted">—</span>'; };
  let out = `<section class="cover">
  <div class="top"><div><div class="eyebrow">D.Lgs. 81/2008 · art. 100 e Allegato XV</div><h1>Piano di Sicurezza<br>e Coordinamento</h1></div>
  <div class="rev"><b>Rev. ${rev}</b><span>${dLong(p.signed_at || new Date().toISOString())}</span></div></div>
  <div class="opera"><div class="eyebrow">Opera</div><div class="t">${esc(p.title)}</div>
   <div class="a">${esc(luogo(p.address, p.comune) + (p.provincia && !luogo(p.address, p.comune).toLowerCase().includes(String(p.provincia).toLowerCase()) ? ` (${p.provincia})` : ''))}</div>
   ${p.tipo_opera ? `<span class="tipo">${esc(p.tipo_opera.charAt(0).toUpperCase() + p.tipo_opera.slice(1))}</span>` : ''}
   ${p.descrizione ? `<div class="desc">${esc(p.descrizione.length > 260 ? `${p.descrizione.slice(0, 257)}…` : p.descrizione)}</div>` : ''}
   <div class="dati">
    <div><span>Inizio lavori</span><b>${d(p.start_date)}</b></div>
    <div><span>Fine lavori</span><b>${d(p.end_date)}</b></div>
    <div><span>Durata</span><b>${durataG ? `${durataG} giorni` : '—'}</b></div>
    <div><span>Importo lavori</span><b>${p.importo_lavori ? `${eur(p.importo_lavori)} €` : '—'}</b></div>
   </div></div>
  <div class="persone"><div class="eyebrow">Soggetti</div><table><tbody>
   <tr><td class="k">Committente</td><td>${persona('committente')}</td></tr>
   <tr><td class="k">Responsabile dei lavori</td><td>${persona('responsabile_lavori')}</td></tr>
   <tr><td class="k">Coordinatore per la progettazione</td><td>${persona('csp')}</td></tr>
   <tr><td class="k">Coordinatore per l'esecuzione</td><td>${persona('cse')}</td></tr>
  </tbody></table></div>
  ${revRows ? `<div class="rv"><div class="eyebrow">Revisioni</div><table><thead><tr><th style="width:16mm">Rev.</th><th style="width:30mm">Data</th><th>Motivo</th></tr></thead><tbody>${revRows}</tbody></table></div>` : ''}
  <div class="foot">
   <div class="firma"><span class="eyebrow">Il coordinatore per la progettazione</span><span class="n">${esc(nomeDi('csp') === '—' ? cse : nomeDi('csp'))}</span><span class="spazio"></span></div>
   <div class="firma"><span class="eyebrow">Il committente o responsabile dei lavori</span><span class="n">${esc(nomeDi('responsabile_lavori') !== '—' ? nomeDi('responsabile_lavori') : nomeDi('committente'))}</span><span class="spazio"></span></div>
  </div>
  <div class="redatto">Redatto con Palladia</div>
</section>
<section class="indice"><h2>Indice</h2>${idx}</section>`;

  // ── 1 Opera ──
  const durata = durataG;
  out += `<h2 class="sec first"><span class="n">1</span>Identificazione e descrizione dell'opera</h2>
  <table><tbody>
   <tr><td style="width:52mm" class="muted">Opera</td><td><b>${esc(p.title)}</b></td></tr>
   <tr><td class="muted">Indirizzo del cantiere</td><td>${esc((luogo(p.address, p.comune) + (p.provincia ? ` (${p.provincia})` : '')) || '—')}</td></tr>
   ${p.tipo_opera ? `<tr><td class="muted">Tipo di opera</td><td>${esc(p.tipo_opera)}</td></tr>` : ''}
   <tr><td class="muted">Inizio e fine lavori</td><td>${d(p.start_date)} – ${d(p.end_date)}${durata ? ` (${durata} giorni naturali)` : ''}</td></tr>
   ${p.importo_lavori ? `<tr><td class="muted">Importo presunto dei lavori</td><td>${eur(p.importo_lavori)} €</td></tr>` : ''}
   <tr><td class="muted">Entità presunta del cantiere</td><td>${ug > 0 ? `${Math.round(ug)} uomini-giorno` : '—'}${imprese.length ? ` · ${imprese.length} ${imprese.length === 1 ? 'impresa' : 'imprese'}` : ''}</td></tr>
   <tr><td class="muted">Costi della sicurezza</td><td>${eur(riep.totale)} € (non soggetti a ribasso)</td></tr>
  </tbody></table>
  ${p.descrizione ? `<h3>Descrizione sintetica dell'opera</h3><p>${nl(p.descrizione)}</p>` : ''}`;

  // ── 2 Soggetti ──
  out += `<h2 class="sec"><span class="n">2</span>Soggetti</h2>
  <table><tbody>${sogg(p)}</tbody></table>
  <h3>Organigramma</h3>${perWord ? organigrammaTabella(p, imprese) : organigramma(p, imprese)}
  ${imprese.length ? `<h3>Imprese e lavoratori autonomi</h3>${imprese.map(i => datiImpresa(i, lav)).join('')}` : '<p class="muted">Le imprese esecutrici saranno indicate nelle revisioni successive, prima del loro ingresso in cantiere.</p>'}`;

  // ── 3 Area ──
  const ctx = p.contesto || {};
  const attivi = (ctx.trovati || []).filter(t => t.attivo !== false);
  const domande = ctx.domande || {};
  const extra = [];
  if (domande.edificio_in_uso === true) extra.push({ titolo: 'Edificio in uso durante i lavori', misure: (ctx.misure_custom && ctx.misure_custom.edificio_in_uso) || require('./catalog').CONTESTO.edificio_in_uso.misure });
  const rigaCtx = (t) => `<tr><td><b>${esc(t.titolo)}</b>${t.dettaglio || t.fonte ? `<br><span class="small muted">${esc(t.dettaglio || '')}${t.fonte ? ` · fonte ${esc(t.fonte)}` : ''}</span>` : ''}</td><td>${nl(t.misure_testo || t.misure)}</td></tr>`;
  const tutti = [...extra.map(e => ({ ...e, key: 'edificio_in_uso' })), ...attivi];
  const daFuori = tutti.filter(t => DA_ESTERNO.has(t.key));
  const versoFuori = [...tutti.filter(t => !DA_ESTERNO.has(t.key)), ...rischiVersoEsterno(lav).map(r => ({ titolo: r.titolo, dettaglio: `Da: ${r.lavorazioni.join(', ')}`, misure: r.misure }))];
  const tab = (rows) => `<table><thead><tr><th style="width:58mm">Elemento</th><th>Rischio e misure</th></tr></thead><tbody>${rows.map(rigaCtx).join('')}</tbody></table>`;
  out += `<h2 class="sec"><span class="n">3</span>Area di cantiere, contesto e rischi esterni</h2>
  ${p.testi && p.testi.descrizione_contesto ? `<h3>Il contesto</h3><p>${nl(p.testi.descrizione_contesto)}</p>` : ''}
  <h3>Rischi dall'area circostante verso il cantiere</h3>
  ${daFuori.length ? tab(daFuori) : '<p>Non sono stati individuati fattori esterni che comportano rischi particolari per il cantiere (Allegato XV, 2.2.1 b).</p>'}
  <h3>Rischi che il cantiere comporta per l'area circostante</h3>
  ${versoFuori.length ? tab(versoFuori) : '<p>Le lavorazioni previste non comportano rischi particolari per l\'area circostante (Allegato XV, 2.2.1 c).</p>'}
  ${ctx.ordigni && ctx.ordigni.esito ? `<h3>Rischio da ordigni bellici inesplosi (art. 91, c. 2-bis)</h3><p>${nl(ctx.ordigni.testo || (require('./catalog').ORDIGNI[ctx.ordigni.esito] || {}).testo || '')}</p>${ctx.ordigni.note ? `<p class="small muted">${nl(ctx.ordigni.note)}</p>` : ''}` : ''}
  ${(ctx.da_sopralluogo || []).length ? `<h3>Da verificare al primo sopralluogo</h3><ul class="m">${ctx.da_sopralluogo.map(x => `<li>${esc(x.titolo)}${x.verificato ? ' — verificato' : ''}${x.esito ? `: ${esc(x.esito)}` : ''}</li>`).join('')}</ul>` : ''}
  ${ctx.note ? `<p>${nl(ctx.note)}</p>` : ''}`;

  // ── 4 Organizzazione ──
  const org = p.organizzazione || {};
  const orgRows = ORGANIZZAZIONE.map(o => ({ o, v: org[o.key] })).filter(x => x.v && x.v.attivo !== false && x.v.testo && ok(x.v));
  const orgExtra = Object.entries(org).filter(([k, v]) => !ORGANIZZAZIONE.some(o => o.key === k) && v && v.attivo !== false && v.testo && ok(v));
  out += `<h2 class="sec"><span class="n">4</span>Organizzazione del cantiere</h2>
  ${orgRows.map(({ o, v }) => `<h3>${esc(o.titolo)}</h3><p>${nl(v.testo)}</p>`).join('')}
  ${orgExtra.map(([, v]) => `<h3>${esc(v.titolo || 'Altro')}</h3><p>${nl(v.testo)}</p>`).join('')}
  ${snap.layoutDataUri ? `<h3>Layout di cantiere</h3><img class="layout-img" src="${snap.layoutDataUri}" alt="Layout di cantiere">` : p.layout_name ? `<h3>Layout di cantiere</h3><p>Allegato: ${esc(p.layout_name)}</p>` : ''}`;

  // ── 5 Lavorazioni ──
  out += `<h2 class="sec newpage"><span class="n">5</span>Lavorazioni: rischi e misure di prevenzione</h2>
  <p class="small muted">Valutazione dei rischi: R = P × D (probabilità × danno, da 1 a 4). Livello: basso 1–3, medio 4–7, alto 8–11, molto alto 12–16.</p>`;
  for (const l of lav) {
    const imp = l.impresa_id ? impById.get(l.impresa_id) : null;
    const misure = (l.misure || []).filter(m => m.approvata);
    const periodo = l.start_date ? (sett ? `${Wk.etichetta(l, p.start_date).replace(/^s/, 'S')} · ${dShortY(l.start_date)} – ${dShortY(l.end_date)}` : `${d(l.start_date)} – ${d(l.end_date)}`) : '';
    out += `<div class="lav"><div class="lav-head"><b>${esc(l.nome)}</b><span>${esc(periodo)}</span></div>
    <div class="lav-meta"><span>Impresa: <b>${imp ? esc(imp.ragione_sociale) : 'da assegnare'}</b></span>${l.area ? `<span>Area: <b>${esc(l.area)}</b></span>` : ''}${l.addetti ? `<span>Addetti: <b>${esc(l.addetti)}</b></span>` : ''}${l.uomini_giorno ? `<span>Uomini-giorno: <b>${esc(Math.round(l.uomini_giorno))}</b></span>` : ''}</div>
    ${l.descrizione ? `<p>${nl(l.descrizione)}</p>` : ''}
    ${(l.fasi || []).length ? `<h4>Fasi di lavoro</h4><p class="small">${l.fasi.map((f, i) => `${i + 1}. ${esc(f)}`).join(' · ')}</p>` : ''}
    ${(l.rischi || []).length ? `<h4>Rischi</h4><table><thead><tr><th>Rischio</th><th class="r" style="width:9mm">P</th><th class="r" style="width:9mm">D</th><th class="r" style="width:9mm">R</th><th style="width:24mm">Livello</th></tr></thead><tbody>${l.rischi.map(r => `<tr><td>${esc(r.testo)}</td><td class="r">${r.p ?? ''}</td><td class="r">${r.d ?? ''}</td><td class="r"><b>${r.r ?? ''}</b></td><td><span class="lv ${esc(String(r.livello || '').toLowerCase().replace(/\s+/g, '-'))}">${esc(r.livello || '')}</span></td></tr>`).join('')}</tbody></table>` : ''}
    ${misure.length ? `<h4>Misure di prevenzione e protezione</h4><ul class="m">${misure.map(m => `<li>${nl(m.testo)}</li>`).join('')}</ul>` : ''}
    ${(l.dpi || []).length || (l.apprestamenti || []).length ? `<table class="kvt"><tbody>
     ${(l.dpi || []).length ? `<tr><td class="k">DPI</td><td>${esc(l.dpi.join('; '))}</td></tr>` : ''}
     ${(l.apprestamenti || []).length ? `<tr><td class="k">Macchine e attrezzature</td><td>${esc(l.apprestamenti.map(a => a.nome).join('; '))}</td></tr>` : ''}
    </tbody></table>` : ''}
    </div>`;
  }
  // F-315: un capitolo unico per macchine e attrezzature, con le verifiche (niente schede ripetute)
  const attr = attrezzatureDi(lav);
  if (attr.length) {
    out += `<h3>Macchine e attrezzature del cantiere</h3><table><thead><tr><th style="width:50mm">Macchina o attrezzatura</th><th>Usata in</th><th style="width:52mm">Verifiche e requisiti</th></tr></thead><tbody>${attr.map(a => `<tr><td><b>${esc(a.nome)}</b></td><td>${esc(a.lavorazioni.join(', '))}</td><td>${esc(a.verifica || '—')}</td></tr>`).join('')}</tbody></table>`;
  }

  // ── 6 Interferenze ──
  const dec = snap.decisioni || [];
  const SOL = { temporale: 'Sfasamento temporale', spaziale: 'Sfasamento spaziale', misure: 'Misure di coordinamento', compatibili: 'Lavorazioni compatibili' };
  out += `<h2 class="sec"><span class="n">6</span>Interferenze e prescrizioni operative</h2>
  ${dec.length ? `<p class="small muted">Per ogni coppia di lavorazioni che si sovrappongono nel tempo e nello spazio: il rischio e la prescrizione che le imprese recepiscono nei loro POS.</p>${dec.map((x, k) => {
    const a = lavById.get(x.lav_a), b = lavById.get(x.lav_b);
    const dal = a && b && a.start_date && b.start_date ? (a.start_date > b.start_date ? a.start_date : b.start_date) : null;
    const al = a && b && a.end_date && b.end_date ? (a.end_date < b.end_date ? a.end_date : b.end_date) : null;
    const imps = [a, b].map(l => (l && l.impresa_id && impById.get(l.impresa_id) ? impById.get(l.impresa_id).ragione_sociale : null)).filter(Boolean);
    const quando = dal && al && dal <= al ? (sett ? `${Wk.etichetta({ start_date: dal, end_date: al }, p.start_date)} (${dShortY(dal)} – ${dShortY(al)})` : `dal ${d(dal)} al ${d(al)}`) : '';
    return `<div class="intf"><div class="t">${k + 1}. ${esc(a ? a.nome : '')}<i>×</i>${esc(b ? b.nome : '')}</div>
    <div class="meta">${[quando ? `Periodo: ${quando}` : '', (a && a.area) || (b && b.area) ? `Area: ${esc((a && a.area) || b.area)}` : '', imps.length ? `Imprese: ${esc([...new Set(imps)].join(', '))}` : ''].filter(Boolean).join(' · ')}</div>
    ${x.rischio ? `<div class="riga"><span>Rischio</span><div>${esc(x.rischio.charAt(0).toUpperCase() + x.rischio.slice(1))}</div></div>` : ''}
    <div class="riga"><span>${SOL[x.soluzione]}</span><div>${nl(x.testo)}</div></div></div>`;
  }).join('')}` : '<p>Dal cronoprogramma non risultano lavorazioni di imprese diverse sovrapposte nello stesso tempo e nella stessa area. Ogni variazione del cronoprogramma che crei una sovrapposizione va comunicata al CSE prima dell\'esecuzione.</p>'}`;

  // ── 7 Uso comune ──
  const uso = (p.uso_comune || []).filter(u => u.testo && ok(u));
  out += `<h2 class="sec"><span class="n">7</span>Uso comune di apprestamenti, attrezzature e servizi</h2>
  ${uso.length ? uso.map(u => `<h3>${esc(u.titolo)}</h3><p>${nl(u.testo)}${u.impresa_id && impById.get(u.impresa_id) ? ` <span class="muted">Responsabile: ${esc(impById.get(u.impresa_id).ragione_sociale)}.</span>` : ''}</p>`).join('') : '<p>—</p>'}`;

  // ── 8 Coordinamento ──
  const coord = ok(p.coordinamento || {}) ? (p.coordinamento || {}) : {};
  out += `<h2 class="sec"><span class="n">8</span>Cooperazione, coordinamento e informazione</h2>
  ${coord.riunioni ? `<h3>Riunioni di coordinamento</h3><p>${nl(coord.riunioni)}</p>` : ''}
  ${coord.informazione ? `<h3>Reciproca informazione</h3><p>${nl(coord.informazione)}</p>` : ''}
  ${p.testi && p.testi.orari ? `<h3>Orari di lavoro</h3><p>${nl(p.testi.orari)}</p>` : ''}`;

  // ── 9 Cronoprogramma ──
  out += `<h2 class="sec newpage"><span class="n">9</span>Cronoprogramma dei lavori</h2>${sett ? `<p class="small muted">Cronoprogramma a settimane: la settimana 1 è quella dell'inizio lavori (${dLong(p.start_date)}); ogni settimana va dal lunedì al venerdì. Le date esatte di ogni lavorazione si fissano con il CSE in esecuzione.</p>` : ''}${perWord ? ganttTabella(lav, impById, color, p) : gantt(lav, impById, color, p, sett)}
  ${ug > 0 ? `<p class="small">Entità presunta del cantiere: <b>${Math.round(ug)} uomini-giorno</b>${ugStima ? ' (somma delle stime per lavorazione)' : ''}.</p>` : ''}`;

  // ── 10 Costi ──
  const costi = [...(snap.costi || [])].sort((a, b) => a.categoria.localeCompare(b.categoria) || a.ordine - b.ordine);
  const fontiPrezzi = [...new Set(costi.filter(c => c.prezzo_fonte === 'prezzario' && c.prezzario_fonte).map(c => c.prezzario_fonte))];
  out += `<h2 class="sec newpage"><span class="n">10</span>Costi della sicurezza</h2>
  <p class="small muted">Stima analitica per voci singole (Allegato XV, punto 4). I costi della sicurezza non sono soggetti a ribasso d'asta.</p>
  ${fontiPrezzi.length ? `<div class="nota">Prezzi unitari: ${esc(fontiPrezzi.join('; '))} per le voci con il codice dell'articolo; le altre voci sono stimate dal coordinatore.</div>` : ''}`;
  for (const [cat, titolo] of Object.entries(CATEGORIE_COSTI)) {
    const rows = costi.filter(c => c.categoria === cat);
    if (!rows.length) continue;
    const tot = rows.reduce((s, c) => s + (Number(c.quantita) || 0) * (Number(c.prezzo) || 0), 0);
    const conCodice = rows.some(c => c.codice);
    out += `<h3>${cat}) ${esc(titolo)}</h3><table><thead><tr>${conCodice ? '<th style="width:31mm">Codice</th>' : ''}<th>Descrizione</th><th style="width:15mm">U.M.</th><th class="r" style="width:15mm">Q.tà</th><th class="r" style="width:21mm">Prezzo €</th><th class="r" style="width:23mm">Importo €</th></tr></thead><tbody>
    ${rows.map(c => `<tr>${conCodice ? `<td class="cod">${esc(c.codice || '')}</td>` : ''}<td>${esc(c.descrizione)}${c.impresa_id && impById.get(c.impresa_id) ? `<br><span class="small muted">A carico di ${esc(impById.get(c.impresa_id).ragione_sociale)}</span>` : ''}</td><td>${esc(c.um || '')}</td><td class="r">${num(c.quantita)}</td><td class="r">${eur(c.prezzo)}</td><td class="r">${eur((Number(c.quantita) || 0) * (Number(c.prezzo) || 0))}</td></tr>`).join('')}
    <tr class="tot">${conCodice ? '<td></td>' : ''}<td colspan="4">Totale ${cat})</td><td class="r">${eur(tot)}</td></tr></tbody></table>`;
  }
  out += `<table><tbody><tr class="tot"><td>Totale costi della sicurezza (non soggetti a ribasso)</td><td class="r" style="width:40mm">${eur(riep.totale)} €</td></tr></tbody></table>
  ${riep.perImpresa.some(x => x.importo > 0) ? `<h3>Ripartizione per impresa</h3><table><tbody>${riep.perImpresa.filter(x => x.importo > 0).map(x => `<tr><td>${esc(x.ragione_sociale)}</td><td class="r" style="width:40mm">${eur(x.importo)} €</td></tr>`).join('')}${riep.daRipartire > 0 ? `<tr><td class="muted">Non assegnati a un'impresa</td><td class="r">${eur(riep.daRipartire)} €</td></tr>` : ''}</tbody></table>` : ''}`;

  // ── 11 Emergenze ──
  const emAll = p.emergenze || {};
  const em = ok(emAll) ? emAll : { pronto_soccorso: emAll.pronto_soccorso, numeri: emAll.numeri, punto_raccolta: emAll.punto_raccolta };
  const ps = em.pronto_soccorso || {};
  out += `<h2 class="sec"><span class="n">11</span>Gestione delle emergenze</h2>
  ${em.gestione ? `<h3>Organizzazione</h3><p>${nl(em.gestione)}</p>` : ''}
  ${em.procedura ? `<h3>Procedura in caso di infortunio o incendio</h3><p>${nl(em.procedura)}</p>` : ''}
  ${em.punto_raccolta ? `<h3>Punto di raccolta</h3><p>${nl(em.punto_raccolta)}</p>` : ''}
  <h3>Numeri utili</h3><table><tbody>
   <tr><td style="width:70mm">Numero unico di emergenza (ambulanza, Vigili del Fuoco, Carabinieri, Polizia)</td><td><b>112</b></td></tr>
   ${ps.nome ? `<tr><td>Pronto soccorso più vicino</td><td><b>${esc(ps.nome)}</b>${ps.indirizzo ? `, ${esc(ps.indirizzo)}` : ''}${ps.distanza_km ? ` · circa ${String(ps.distanza_km).replace('.', ',')} km, ${ps.minuti} minuti` : ''}</td></tr>` : ''}
   ${(em.numeri || []).filter(n => n.nome && n.numero).map(n => `<tr><td>${esc(n.nome)}</td><td><b>${esc(n.numero)}</b></td></tr>`).join('')}
   ${cse && p.soggetti.cse.telefono ? `<tr><td>Coordinatore per l'esecuzione</td><td><b>${esc(p.soggetti.cse.telefono)}</b> (${esc(cse)})</td></tr>` : ''}
  </tbody></table>`;

  // ── 12 Procedure ──
  const proc = (p.procedure || []).filter(x => x.testo);
  out += `<h2 class="sec"><span class="n">12</span>Procedure complementari e di dettaglio</h2>
  ${proc.length ? proc.map(x => `<h3>${esc(x.titolo || 'Procedura')}</h3><p>${nl(x.testo)}</p>`).join('') : '<p>Le imprese esecutrici riportano nel proprio POS le procedure complementari e di dettaglio relative alle proprie lavorazioni, coerenti con le misure di questo piano.</p>'}`;

  // ── Firme ──
  out += `<div class="firme"><h3>Firme</h3><div class="sign">
   <div class="box"><span class="eyebrow">Il coordinatore per la sicurezza</span><b style="margin-top:0.6mm">${esc(cse)}</b><span class="small muted" style="margin-top:1mm">Luogo e data</span><span class="spazio"></span></div>
   <div class="box"><span class="eyebrow">Per presa visione e accettazione</span><b style="margin-top:0.6mm">Il committente o responsabile dei lavori</b><span class="spazio"></span></div>
  </div>
  ${imprese.length ? `<h3 style="margin-top:7mm">Accettazione delle imprese (art. 100, c. 5)</h3><table><thead><tr><th>Impresa</th><th style="width:62mm">Datore di lavoro (firma)</th><th style="width:28mm">Data</th></tr></thead><tbody>${imprese.map(i => `<tr><td>${esc(i.ragione_sociale)}</td><td style="height:13mm"></td><td></td></tr>`).join('')}</tbody></table>` : ''}</div>`;

  if (perWord) out = out.replace(/class="cover"/, 'class="cover" style="height:auto"');
  return out;
}

function ganttTabella(lav, impById, color, p) {
  const dated = lav.filter(l => l.start_date && l.end_date);
  if (!dated.length) return '<p class="muted">Cronoprogramma da completare.</p>';
  const start = [p.start_date, ...dated.map(l => l.start_date)].filter(Boolean).sort()[0];
  const end = [p.end_date, ...dated.map(l => l.end_date)].filter(Boolean).sort().reverse()[0];
  // settimane dal lunedì della prima data
  const s0 = new Date(`${start}T12:00:00Z`);
  s0.setUTCDate(s0.getUTCDate() - ((s0.getUTCDay() + 6) % 7));
  const weeks = [];
  for (let t = s0.getTime(); t <= Date.parse(`${end}T12:00:00Z`); t += 7 * 86400000) weeks.push(new Date(t).toISOString().slice(0, 10));
  const W = weeks.length;
  const head = weeks.map((w, i) => `<th style="padding:1mm 0;font-size:6.6pt;text-align:center">${i === 0 || w.slice(8) <= '07' ? new Date(`${w}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : Number(w.slice(8))}</th>`).join('');
  const rows = dated.map(l => {
    const c = l.impresa_id ? color.get(l.impresa_id) : '#9C948A';
    const cells = weeks.map((w) => {
      const wEnd = new Date(Date.parse(`${w}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
      const on = l.start_date <= wEnd && l.end_date >= w;
      return `<td>${on ? `<div class="bar" style="background:${c}"></div>` : ''}</td>`;
    }).join('');
    const imp = l.impresa_id ? impById.get(l.impresa_id) : null;
    return `<tr><td class="l"><b>${esc(l.nome)}</b><br><span class="muted" style="font-size:7pt">${imp ? esc(imp.ragione_sociale) : ''} ${d(l.start_date)}–${d(l.end_date)}</span></td>${cells}</tr>`;
  }).join('');
  const colW = Math.max(3, Math.floor((178 - 60) / W * 10) / 10);
  return `<table class="gantt"><colgroup><col style="width:60mm">${weeks.map(() => `<col style="width:${colW}mm">`).join('')}</colgroup><thead><tr><th>Lavorazione</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}


const Wk = require('./settimane');
const DAYMS = 86400000;
const msd = (iso) => Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
// "19 ott"
const dShortY = (iso) => (iso ? new Date(msd(iso)).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const mm = (n) => `${Math.round(n * 100) / 100}mm`;

/**
 * F-295/F-300: organigramma disegnato. Riquadri HTML in posizione fissa (il
 * testo va a capo da solo) e collegamenti in SVG: linea continua per gli
 * incarichi (committente → responsabile → tecnici; affidataria → esecutrici),
 * tratteggiata per il coordinamento (CSE → imprese).
 */
function organigramma(p, imprese = []) {
  const s = p.soggetti || {};
  const W = 178, NH = 14, VG = 10, GAP = 4;
  const nodo = (r, n, forte = false) => ({ r, n: n || '—', forte });
  const livelli = [];
  livelli.push([nodo('Committente', s.committente && s.committente.nome)]);
  if (s.responsabile_lavori && s.responsabile_lavori.nome) livelli.push([nodo('Responsabile dei lavori', s.responsabile_lavori.nome)]);
  const tecnici = [['Progettista', s.progettista], ['Direttore dei lavori', s.direttore_lavori], ['Coordinatore per la progettazione', s.csp], ['Coordinatore per l\'esecuzione', s.cse]]
    .filter(([, o]) => o && o.nome).map(([r, o]) => nodo(r, o.nome, /esecuzione/.test(r)));
  const iTec = tecnici.length ? livelli.push(tecnici) - 1 : -1;
  const aff = imprese.filter(i => i.ruolo === 'affidataria');
  const iAff = livelli.push(aff.length ? aff.map(i => nodo('Impresa affidataria', i.ragione_sociale)) : [nodo('Impresa affidataria', 'da individuare')]) - 1;
  const altre = imprese.filter(i => i.ruolo !== 'affidataria').map(i => nodo({ esecutrice: 'Impresa esecutrice', autonomo: 'Lavoratore autonomo' }[i.ruolo] || 'Impresa', i.ragione_sociale));
  const iAltre = [];
  for (let k = 0; k < altre.length; k += 5) iAltre.push(livelli.push(altre.slice(k, k + 5)) - 1);
  // posizioni
  const pos = livelli.map((liv, li) => {
    const w = Math.min(58, (W - (liv.length - 1) * GAP) / liv.length);
    const tot = liv.length * w + (liv.length - 1) * GAP;
    return liv.map((n, k) => ({ ...n, x: (W - tot) / 2 + k * (w + GAP), y: li * (NH + VG), w }));
  });
  const H = livelli.length * (NH + VG) - VG + 8;
  const cx = (n) => n.x + n.w / 2;
  const linee = [];
  const bus = (padre, figli, tratt = false) => {
    if (!padre || !figli.length) return;
    const yMid = figli[0].y - VG / 2;
    const dash = tratt ? ' stroke-dasharray="1.4 1"' : '';
    linee.push(`<path d="M${cx(padre)} ${padre.y + NH} V${yMid}" ${dash}/>`);
    const xs = [cx(padre), ...figli.map(cx)];
    linee.push(`<path d="M${Math.min(...xs)} ${yMid} H${Math.max(...xs)}"${dash}/>`);
    for (const f of figli) linee.push(`<path d="M${cx(f)} ${yMid} V${f.y}"${dash}/>`);
  };
  // incarichi
  for (let li = 1; li < livelli.length; li++) {
    if (li === iAff || iAltre.includes(li)) continue;
    bus(pos[li - 1][0], pos[li]);
  }
  // CSE (o chi c'è sopra) → affidataria: coordinamento
  const cseN = iTec >= 0 ? pos[iTec].find(n => n.forte) : null;
  bus(cseN || pos[iAff - 1][0], pos[iAff], !!cseN);
  // affidataria → esecutrici e autonomi
  iAltre.forEach((li, k) => bus(k === 0 ? pos[iAff][0] : pos[li - 1][0], pos[li]));
  const boxes = pos.flat().map(n => `<div class="nodo${n.forte ? ' forte' : ''}" style="left:${mm(n.x)};top:${mm(n.y)};width:${mm(n.w)};height:${mm(NH)}"><span class="r">${esc(n.r)}</span><b>${esc(n.n)}</b></div>`).join('');
  return `<div class="org" style="height:${mm(H)}"><svg width="${mm(W)}" height="${mm(H)}" viewBox="0 0 ${W} ${H}" fill="none" stroke="#8E867B" stroke-width="0.3">${linee.join('')}</svg>${boxes}
  <span class="leg" style="left:0;top:${mm(H - 4)}">Linea continua: incarico · linea tratteggiata: coordinamento della sicurezza</span></div>
  ${imprese.length ? '' : '<p class="small muted">Imprese esecutrici e lavoratori autonomi si aggiungono alle revisioni successive, prima del loro ingresso in cantiere.</p>'}`;
}

/**
 * F-298/F-300: cronoprogramma disegnato. Barre continue (non più una cella per
 * settimana), intestazione con i mesi e le settimane (S1, S2… a settimane,
 * oppure il lunedì a giorni), griglia leggera, legenda delle imprese.
 * Oltre 18 lavorazioni si spezza in più blocchi con l'intestazione ripetuta.
 */
function gantt(lav, impById, color, p, sett) {
  const dated = lav.filter(l => l.start_date && l.end_date);
  if (!dated.length) return '<p class="muted">Cronoprogramma da completare.</p>';
  const first = [p.start_date, ...dated.map(l => l.start_date)].filter(Boolean).sort()[0];
  const last = [p.end_date, ...dated.map(l => l.end_date)].filter(Boolean).sort().reverse()[0];
  const t0 = msd(Wk.lunedi(first));
  const t1 = msd(Wk.lunedi(last)) + 7 * DAYMS;
  const nW = Math.max(1, Math.round((t1 - t0) / (7 * DAYMS)));
  const LAB = 58, TW = 178 - LAB, HEAD = 10.5, ROW = 12.5;
  const x = (m) => LAB + ((m - t0) / (t1 - t0)) * TW;
  const passo = Math.max(1, Math.ceil(nW / 30));
  const wW = TW / nW;
  const mesi = [];
  { const d0 = new Date(t0); let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
    for (;;) { const t = Date.UTC(y, m, 1, 12); if (t >= t1) break; mesi.push(t < t0 ? t0 : t); m++; if (m > 11) { m = 0; y++; } } }
  const testa = (h) => {
    let o = '';
    mesi.forEach((t, k) => {
      const dt = new Date(t);
      const fine = k + 1 < mesi.length ? mesi[k + 1] : t1;
      if (x(fine) - x(t) < 9) return;
      o += `<span class="hd m" style="left:${mm(x(t) + 0.8)};top:0">${MESI[dt.getUTCMonth()]} ${dt.getUTCFullYear()}</span>`;
    });
    for (let i = 0; i < nW; i += passo) {
      const t = t0 + i * 7 * DAYMS;
      const lab = sett ? `S${i + 1}` : String(new Date(t).getUTCDate());
      o += `<span class="hd" style="left:${mm(x(t))};top:4.8mm;width:${mm(wW * passo)}">${lab}</span>`;
    }
    for (let i = 0; i <= nW; i++) o += `<span class="vl" style="left:${mm(x(t0 + i * 7 * DAYMS))};top:4.6mm;height:${mm(h - 4.6)}"></span>`;
    for (const t of mesi) if (t > t0) o += `<span class="vl m" style="left:${mm(x(t))};top:0;height:4.2mm"></span><span class="vl m" style="left:${mm(x(t))};top:${mm(HEAD - 0.3)};height:${mm(h - HEAD + 0.3)}"></span>`;
    return o;
  };
  const blocchi = [];
  for (let k = 0; k < dated.length; k += 18) {
    const righe = dated.slice(k, k + 18);
    const h = HEAD + righe.length * ROW + 1;
    let o = testa(h);
    o += `<span class="hl" style="top:${mm(HEAD - 0.3)};border-top-color:#CFC8BD"></span>`;
    righe.forEach((l, r) => {
      const top = HEAD + r * ROW;
      const imp = l.impresa_id ? impById.get(l.impresa_id) : null;
      const c = (l.impresa_id && color.get(l.impresa_id)) || '#8E867B';
      const a = msd(l.start_date), b = msd(l.end_date) + DAYMS;
      const left = x(a), width = Math.max(1.4, x(b) - x(a));
      const durata = sett ? `${Wk.durata(l)} sett.` : `${Math.round((b - a) / DAYMS)} gg`;
      const quando = sett ? Wk.etichetta(l, p.start_date).replace(/^s/, 'S') : `${dShortY(l.start_date)} – ${dShortY(l.end_date)}`;
      o += `<div class="lab" style="top:${mm(top + 1)}"><b>${esc(l.nome)}</b><span>${esc([imp ? imp.ragione_sociale : 'da assegnare', quando].join(' · '))}</span></div>`;
      o += `<div class="bar" style="left:${mm(left)};top:${mm(top + 4.2)};width:${mm(width)};background:${c}">${width >= 11 ? esc(durata) : ''}</div>`;
      o += `<span class="hl" style="top:${mm(top + ROW)}"></span>`;
    });
    blocchi.push(`<div class="gt" style="height:${mm(h)}">${o}</div>`);
  }
  const usate = [...new Set(dated.map(l => l.impresa_id || ''))];
  const leg = usate.map(id => { const i = id ? impById.get(id) : null; return `<span><i style="background:${(id && color.get(id)) || '#8E867B'}"></i>${esc(i ? i.ragione_sociale : 'Impresa da assegnare')}</span>`; }).join('');
  return `${blocchi.join('')}<div class="leg-imp">${leg}</div>`;
}

function pscHtml(snap, opts = {}) {
  return wrap(pscBody(snap, opts), `PSC ${snap.project.title}`);
}

/** Word: lo stesso contenuto in un involucro che Word apre come documento. */
function pscWord(snap) {
  const body = pscBody(snap, { perWord: true });
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>PSC ${esc(snap.project.title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>@page Section1 { size: 21cm 29.7cm; margin: 2.2cm 1.8cm 2cm 1.8cm; } div.Section1 { page: Section1; }
body { font-family: Arial, sans-serif; font-size: 10pt; } h1 { font-size: 20pt; } h2 { font-size: 14pt; color: #22384F; border-bottom: 1pt solid #22384F; } h3 { font-size: 11pt; }
table { border-collapse: collapse; width: 100%; } th { background: #EEF2F6; text-align: left; } td, th { border: 0.5pt solid #D9D3C9; padding: 3pt 5pt; vertical-align: top; }
.muted { color: #7A736A; } .small { font-size: 8.5pt; } .eyebrow { font-size: 8pt; font-weight: bold; color: #7A736A; } .idx em { float: right; }
.gantt .bar { background: #22384F; height: 6pt; }
.indice { page-break-before: always; page-break-after: always; } .org td { border: 0; text-align: center; padding: 2pt; } .org .nodo { border: 1pt solid #22384F; padding: 3pt 6pt; } .org .r { display: block; font-size: 7pt; color: #7A736A; }
</style></head><body><div class="Section1">${body}</div></body></html>`;
}

// ── Fascicolo dell'opera (Allegato XVI), bozza ────────────────────────────────
const MANUTENZIONI = [
  { re: /copertur|tetto|manto|lattoner|gronda/i, opera: 'Copertura', intervento: 'Pulizia di gronde e pluviali, controllo e sostituzione di elementi del manto', rischi: 'Caduta dall\'alto, scivolamento, caduta di materiali', misure: 'Dispositivi di ancoraggio permanenti (UNI EN 795) o linea vita sulla copertura; accesso sicuro alla copertura (botola o scala fissa); parapetti o ganci per i lavori sul bordo', },
  { re: /facciat|intonac|cappott|tinteggi|ponteg/i, opera: 'Facciate', intervento: 'Pulizia, ripristino di intonaci e tinteggiature, controllo degli elementi aggettanti', rischi: 'Caduta dall\'alto, caduta di materiali su terzi', misure: 'Ponteggio o piattaforma elevabile; ancoraggi in facciata per il futuro montaggio di ponteggi; delimitazione delle aree sottostanti' },
  { re: /elettric/i, opera: 'Impianto elettrico', intervento: 'Verifiche periodiche, sostituzione di componenti', rischi: 'Elettrocuzione', misure: 'Quadri accessibili e sezionabili, schemi aggiornati, lavori solo da personale PES/PAV' },
  { re: /idraul|idric|termic|riscald|gas/i, opera: 'Impianti idrici, termici e gas', intervento: 'Manutenzione ordinaria e straordinaria', rischi: 'Ustioni, fughe di gas, lavoro in spazi ristretti', misure: 'Valvole di intercettazione accessibili e segnalate, locali tecnici areati, documentazione degli impianti' },
  { re: /serrament|infiss|vetr/i, opera: 'Serramenti', intervento: 'Pulizia dei vetri, regolazione e sostituzione di ferramenta', rischi: 'Caduta dall\'alto per serramenti ai piani alti, tagli', misure: 'Serramenti apribili verso l\'interno o pulibili dall\'interno; ancoraggi dove necessario' },
  { re: /ascensor/i, opera: 'Ascensore', intervento: 'Manutenzione periodica', rischi: 'Caduta nel vano, schiacciamento', misure: 'Accesso al vano solo da ditta abilitata; locale macchine protetto' },
];

function fascicoloHtml(snap) {
  const p = snap.project;
  const lav = snap.lavorazioni || [];
  const testo = lav.map(l => `${l.nome} ${l.scheda_id || ''}`).join(' | ');
  const schede = MANUTENZIONI.filter(m => m.re.test(testo));
  const body = `<h2 class="sec first">Fascicolo con le caratteristiche dell'opera</h2>
  <p class="eyebrow">D.Lgs. 81/2008 · art. 91 c.1 b e Allegato XVI · BOZZA da completare a fine lavori</p>
  <h3>Capitolo I — Descrizione sintetica dell'opera e soggetti</h3>
  <table><tbody>
   <tr><td style="width:52mm" class="muted">Opera</td><td><b>${esc(p.title)}</b></td></tr>
   <tr><td class="muted">Indirizzo</td><td>${esc(luogo(p.address, p.comune))}</td></tr>
   <tr><td class="muted">Durata effettiva dei lavori</td><td>${d(p.start_date)} – ${d(p.end_date)} (da aggiornare a fine lavori)</td></tr>
   ${sogg(p)}
  </tbody></table>
  ${p.descrizione ? `<p>${nl(p.descrizione)}</p>` : ''}
  <h3>Capitolo II — Misure preventive e protettive per i lavori successivi sull'opera</h3>
  <p class="small muted">Schede proposte dalle lavorazioni del PSC: vanno confermate con quanto effettivamente realizzato (dispositivi installati, accessi, documentazione).</p>
  ${schede.length ? `<table><thead><tr><th style="width:28mm">Parte dell'opera</th><th style="width:40mm">Intervento</th><th style="width:36mm">Rischi</th><th>Misure in dotazione dell'opera / ausiliarie</th></tr></thead><tbody>${schede.map(s => `<tr><td><b>${esc(s.opera)}</b></td><td>${esc(s.intervento)}</td><td>${esc(s.rischi)}</td><td>${esc(s.misure)}</td></tr>`).join('')}</tbody></table>` : '<p>—</p>'}
  <h3>Capitolo III — Riferimenti alla documentazione di supporto</h3>
  <table><thead><tr><th>Documento</th><th style="width:44mm">Redatto da</th><th style="width:30mm">Data</th><th style="width:36mm">Collocazione</th></tr></thead><tbody>
   ${['Elaborati architettonici as built', 'Elaborati strutturali e relazione di calcolo', 'Dichiarazioni di conformità degli impianti (D.M. 37/2008)', 'Certificazioni dei dispositivi di ancoraggio e delle linee vita', 'Manuali d\'uso e manutenzione dei componenti installati'].map(t => `<tr><td>${esc(t)}</td><td></td><td></td><td></td></tr>`).join('')}
  </tbody></table>`;
  return wrap(body, `Fascicolo ${p.title}`);
}

// ── Notifica preliminare (art. 99, Allegato XII) ─────────────────────────────
function maxLavoratori(lav) {
  const days = new Map();
  for (const l of lav) {
    if (!l.start_date || !l.end_date) continue;
    for (let t = Date.parse(`${l.start_date}T12:00:00Z`); t <= Date.parse(`${l.end_date}T12:00:00Z`); t += 86400000) {
      const k = new Date(t).toISOString().slice(0, 10);
      days.set(k, (days.get(k) || 0) + (Number(l.addetti) || 0));
    }
  }
  return days.size ? Math.max(...days.values()) : null;
}

function notificaDati(snap) {
  const p = snap.project;
  const s = p.soggetti || {};
  const lav = snap.lavorazioni || [];
  const imprese = snap.imprese || [];
  const durata = p.start_date && p.end_date ? Math.round((Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000) + 1 : null;
  const nome = (o) => (o && o.nome ? `${o.nome}${o.indirizzo ? `, ${o.indirizzo}` : ''}` : '');
  return [
    ['1', 'Data della comunicazione', ''],
    ['2', 'Indirizzo del cantiere', luogo(p.address, p.comune) + (p.provincia && p.provincia.length <= 3 ? ` (${p.provincia})` : '')],
    ['3', 'Committente', nome(s.committente)],
    ['4', 'Natura dell\'opera', p.tipo_opera || p.descrizione || ''],
    ['5', 'Responsabile dei lavori', nome(s.responsabile_lavori)],
    ['6', 'Coordinatore per la progettazione', nome(s.csp)],
    ['7', 'Coordinatore per l\'esecuzione', nome(s.cse)],
    ['8', 'Data presunta d\'inizio dei lavori', p.start_date ? d(p.start_date) : ''],
    ['9', 'Durata presunta dei lavori', durata ? `${durata} giorni naturali` : ''],
    ['10', 'Numero massimo presunto dei lavoratori in cantiere', String(maxLavoratori(lav) || '')],
    ['11', 'Numero previsto di imprese e lavoratori autonomi', imprese.length ? String(imprese.length) : ''],
    ['12', 'Imprese già selezionate', imprese.map(i => `${i.ragione_sociale}${i.piva ? ` (P.IVA ${i.piva})` : ''}`).join('; ')],
    ['13', 'Ammontare complessivo presunto dei lavori', p.importo_lavori ? `${eur(p.importo_lavori)} €` : ''],
  ];
}

function notificaHtml(snap) {
  const rows = notificaDati(snap);
  const body = `<h2 class="sec first">Dati per la notifica preliminare</h2>
  <p class="eyebrow">D.Lgs. 81/2008 · art. 99 e Allegato XII</p>
  <p class="small muted">La notifica è a cura del committente o del responsabile dei lavori, prima dell'inizio dei lavori, all'ASL e alla Direzione territoriale del lavoro competenti (in molte regioni con il servizio online). Questi sono i dati già presenti nel PSC.</p>
  <table><tbody>${rows.map(([n, k, v]) => `<tr><td style="width:8mm"><b>${n}</b></td><td style="width:70mm" class="muted">${esc(k)}</td><td><b>${esc(v || '—')}</b></td></tr>`).join('')}</tbody></table>`;
  return wrap(body, `Notifica preliminare ${snap.project.title}`);
}

// ── Verbale ───────────────────────────────────────────────────────────────────
function verbaleHtml({ project, verbale, nc = [], imprese = [], photos = {}, signatureDataUri = null, presenze = null }) {
  const impById = new Map(imprese.map(i => [i.id, i]));
  const ESITO = { ok: 'Regolare', no: 'Non conforme', na: 'Non applicabile' };
  const tipo = verbale.tipo === 'riunione' ? 'Verbale di riunione di coordinamento' : 'Verbale di sopralluogo';
  const when = new Date(verbale.data).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  const body = `<h2 class="sec first">${tipo} n. ${verbale.numero}</h2>
  <table><tbody>
   <tr><td style="width:48mm" class="muted">Cantiere</td><td><b>${esc(project.title)}</b>, ${esc(luogo(project.address, project.comune))}</td></tr>
   <tr><td class="muted">Data e ora</td><td>${esc(when)}</td></tr>
   <tr><td class="muted">Coordinatore</td><td>${esc((project.soggetti && project.soggetti.cse && project.soggetti.cse.nome) || verbale.signed_name || '')}</td></tr>
   ${presenze ? `<tr><td class="muted">In cantiere (dalle timbrature)</td><td>${presenze.totale} persone${presenze.perImpresa && presenze.perImpresa.length ? ` · ${esc(presenze.perImpresa.map(x => `${x.ragione_sociale} ${x.n}`).join(', '))}` : ''}</td></tr>` : ''}
  </tbody></table>
  ${(verbale.presenti || []).filter(x => x.presente !== false && (x.nome || x.ruolo)).length ? `<h3>Presenti</h3><table><thead><tr><th>Nome</th><th>Impresa / ruolo</th></tr></thead><tbody>${verbale.presenti.filter(x => x.presente !== false && (x.nome || x.ruolo)).map(x => `<tr><td>${esc(x.nome)}</td><td>${esc(x.ruolo || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ${(verbale.checklist || []).length ? `<h3>Controlli</h3><table><thead><tr><th>Voce</th><th style="width:34mm">Esito</th><th>Note</th></tr></thead><tbody>${verbale.checklist.map(c => `<tr><td>${esc(c.titolo)}</td><td><b>${ESITO[c.esito] || '—'}</b></td><td>${esc(c.nota || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ${nc.length ? `<h3>Non conformità</h3>${nc.map((n, i) => `<div style="break-inside:avoid;margin-bottom:3mm;padding:2.5mm 3mm;border:0.6pt solid ${n.sospensione ? '#A8453B' : '#ECE7DF'};border-radius:1.5mm">
    <b>${i + 1}. ${esc(n.descrizione)}</b><br><span class="small">Impresa: <b>${esc(n.impresa_id && impById.get(n.impresa_id) ? impById.get(n.impresa_id).ragione_sociale : '—')}</b> · gravità ${esc(n.gravita)}${n.scadenza ? ` · da risolvere entro il ${d(n.scadenza)}` : ' · da risolvere subito'}</span>
    ${n.sospensione ? '<br><b style="color:#A8453B">Sospensione della lavorazione interessata fino alla risoluzione (art. 92, c. 1 f).</b>' : ''}
    ${(n.photo_paths || []).map(pth => photos[pth] ? `<img class="photo" src="${photos[pth]}" style="margin-top:2mm;display:inline-block">` : '').join(' ')}
  </div>`).join('')}` : ''}
  ${verbale.osservazioni ? `<h3>Osservazioni e disposizioni</h3><p>${nl(verbale.osservazioni)}</p>` : ''}
  <div class="sign"><div><b>Il coordinatore per l'esecuzione</b><br>${signatureDataUri ? `<img src="${signatureDataUri}" style="height:20mm;margin-top:2mm">` : '<div class="line"></div>'}<span class="small">${esc(verbale.signed_name || '')}${verbale.signed_at ? ` · firmato il ${esc(new Date(verbale.signed_at).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}</span></div>
  <div><b>Per presa visione</b><br><span class="muted small">Imprese presenti</span><div class="line"></div></div></div>`;
  return wrap(body, `${tipo} ${verbale.numero}`);
}

const PROPOSTE = {
  sospensione: 'la sospensione dei lavori dell\'impresa fino all\'eliminazione delle inosservanze',
  allontanamento: 'l\'allontanamento dell\'impresa dal cantiere',
  risoluzione: 'la risoluzione del contratto con l\'impresa',
};

function testoSegnalazione({ project, impresa, nc = [], destinatario, proposta, precedente }) {
  const cse = (project.soggetti && project.soggetti.cse && project.soggetti.cse.nome) || 'Il coordinatore per l\'esecuzione';
  const elenco = nc.map((n, i) => `${i + 1}. ${n.descrizione}${n.created_at ? ` (rilevata il ${d(n.created_at)})` : ''}`).join('\n');
  const imp = impresa ? impresa.ragione_sociale : 'l\'impresa';
  if (destinatario === 'asl') {
    return `Oggetto: comunicazione ai sensi dell'art. 92, comma 1, lettera e) del D.Lgs. 81/2008 — cantiere ${project.title}, ${luogo(project.address, project.comune)}.\n\nIl coordinatore per la sicurezza in fase di esecuzione, ${cse}, comunica che il committente / responsabile dei lavori non ha adottato alcun provvedimento in merito alla segnalazione${precedente ? ` del ${d(precedente)}` : ''} riguardante ${imp}, senza fornire idonea motivazione.\n\nInosservanze segnalate:\n${elenco || '—'}\n\nSi trasmette la presente all'Azienda Sanitaria Locale e all'Ispettorato territoriale del lavoro competenti per territorio.`;
  }
  return `Oggetto: segnalazione ai sensi dell'art. 92, comma 1, lettera e) del D.Lgs. 81/2008 — cantiere ${project.title}, ${luogo(project.address, project.comune)}.\n\nIl coordinatore per la sicurezza in fase di esecuzione, ${cse}, segnala al committente / responsabile dei lavori le seguenti inosservanze di ${imp} alle disposizioni degli articoli 94, 95, 96 e 97, comma 1, e alle prescrizioni del piano di sicurezza e coordinamento:\n${elenco || '—'}\n\nPropone ${PROPOSTE[proposta] || PROPOSTE.sospensione}.\n\nSi chiede di comunicare i provvedimenti adottati. In mancanza di provvedimenti senza idonea motivazione, il coordinatore ne darà comunicazione all'Azienda Sanitaria Locale e all'Ispettorato territoriale del lavoro competenti.`;
}

function segnalazioneHtml({ project, testo, destinatario }) {
  const s = project.soggetti || {};
  const cse = s.cse || {};
  const a = destinatario === 'asl'
    ? '<b>All\'Azienda Sanitaria Locale</b> — Servizio prevenzione e sicurezza negli ambienti di lavoro<br><b>All\'Ispettorato territoriale del lavoro</b><br>competenti per territorio'
    : `<b>Al committente</b> ${esc((s.committente && s.committente.nome) || '')}${s.responsabile_lavori && s.responsabile_lavori.nome ? `<br><b>Al responsabile dei lavori</b> ${esc(s.responsabile_lavori.nome)}` : ''}`;
  const body = `<div style="display:flex;justify-content:space-between;gap:8mm;margin-bottom:8mm"><div class="small">${esc(cse.studio || '')}<br>${esc(cse.nome || '')}${cse.qualifica ? `, ${esc(cse.qualifica)}` : ''}<br>${esc([cse.telefono, cse.email].filter(Boolean).join(' · '))}</div><div class="small" style="text-align:right">${a}</div></div>
  <p class="small muted" style="margin-bottom:6mm">${dLong(new Date().toISOString())}</p>
  <p style="white-space:pre-line;line-height:1.7">${esc(testo)}</p>
  <div class="sign"><div><b>Il coordinatore per l'esecuzione</b><br><span class="muted">${esc(cse.nome || '')}</span><div class="line"></div></div><div></div></div>`;
  return wrap(body, 'Segnalazione art. 92');
}

module.exports = { entitaPresunta, rischiVersoEsterno, attrezzatureDi, datiImpresa, testoSegnalazione, segnalazioneHtml, PROPOSTE, luogo, pscHtml, pscWord, pscBody, fascicoloHtml, notificaHtml, notificaDati, verbaleHtml, maxLavoratori, SEZIONI, PALETTE };
