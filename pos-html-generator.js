'use strict';

/**
 * POS HTML Generator — v2 (layout-safe, sign images, async)
 * Regole ferree anti-sovrapposizione:
 *  1. table-layout: fixed su tutte le tabelle → nessuna cella esplode
 *  2. word-break: break-word ovunque → nessun testo esce dal bordo
 *  3. overflow: hidden su celle → contenuto troncato, mai sovrapposto
 *  4. @page :first RIMOSSO → header/footer Puppeteer non si sovrappone alla cover
 *  5. lavorazione-block: break-inside:auto → blocchi lunghi possono andare a pagina successiva
 *  6. min-width: 0 su ogni flex-child → flex non esplode mai
 */

const fs   = require('fs');
const { ZONE_ORDER } = require('./sign-selector');
const { editablePdfHtml } = require('./lib/pdfText');

// ── ESCAPE / HELPERS ──────────────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// F-489: un campo vuoto o sporco («UNKNOWN», «N/A», «[DA COMPILARE]») non si
// stampa mai: nelle righe chiave/valore la riga sparisce, altrove un trattino.
const VUOTO = /^\s*(?:<?\s*(?:unknown|n\/?a|null|undefined|da compilare)\s*>?|\[\s*da compilare\s*\]|-|—)?\s*$/i;
function pieno(val) {
  return val !== null && val !== undefined && !VUOTO.test(String(val));
}
function v(val) {
  return pieno(val) ? esc(val) : '<span class="placeholder">—</span>';
}
function riga(label, val, html) {
  return pieno(val) ? `<tr><td>${esc(label)}</td><td>${html || esc(val)}</td></tr>` : '';
}
function boldify(text) {
  if (!text) return '';
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function riskBadgeClass(level) {
  const l = (level || '').toLowerCase();
  if (l.includes('molto alto') || l.includes('intollerabile') || l.includes('critico')) return 'badge-very-high';
  if (l.includes('alto')  || l.includes('rilevante'))  return 'badge-high';
  if (l.includes('medio') || l.includes('moderato'))   return 'badge-medium';
  if (l.includes('basso') || l.includes('accettabile') || l.includes('trascurabile')) return 'badge-low';
  return '';
}
// Stesse soglie della legenda del POS (lib/posSezione5.js, lib/lavorazioniSchede.js
// livello()): 1-3 basso, 4-7 medio, 8-11 alto, 12-16 molto alto. F-261: prima
// R=8 usciva arancione accanto al badge "Alto" rosso, R=12 rosso accanto a "Molto alto".
function riskNumClass(val) {
  const n = parseFloat(String(val || '').replace(',', '.'));
  if (isNaN(n)) return '';
  if (n <= 3)  return 'risk-low';
  if (n < 8)   return 'risk-medium';
  if (n < 12)  return 'risk-high';
  return 'risk-very-high';
}
// Format budget value with Italian thousand separators
// Accepts "150000" → "150.000" or already-formatted "150.000,00" → unchanged
function formatBudget(val) {
  if (!val && val !== 0) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10).toLocaleString('it-IT');
  return s;
}
// Convert ISO date "2024-03-15" → "15/03/2024"; pass-through anything else
function formatDate(val) {
  if (!val) return null;
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(val);
}

// ── SIGN IMAGE LOADER (async) ─────────────────────────────────────────────────
async function loadSignImage(imagePath) {
  try {
    const data = fs.readFileSync(imagePath); // eslint-disable-line security/detect-non-literal-fs-filename
    return `data:image/jpeg;base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}
async function enrichSignsWithImages(signs) {
  return Promise.all(signs.map(async sign => ({
    ...sign,
    imgSrc: await loadSignImage(sign.path)
  })));
}

// ── MARKDOWN → HTML ───────────────────────────────────────────────────────────
function isTableRow(line)  { return line.trim().startsWith('|') && line.trim().endsWith('|'); }
function isSepRow(line)    { return /^\|[\s\-:|]+\|$/.test(line.trim()); }

function parseTable(rows) {
  const valid = rows.filter(r => !isSepRow(r));
  if (valid.length === 0) return '';
  const headers = valid[0].split('|').slice(1, -1).map(c => c.trim());
  // F-350: larghezza di ogni colonna in proporzione al testo che contiene.
  // Prima erano tutte uguali: una colonna "P" con una cifra larga quanto
  // quella delle misure, e ogni riga lunga mezza pagina.
  const body = valid.slice(1).map(r => r.split('|').slice(1, -1).map(c => c.trim()));
  const peso = headers.map((h, ci) => {
    const lens = body.map(r => (r[ci] || '').replace(/\*\*/g, '').length);
    const media = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
    const parolaLungaHdr = Math.max(...h.split(/\s+/).map(w => w.length));
    return Math.max(media, parolaLungaHdr * 0.8, h.length * 0.45, 3) ** 0.6;
  });
  const tot = peso.reduce((a, b) => a + b, 0);
  // Colonne di numeri o etichette brevi (R, LEX, fascia): mai a capo dentro la cella
  const corte = headers.map((h, ci) => Math.max(0, ...body.map(r => (r[ci] || '').replace(/\*\*/g, '').length)) <= 8);
  const larghezze = headers.length >= 3 ? peso.map((p, ci) => Math.max(ci === 0 ? 12 : corte[ci] ? 8 : 6, Math.round((p / tot) * 100))) : null;
  let html = '<table class="allow-break"><thead><tr>';
  headers.forEach((h, ci) => { html += `<th${larghezze ? ` style="width:${larghezze[ci]}%${h.length <= 6 ? ';white-space:nowrap' : ''}"` : ''}>${boldify(h)}</th>`; });
  html += '</tr></thead><tbody>';
  valid.slice(1).forEach(row => {
    const cells = row.split('|').slice(1, -1).map(c => c.trim());
    html += '<tr>';
    cells.forEach((cell, ci) => {
      const hdr = (headers[ci] || '').toLowerCase();
      const isLivello = /livello/i.test(hdr);
      const isRiskNum = /^\s*r\s*[(=]|^\s*r\s*$|^\s*r\s+res\.?\s*$/i.test(hdr);
      let content = boldify(cell);
      if (isLivello && cell) {
        const bc = riskBadgeClass(cell);
        if (bc) content = `<span class="badge ${bc}">${esc(cell)}</span>`;
      } else if (isRiskNum && /^\d+([,.]\d+)?$/.test(cell.trim())) {
        const rc = riskNumClass(cell);
        content = `<span class="risk-num ${rc}">${esc(cell)}</span>`;
      }
      html += `<td${larghezze && corte[ci] ? ' style="white-space:nowrap"' : ''}>${content}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

function parseMd(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let html = '';
  let tableRows = [];
  let listItems = [];

  function flushTable() {
    if (!tableRows.length) return;
    html += parseTable(tableRows);
    tableRows = [];
  }
  function flushList() {
    if (!listItems.length) return;
    html += '<ul>' + listItems.map(i => `<li>${i}</li>`).join('') + '</ul>';
    listItems = [];
  }

  for (const line of lines) {
    const t = line.trim();
    if (isTableRow(t)) { flushList(); tableRows.push(t); continue; }
    else if (tableRows.length) { flushTable(); }
    if (/^[-*•]\s+/.test(t)) { listItems.push(boldify(t.replace(/^[-*•]\s+/, ''))); continue; }
    else if (listItems.length && t)  { flushList(); }
    else if (listItems.length && !t) { flushList(); continue; }
    if (!t) { continue; }
    if (t === '---' || t === '***' || t === '___') continue;
    // Markdown headings ## and # → styled sub-headers within lavorazioni
    if (/^#{1,2}\s/.test(t)) {
      const text = t.replace(/^#+\s+/, '');
      html += `<p class="bold-line">${boldify(text)}</p>`;
      continue;
    }
    if (/^\*\*[^*].*(\*\*:?|:)$/.test(t)) { html += `<p class="bold-line">${boldify(t)}</p>`; continue; }
    html += `<p>${boldify(t)}</p>`;
  }
  if (tableRows.length) flushTable();
  if (listItems.length) flushList();
  return html;
}

// ── LAVORAZIONE BLOCKS ────────────────────────────────────────────────────────
// F-489: la legenda P×D era scritta sotto ogni lavorazione (11 volte in un
// POS): si toglie dai blocchi e si stampa una volta in testa alla sezione.
const LEGENDA_RE = /^\s*Legenda:\s*P\s*=\s*probabilit[aà].*$/gim;
const LEGENDA = 'Legenda: P = probabilità (1 improbabile, 4 molto probabile); D = danno (1 lieve, 4 molto grave); R = P×D (1-3 basso, 4-7 medio, 8-11 alto, 12-16 molto alto).';

// Ogni titolo di blocco («Fasi operative:», «DPI obbligatori:», …) resta sulla
// stessa pagina del suo contenuto: titolo + elemento seguente in un .blk.
function blocchiInteri(html) {
  const parti = html.match(/<(p|ul|ol|table)\b[^>]*>[\s\S]*?<\/\1>/g) || [html];
  let out = '';
  for (let i = 0; i < parti.length; i++) {
    const cur = parti[i];
    const next = parti[i + 1];
    if (/^<p class="bold-line"/.test(cur) && next) {
      const righe = (next.match(/<tr>/g) || []).length;
      out += righe > 14 ? `${cur}${next}` : `<div class="blk">${cur}${next}</div>`;
      i++;
    } else out += cur;
  }
  return out;
}

function buildLavorazioneHtml(aiRisks) {
  if (!aiRisks || !aiRisks.trim()) {
    return '<div class="callout">Nessuna lavorazione generata. Integrare manualmente.</div>';
  }
  const blocks = aiRisks.split(/(?=^### )/m).filter(b => b.trim());
  let html = '';
  let legenda = false;
  for (const block of blocks) {
    const lines  = block.split('\n');
    let title    = '';
    let bodyIdx  = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('### ')) {
        title   = lines[i].trim().slice(4).trim().replace(/^\[|\]$/g, '');
        bodyIdx = i + 1;
        break;
      }
    }
    if (!title) continue;
    let bodyStr = lines.slice(bodyIdx).join('\n').replace(/^---\s*$/mg, '').trim();
    if (LEGENDA_RE.test(bodyStr)) { legenda = true; LEGENDA_RE.lastIndex = 0; bodyStr = bodyStr.replace(LEGENDA_RE, '').trim(); }
    LEGENDA_RE.lastIndex = 0;
    const body = blocchiInteri(parseMd(bodyStr));
    // testata + prima riga (di solito la descrizione) non si separano mai
    const prima = body.match(/^<p\b(?! class="bold-line")[^>]*>[\s\S]*?<\/p>/);
    html += `
    <div class="lavorazione-block">
      <div class="lav-top"><div class="lav-header">${esc(title)}</div>${prima ? `<div class="lav-body">${prima[0]}</div>` : ''}</div>
      <div class="lav-body">${prima ? body.slice(prima[0].length) : body}</div>
    </div>`;
  }
  if (!html) return '<div class="callout">Nessuna lavorazione generata.</div>';
  return (legenda ? `<p class="legenda">${esc(LEGENDA)}</p>` : '') + html;
}

// ── SEGNALETICA — helpers ─────────────────────────────────────────────────────
const CAT_META = {
  'Cartelli di divieto fondo bianco contenuto rosso': { label: 'Divieto',                  color: '#CC0000', iso: 'P' },
  'Cartelli fondo blu (obbligo)':                     { label: 'Obbligo',                  color: '#1565C0', iso: 'M' },
  'Cartelli fondo giallo (pericolo)':                 { label: 'Avvertimento / Pericolo',  color: '#B8860B', iso: 'W' },
  'Cartelli fondo verde':                             { label: 'Emergenza / Salvataggio',  color: '#2E7D32', iso: 'E' },
  'Cartelli antincendio':                             { label: 'Antincendio',              color: '#8B0000', iso: 'F' },
  'Generale':                                         { label: 'Generale',                 color: '#37474F', iso: ''  },
};
function catColor(category) {
  return (CAT_META[category] || CAT_META['Generale']).color;
}
function extractIso(norm) {
  const m = (norm || '').match(/ISO\s+7010\s+[A-Z]\d+/i);
  return m ? m[0].replace(/\s+/, ' ') : '';
}

// ── SEGNALETICA CON IMMAGINI ──────────────────────────────────────────────────
function buildSegnaleticaHtml(signsWithImages) {
  if (!signsWithImages || signsWithImages.length === 0) {
    return `<p>La segnaletica di sicurezza è definita in conformità al D.lgs 81/2008 Titolo V
    e alle norme ISO 7010. I cartelli devono essere esposti in posizione visibile,
    ad altezza non inferiore a 2 m da terra, nelle aree indicate dal CSE.</p>`;
  }

  // ── intro normativa
  let html = `<p class="sign-intro">La segnaletica di sicurezza è predisposta in conformità al
  <strong>D.lgs 81/2008 Titolo V (artt. 161–166)</strong> e alle norme
  <strong>ISO 7010:2019</strong>. I cartelli sono selezionati automaticamente in base alle
  lavorazioni previste e devono essere esposti nelle ubicazioni indicate,
  in posizione ben visibile a un'altezza minima di <strong>2 m da terra</strong>,
  garantendo contrasto visivo con lo sfondo.</p>`;

  // ── tabella riepilogativa per categoria
  const catCounts = {};
  for (const sign of signsWithImages) {
    const cat = sign.category || 'Generale';
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  }
  const total = signsWithImages.length;

  html += `<table class="sign-summary-table">
  <thead>
    <tr>
      <th style="width:6%"></th>
      <th style="width:42%">Categoria</th>
      <th style="width:36%">Riferimento normativo</th>
      <th style="width:16%">N° cartelli</th>
    </tr>
  </thead>
  <tbody>`;

  const catOrder = [
    'Cartelli di divieto fondo bianco contenuto rosso',
    'Cartelli fondo blu (obbligo)',
    'Cartelli fondo giallo (pericolo)',
    'Cartelli fondo verde',
    'Cartelli antincendio',
    'Generale',
  ];
  for (const cat of catOrder) {
    if (!catCounts[cat]) continue;
    const meta = CAT_META[cat] || CAT_META['Generale'];
    html += `<tr>
      <td><span class="cat-dot" style="background:${meta.color}"></span></td>
      <td><strong>${meta.label}</strong></td>
      <td style="font-size:8pt;color:#5B6672">D.lgs 81/08 Titolo V${meta.iso ? ` — ISO 7010 ${meta.iso}xxx` : ''}</td>
      <td style="text-align:center;font-weight:bold">${catCounts[cat]}</td>
    </tr>`;
  }
  html += `<tr class="sign-summary-total">
    <td colspan="3"><strong>TOTALE CARTELLI NEL CANTIERE</strong></td>
    <td style="text-align:center;font-weight:bold">${total}</td>
  </tr>
  </tbody></table>`;

  // ── cartelli per zona
  for (const zone of ZONE_ORDER) {
    const zoneSigns = signsWithImages.filter(s => s.zone === zone);
    if (!zoneSigns.length) continue;

    html += `<div class="sign-zone-header">${esc(zone)}</div>
    <div class="signs-grid">`;

    for (const sign of zoneSigns) {
      const name  = sign.name.replace(/\.jpg$/i, '');
      const isoCode = extractIso(sign.norm || '');
      const color = catColor(sign.category);
      const loc   = (sign.location || '').replace(/\n/g, ' ');
      html += `
      <div class="sign-card" style="border-top:4pt solid ${color}">
        ${sign.imgSrc
          ? `<img src="${sign.imgSrc}" class="sign-img" alt="${esc(name)}">`
          : `<div class="sign-img-placeholder">?</div>`}
        <div class="sign-name">${esc(name)}</div>
        ${isoCode ? `<div class="sign-iso" style="color:${color}">${esc(isoCode)}</div>` : ''}
        ${loc ? `<div class="sign-location-text">${esc(loc)}</div>` : ''}
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function buildCss() {
  return `
/* ═══════════════════════════════════════════════════════════════════
   PALLADIA PDF — POS, stile v11 (F-489)
   Stessa famiglia del PSC (F-492) e della piattaforma (F-442): inchiostro
   #10171F, grigi freddi, azzurro #E8F1F9/#B5D3EE, titoli in Archivo
   condensato, testo in Plus Jakarta Sans. Misure in px a mezzi pixel (F-302).
   Intestazione e piè di pagina: Puppeteer nativo, margini fissi 26/24 mm
   (vedi le regole di stampa in fondo, invariate).
   ═══════════════════════════════════════════════════════════════════ */
@import url('https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,600..900&family=Plus+Jakarta+Sans:wght@400..800&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; word-break: break-word; overflow-wrap: break-word; min-width: 0; }
html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Plus Jakarta Sans', Arial, Helvetica, sans-serif; font-size: 13px; font-weight: 420; line-height: 1.55; color: #10171F; background: #FFFFFF; }
.doc { width: 100%; padding: 0 16mm; }
.doc.debug { outline: 1px dashed #9F2F25; }
img { max-width: 100%; }
strong, b { font-weight: 700; }
.disp, .cover-title, .cover-rev b, .cover-opera .t, .section-title, .emergency-number { font-family: 'Archivo', 'Arial Narrow', sans-serif; font-stretch: 72%; font-weight: 800; letter-spacing: -0.2px; }
.ey { font-size: 9.5px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: #5B6672; }

/* ── Copertina ───────────────────────────────────────────────────── */
.cover { display: flex; flex-direction: column; break-after: page; page-break-after: always; }
.cover-kind { display: flex; justify-content: space-between; align-items: baseline; gap: 6mm; }
.cover-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; padding-bottom: 6mm; border-bottom: 1.5px solid #10171F; }
.cover-title { font-size: 56px; line-height: 0.95; margin-top: 4mm; }
.cover-rev { text-align: right; white-space: nowrap; }
.cover-rev b { display: block; font-size: 29px; line-height: 1; }
.cover-rev span { font-size: 11px; color: #5B6672; }
.cover-opera { margin-top: 9mm; padding: 6mm 7mm; background: #F5F7F9; border-left: 2.2mm solid #B5D3EE; border-radius: 0 2.5mm 2.5mm 0; }
.cover-opera .t { font-size: 25px; line-height: 1.15; margin-top: 1.5mm; }
.cover-opera .a { font-size: 14px; margin-top: 1mm; color: #3A4652; }
.cover-pill { display: inline-block; margin-top: 3mm; background: #FFFFFF; border: 0.8px solid #CBD3DB; border-radius: 10mm; padding: 0.7mm 3mm; font-size: 10.5px; font-weight: 700; }
.cover-opera .d { font-size: 12px; color: #3A4652; margin-top: 3mm; }
.cover-dati { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 5mm; padding-top: 3.5mm; border-top: 0.8px solid #CBD3DB; }
.cover-dati div { padding-right: 3mm; }
.cover-dati b { display: block; font-size: 16px; margin-top: 0.6mm; }
.cover-persone { margin-top: 9mm; }
.cover-persone table { margin-top: 2mm; font-size: 13px; }
.cover-persone td { padding: 2.4mm 2mm 2.4mm 0; border-bottom: 0.8px solid #E3E7EC; background: none; }
.cover-persone td.k { width: 62mm; color: #5B6672; }
.cover-firme { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.cover-firma { border: 0.8px solid #CBD3DB; border-radius: 2.5mm; padding: 3.5mm 4mm; height: 30mm; display: flex; flex-direction: column; }
.cover-firma .n { font-weight: 700; margin-top: 1mm; }
.cover-firma .s { margin-top: auto; border-bottom: 0.8px solid #8A949E; font-size: 9px; color: #8A949E; padding-bottom: 0.6mm; }
.cover-colophon { margin-top: 3mm; display: flex; justify-content: space-between; font-size: 10px; color: #8A949E; }

/* ── Sezioni ─────────────────────────────────────────────────────── */
.section-title { display: flex; align-items: baseline; gap: 3.5mm; font-size: 27px; line-height: 1.05; color: #10171F; margin: 10mm 0 4mm; padding-bottom: 2.6mm; border-bottom: 1.5px solid #10171F; }
.section-title .n { font-size: 27px; color: #8A949E; min-width: 6mm; }
.section-title:first-child { margin-top: 0; }
.section-title.page-break { margin-top: 0; }
.sub-title { font-size: 15px; font-weight: 750; color: #10171F; margin: 5.5mm 0 2mm; }
p { margin: 0 0 2.4mm; }
ul, ol { margin: 0 0 3mm; padding-left: 0; }
ul { list-style: none; }
ul li { position: relative; padding-left: 5mm; margin: 0 0 1.2mm; }
ul li::before { content: ''; position: absolute; left: 1mm; top: 2.3mm; width: 1.4mm; height: 1.4mm; border-radius: 1mm; background: #3A4652; }
ol { padding-left: 6mm; }
ol li { margin: 0 0 1.2mm; padding-left: 1mm; }
.muted { color: #5B6672; }
.placeholder { color: #8A949E; }
hr { border: 0; border-top: 0.8px solid #E3E7EC; margin: 5mm 0; }
.callout { background: #F5F7F9; border-radius: 2mm; padding: 2.4mm 3.5mm; font-size: 12px; color: #3A4652; margin: 0 0 3mm; }
.legenda { font-size: 11.5px; color: #5B6672; margin: 0 0 5mm; }

/* ── Tabelle ─────────────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 1.5mm 0 4mm; font-size: 12px; }
th { text-align: left; color: #5B6672; font-weight: 800; font-size: 9.5px; letter-spacing: 0.9px; text-transform: uppercase; padding: 1.8mm 2.2mm; border-bottom: 1.3px solid #10171F; background: none; }
td { padding: 2mm 2.2mm; border-bottom: 0.8px solid #E3E7EC; vertical-align: top; background: none; overflow-wrap: anywhere; }
table.kv td:first-child { width: 62mm; color: #5B6672; padding-left: 0; }
table.kv td:last-child { font-weight: 600; }
.badge { display: inline-block; min-width: 17mm; text-align: center; padding: 0.3mm 2mm; border-radius: 6mm; font-size: 10px; font-weight: 800; white-space: nowrap; }
.badge-low { background: #E9F3EC; color: #2F6A43; }
.badge-medium { background: #FDF0E1; color: #9A520E; }
.badge-high { background: #FBE7E4; color: #9F2F25; }
.badge-very-high { background: #9F2F25; color: #FFFFFF; }
.risk-num { font-weight: 800; font-variant-numeric: tabular-nums; }
.risk-low { color: #2F6A43; } .risk-medium { color: #9A520E; } .risk-high { color: #9F2F25; } .risk-very-high { color: #9F2F25; }

/* ── Lavorazioni ─────────────────────────────────────────────────── */
.lavorazione-block { margin: 0 0 8mm; }
.lav-header { background: #E8F1F9; color: #10171F; font-size: 16.5px; font-weight: 800; padding: 3mm 4mm; border-radius: 2mm; }
.lav-body { padding: 2.4mm 4mm 0; }
.lav-body p { font-size: 12.5px; }
.lav-body .bold-line { font-size: 10.5px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: #3A4652; margin: 4mm 0 1.6mm; }
.lav-body .bold-line strong { font-weight: 800; }
.lav-body p.desc .bold-line, .lav-body p.desc strong { text-transform: none; letter-spacing: 0; font-size: 12.5px; color: #10171F; }
.lav-body ul, .lav-body ol { font-size: 12.5px; }
.lav-body table { font-size: 12px; }
.lav-top, .blk { break-inside: avoid; page-break-inside: avoid; }

/* ── Segnaletica ─────────────────────────────────────────────────── */
.sign-intro { font-size: 12.5px; }
.sign-summary-table td { font-size: 12px; }
.sign-summary-total td { font-weight: 800; border-top: 1.3px solid #10171F; border-bottom: 0; }
.cat-dot { display: inline-block; width: 3mm; height: 3mm; border-radius: 1mm; }
.sign-zone-header { font-size: 10.5px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: #3A4652; margin: 6mm 0 2mm; padding-bottom: 1.5mm; border-bottom: 0.8px solid #E3E7EC; }
.signs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-bottom: 3mm; }
.sign-card { border: 0.8px solid #E3E7EC; border-radius: 2mm; padding: 2.5mm; text-align: center; }
.sign-img { width: 22mm; height: 22mm; object-fit: contain; display: block; margin: 0 auto 1.5mm; }
.sign-img-placeholder { width: 22mm; height: 22mm; margin: 0 auto 1.5mm; background: #F5F7F9; border-radius: 1mm; }
.sign-name { font-size: 10.5px; font-weight: 700; line-height: 1.3; }
.sign-iso { font-size: 9.5px; font-weight: 800; margin-top: 0.5mm; }
.sign-location-text { font-size: 9px; color: #5B6672; margin-top: 1mm; line-height: 1.35; }

/* ── Emergenza ───────────────────────────────────────────────────── */
.emergency-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin: 2mm 0 4mm; }
.emergency-card { border: 0.8px solid #CBD3DB; border-radius: 2.5mm; padding: 3mm 4mm; background: #FFFFFF; }
.emergency-card.alt { background: #F5F7F9; }
.emergency-number { display: block; font-size: 29px; line-height: 1; color: #10171F; }
.emergency-number.small { font-size: 19px; }
.emergency-label { font-size: 11px; color: #5B6672; margin-top: 1mm; }

/* ── Firme ───────────────────────────────────────────────────────── */
.signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin: 4mm 0; }
.signature-box { border: 0.8px solid #CBD3DB; border-radius: 2.5mm; padding: 3.5mm 4mm; }
.signature-box.wide { margin: 5mm 0; }
.sig-role { font-size: 9.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #5B6672; }
.sig-name { font-weight: 700; margin-top: 1mm; min-height: 5mm; }
.sig-body { display: flex; gap: 4mm; margin-top: 3mm; }
.sig-stamp { flex: 0 0 22mm; height: 18mm; border: 0.8px dashed #CBD3DB; border-radius: 1.5mm; font-size: 9px; color: #8A949E; display: flex; align-items: center; justify-content: center; }
.sig-fields { flex: 1; display: flex; flex-direction: column; gap: 3mm; }
.sig-field { display: flex; align-items: flex-end; gap: 2mm; }
.sig-label { font-size: 9px; color: #8A949E; width: 9mm; }
.sig-line { flex: 1; border-bottom: 0.8px solid #8A949E; height: 6mm; }
.page-break { break-before: page; page-break-before: always; }
.no-break, .keep-next { break-inside: avoid; page-break-inside: avoid; }

/* ══════════════════════════════════════════════════════════════════════
   REGOLE DI STAMPA — invariate (vedi memoria pdf-architecture)
   @page margin = Puppeteer margin 26/24 mm → layout su 247mm/pag.
   ══════════════════════════════════════════════════════════════════════ */
@page { size: A4; margin: 26mm 0 24mm 0; }
html, body { margin: 0 !important; padding: 0 !important; }
.doc { width: 100% !important; max-width: 100% !important; padding: 0 16mm !important; box-sizing: border-box !important; }
.cover { height: 247mm !important; overflow: hidden !important; }
table { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; border-collapse: collapse !important; }
th, td { max-width: 100% !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
table.allow-break tr { break-inside: auto !important; page-break-inside: auto !important; }
h1, h2, h3, .section-title, .sub-title, .lav-header, .bold-line, .sign-zone-header { break-after: avoid-page !important; page-break-after: avoid !important; }
img, .signature-box, .callout, .lav-header, .sign-card, .emergency-card { break-inside: avoid !important; page-break-inside: avoid !important; }
`;
}

// ── FIRMA BOX — helper riusabile ──────────────────────────────────────────────
function buildSigBox(role, name, fullWidth = false) {
  return `
  <div class="signature-box${fullWidth ? ' wide' : ''}">
    <div class="sig-role">${esc(role)}</div>
    <div class="sig-name">${name}</div>
    <div class="sig-body">
      <div class="sig-stamp">Timbro</div>
      <div class="sig-fields">
        <div class="sig-field">
          <div class="sig-label">Firma</div>
          <div class="sig-line"></div>
        </div>
        <div class="sig-field">
          <div class="sig-label">Data</div>
          <div class="sig-line"></div>
        </div>
      </div>
    </div>
  </div>`;
}

// ── MAIN BUILDER (async per caricamento immagini cartelli) ─────────────────────
// F-342/F-343: tabelle costruite da ciò che il POS dice davvero (lib/posPdfContenuti.js)
const PC = require('./lib/posPdfContenuti');

async function generatePosHtml(posData, revision, aiRisks, signs = []) {
  const d    = posData || {};
  const rev  = revision || 1;
  const oggi = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const siteName = d.siteAddress || d.siteName || 'Cantiere';
  const docTitle = `POS – ${siteName} – Rev. ${rev}`;
  const rumoreCalcolato = /^### 5\.1 Esposizione al rumore/m.test(aiRisks || '');

  const workersCount = (d.workers && d.workers.length > 0)
    ? d.workers.length
    : (pieno(d.numWorkers) ? d.numWorkers : '');

  // F-489: righe vuote da compilare a mano, mai segnaposto stampati
  const workerDeclRows = (d.workers && d.workers.length > 0)
    ? d.workers.map((w, i) => `<tr>
        <td>${i + 1}</td><td>${pieno(w.name) ? esc(w.name) : '&nbsp;'}</td><td>&nbsp;</td><td>&nbsp;</td>
      </tr>`).join('')
    : [1, 2, 3, 4, 5, 6].map(i => `<tr><td>${i}</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>`).join('');

  // Carica immagini cartelli in parallelo
  const signsWithImages = await enrichSignsWithImages(signs);

  // ── COPERTINA (F-489: stessa famiglia del PSC) ────────────────────────────
  const tipo = pieno(d.tipoAppalto) ? d.tipoAppalto.charAt(0).toUpperCase() + d.tipoAppalto.slice(1) : '';
  const pill = [tipo, d.presentedBy === 'subappaltatore' && pieno(d.affidatariaName) ? `affidataria ${d.affidatariaName}` : ''].filter(Boolean).join(' · ');
  const titoloCantiere = [d.siteName, d.client, siteName].find(pieno) || 'Cantiere';
  const indirizzo = pieno(d.siteAddress) && d.siteAddress !== titoloCantiere ? d.siteAddress : '';
  const descrizione = [d.descrizioneOpera, d.workType].filter(pieno).join(': ');
  const dati = [
    ['Inizio lavori', pieno(d.startDate) ? formatDate(d.startDate) : ''],
    ['Fine lavori', pieno(d.endDate) ? formatDate(d.endDate) : ''],
    ['Operai in cantiere', workersCount ? String(workersCount) : ''],
    pieno(d.budget) ? ['Importo lavori', `€ ${formatBudget(d.budget)}`] : ['Orario', `${d.inizioTurno || '08:00'} · ${d.oreLavorative || '8'} ore`],
  ].filter(([, val]) => val);
  const figure = [
    ['Datore di lavoro', d.datoreLavoro], ['RSPP', d.rspp], ['Medico competente', d.medico],
    ['Coordinatore per l\'esecuzione (CSE)', d.cse],
  ].filter(([, val]) => pieno(val));
  const cover = `
<section class="cover">
  <div class="cover-kind"><span class="ey">D.Lgs. 81/2008 · art. 89 c.1 h e Allegato XV</span><span class="ey">${esc([d.companyName, pieno(d.companyVat) ? `P.IVA ${d.companyVat}` : ''].filter(pieno).join(' · '))}</span></div>
  <div class="cover-head"><div class="cover-title">Piano Operativo<br>di Sicurezza</div><div class="cover-rev"><b>Rev.&#160;${rev}</b><span>${oggi}</span></div></div>
  <div class="cover-opera">
    <span class="ey">Cantiere</span>
    <div class="t">${esc(titoloCantiere)}</div>
    ${indirizzo ? `<div class="a">${esc(indirizzo)}</div>` : ''}
    ${pill ? `<span class="cover-pill">${esc(pill)}</span>` : ''}
    ${descrizione ? `<div class="d">${esc(descrizione.length > 300 ? `${descrizione.slice(0, 297)}…` : descrizione)}</div>` : ''}
    ${dati.length ? `<div class="cover-dati">${dati.map(([k, val]) => `<div><span class="ey">${esc(k)}</span><b>${esc(val)}</b></div>`).join('')}</div>` : ''}
  </div>
  ${figure.length ? `<div class="cover-persone"><span class="ey">Figure della sicurezza</span><table><tbody>${figure.map(([k, val]) => `<tr><td class="k">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</tbody></table></div>` : ''}
  <div class="cover-firme">
    <div class="cover-firma"><span class="ey">Il datore di lavoro</span><span class="n">${esc(pieno(d.datoreLavoro) ? d.datoreLavoro : (d.companyName || ''))}</span><span class="s">Firma</span></div>
    <div class="cover-firma"><span class="ey">Il CSE, per presa visione</span><span class="n">${pieno(d.cse) ? esc(d.cse) : '&nbsp;'}</span><span class="s">Firma e data</span></div>
  </div>
  <div class="cover-colophon"><span>Redatto ai sensi del D.Lgs. 81/2008, art. 89 c.1 lett. h</span><span>Redatto con Palladia</span></div>
</section>`;

  // ── PAGINA FIRME (INIZIO DOCUMENTO) ────────────────────────────────────────
  const s0_firme = `
<div class="section-title page-break">Firme e sottoscrizione del documento</div>
<p>Il presente Piano Operativo di Sicurezza, redatto ai sensi dell'art. 89 comma 1 lettera h)
del D.lgs 81/2008 e s.m.i., viene sottoscritto dalle figure responsabili dell'impresa esecutrice
per attestazione di redazione, presa visione e accettazione delle disposizioni contenute.</p>
<div class="signature-grid">
  ${buildSigBox('Datore di Lavoro dell\'impresa esecutrice', pieno(d.datoreLavoro) ? esc(d.datoreLavoro) : esc(d.companyName || ''))}
  ${buildSigBox('RSPP — Responsabile Servizio Prevenzione e Protezione', pieno(d.rspp) ? esc(d.rspp) : '')}
  ${buildSigBox('RLS — Rappresentante dei Lavoratori per la Sicurezza', pieno(d.rls) ? esc(d.rls) : '')}
  ${buildSigBox('Medico Competente', pieno(d.medico) ? esc(d.medico) : '')}
</div>
${buildSigBox('CSE — Coordinatore per la Sicurezza in fase di Esecuzione (per presa visione)', pieno(d.cse) ? esc(d.cse) : '', true)}
<p class="muted" style="margin-top:10pt;font-size:8pt;text-align:center;">
  Le firme apposte nella presente pagina, corredate del timbro aziendale, attestano l'avvenuta
  redazione e condivisione del POS ai sensi del D.lgs 81/2008.
</p>`;

  // F-489: la sezione 1 è l'impresa; i dati del lavoro stanno solo nella 2.1
  const s1 = `
<div class="section-title">Sezione 1 — Intestazione e Dati Identificativi</div>
<p>Il presente Piano Operativo di Sicurezza (POS) viene redatto ai sensi dell'art. 89, comma 1, lettera h)
del D.lgs 81/2008 e s.m.i., come documento complementare al Piano di Sicurezza e Coordinamento (PSC),
ove previsto, e contiene le misure preventive e protettive specifiche dell'impresa esecutrice.</p>
<table class="kv no-break"><tbody>
  ${riga('Impresa esecutrice', d.companyName)}
  ${riga('Partita IVA', d.companyVat)}
  ${riga('Sede legale', d.companyAddress)}
  ${riga('Telefono', d.companyPhone)}
  ${riga('Datore di lavoro', d.datoreLavoro)}
  ${d.presentedBy === 'subappaltatore' ? `${riga('Posizione dell\'impresa', 'Impresa subappaltatrice')}${riga('Impresa affidataria', d.affidatariaName)}` : ''}
  ${riga('Revisione', String(rev))}
  ${riga('Data di emissione', oggi)}
</tbody></table>`;

  const s2 = `
<div class="section-title">Sezione 2 — Dati Generali del Lavoro</div>
<div class="sub-title">2.1 Descrizione dell'opera</div>
<table class="kv no-break"><tbody>
  ${riga('Indirizzo del cantiere', d.siteAddress)}
  ${riga('Oggetto dei lavori', d.descrizioneOpera)}
  ${riga('Committente', d.client)}
  ${riga('Codice fiscale del committente', d.cfCommittente)}
  ${riga('Tipo di appalto', tipo)}
  ${riga('Natura dei lavori', d.workType)}
  ${riga('Importo dei lavori', pieno(d.budget) ? `€ ${formatBudget(d.budget)}` : '')}
  ${riga('Inizio lavori previsto', pieno(d.startDate) ? formatDate(d.startDate) : '')}
  ${riga('Fine lavori prevista', pieno(d.endDate) ? formatDate(d.endDate) : '')}
  ${riga('Numero massimo di operai', workersCount ? String(workersCount) : '')}
</tbody></table>
<div class="sub-title">2.2 Elenco lavoratori impiegati in cantiere</div>
${PC.tabellaLavoratori(d)}
<div class="sub-title">2.3 Orario di lavoro</div>
<ul>
  <li>Inizio turno: ${esc(d.inizioTurno || '08:00')}</li>
  <li>Ore lavorative giornaliere: ${esc(d.oreLavorative || '8')} ore</li>
  ${d.pausaPranzo ? `<li>Pausa pranzo: ${esc(d.pausaPranzo)}</li>` : '<li>Pausa pranzo: 1 ora</li>'}
  <li>Sabato: solo se autorizzato dal Coordinatore per l'Esecuzione</li>
  <li>Lavoro notturno: ${d.turnoNotturno ? 'previsto' : 'non previsto (salvo autorizzazione specifica)'}</li>
</ul>
<div class="sub-title">2.4 Fasi di lavoro e cronoprogramma</div>
${(d.fasi && d.fasi.length > 0)
  ? `<table class="allow-break">
  <thead><tr>
    <th style="width:35%">Fase</th>
    <th style="width:15%">Durata (gg)</th>
    <th style="width:15%">Lavoratori</th>
    <th style="width:35%">Lavorazioni previste</th>
  </tr></thead>
  <tbody>
    ${d.fasi.map(f => `<tr>
      <td>${esc(f.titolo || '')}</td>
      <td>${esc(String(f.durata || ''))}</td>
      <td>${esc(String(f.lavoratori || ''))}</td>
      <td>${esc((f.lavorazioni || []).join(', '))}</td>
    </tr>`).join('')}
  </tbody>
</table>`
  : PC.lavorazioniPreviste(d)
}`;

  const s3 = `
<div class="section-title">Sezione 3 — Soggetti con Compiti di Sicurezza</div>
<div class="sub-title">3.1 Organigramma della sicurezza</div>
<table class="no-break">
  <thead><tr><th style="width:50%">Ruolo</th><th>Nominativo</th></tr></thead>
  <tbody>
    <tr><td>Datore di Lavoro</td><td>${d.datoreLavoro ? `${esc(d.datoreLavoro)} (${esc(d.companyName || '')})` : v(d.companyName)}</td></tr>
    <tr><td>Responsabile Lavori</td><td>${v(d.responsabileLavori)}</td></tr>
    <tr><td>Coordinatore Sicurezza Progettazione (CSP)</td><td>${v(d.csp)}</td></tr>
    <tr><td>Coordinatore Sicurezza Esecuzione (CSE)</td><td>${v(d.cse)}</td></tr>
    <tr><td>Responsabile SPP (RSPP)</td><td>${v(d.rspp)}</td></tr>
    <tr><td>Rappresentante Lavoratori (RLS)</td><td>${v(d.rls)}</td></tr>
    <tr><td>Medico Competente</td><td>${v(d.medico)}</td></tr>
    <tr><td>Addetto Primo Soccorso</td><td>${v(d.primoSoccorso)}</td></tr>
    <tr><td>Addetto Antincendio ed Emergenze</td><td>${v(d.antincendio)}</td></tr>
    <tr><td>Direttore Tecnico di Cantiere</td><td>${v(d.direttoreTecnico||d.responsabileLavori)}</td></tr>
    <tr><td>Preposto/i</td><td>${v(d.preposto)}</td></tr>
  </tbody>
</table>
<div class="sub-title">3.2 Recapiti figure di sicurezza</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:28%">Ruolo</th>
    <th style="width:28%">Nominativo</th>
    <th style="width:22%">Telefono</th>
    <th style="width:22%">Email</th>
  </tr></thead>
  <tbody>
    <tr><td>CSE</td><td>${v(d.cse)}</td><td>${v(d.cseTel)}</td><td>${v(d.cseEmail)}</td></tr>
    <tr><td>RSPP</td><td>${v(d.rspp)}</td><td>${v(d.rsppTel)}</td><td>${v(d.rsppEmail)}</td></tr>
    <tr><td>RLS</td><td>${v(d.rls)}</td><td>${v(d.rlsTel)}</td><td>—</td></tr>
    <tr><td>Medico Competente</td><td>${v(d.medico)}</td><td>${v(d.medicoTel)}</td><td>—</td></tr>
    <tr><td>Addetto Primo Soccorso</td><td>${v(d.primoSoccorso)}</td><td>${v(d.primoSoccorsoTel)}</td><td>—</td></tr>
    <tr><td>Addetto Antincendio</td><td>${v(d.antincendio)}</td><td>${v(d.antincendioTel)}</td><td>—</td></tr>
  </tbody>
</table>
<div class="sub-title">3.3 Compiti e responsabilità</div>
<p><strong>Datore di Lavoro:</strong> Responsabile dell'organizzazione della sicurezza in cantiere. Nomina le figure,
fornisce i DPI, assicura la formazione (art. 17 D.lgs 81/2008).</p>
<p><strong>RSPP:</strong> Collabora nella valutazione dei rischi, elaborazione delle misure preventive, scelta dei DPI e formazione.</p>
<p><strong>RLS:</strong> Rappresenta i lavoratori per la sicurezza. Partecipa alle riunioni periodiche, può richiedere verifiche.</p>
<p><strong>Medico Competente:</strong> Effettua la sorveglianza sanitaria, esprime i giudizi di idoneità.</p>
<p><strong>Preposto:</strong> Sorveglia le attività lavorative, verifica il rispetto delle procedure di sicurezza (art. 19 D.lgs 81/2008).</p>
<div class="sub-title">3.4 Imprese subappaltatrici</div>
${(d.subappaltatori && d.subappaltatori.length > 0)
  ? `<table class="allow-break">
  <thead><tr>
    <th style="width:32%">Ragione Sociale</th>
    <th style="width:24%">P.IVA</th>
    <th style="width:28%">Rappresentante Legale</th>
    <th style="width:16%">Email</th>
  </tr></thead>
  <tbody>
    ${d.subappaltatori.map(s => `<tr>
      <td>${v(s.ragioneSociale)}</td>
      <td>${v(s.partitaIva)}</td>
      <td>${v(s.rappresentanteLegale)}</td>
      <td>${v(s.email)}</td>
    </tr>`).join('')}
  </tbody>
</table>`
  : '<p class="muted">Nessuna impresa subappaltatrice.</p>'
}`;

  let n4 = 9; // sottosezioni facoltative: numerate di seguito, senza buchi (F-342)
  const s4 = `
<div class="section-title">Sezione 4 — Area di Cantiere e Organizzazione</div>
<div class="sub-title">4.1 Delimitazione dell'area e accessi</div>
<p>L'area di lavoro è delimitata con recinzione o transennatura stabile e segnalata, adeguata al contesto
(area condominiale, cortile, suolo pubblico), secondo quanto previsto dal PSC e dalle eventuali autorizzazioni
di occupazione del suolo. Gli accessi restano chiusi fuori dall'orario di lavoro; ai non addetti è vietato l'ingresso.</p>
<div class="sub-title">4.2 Viabilità e movimentazione dei materiali</div>
<ul>
  <li>Mezzi in area di cantiere a passo d'uomo, con manovre assistite da un operatore a terra</li>
  <li>Percorsi pedonali separati da quelli dei mezzi dove possibile, e comunque segnalati</li>
  <li>Carichi sollevati solo con apparecchi idonei, mai sopra persone o aree di passaggio non interdette</li>
</ul>
<div class="sub-title">4.3 Impianto elettrico</div>
${(d.impiantiCantiere || []).some(i => /elettric/i.test(i))
  ? `<ul>
  <li>Quadro elettrico di cantiere (ASC) con interruttore differenziale Id ≤ 30 mA, installato da impresa abilitata con dichiarazione di conformità (D.M. 37/2008)</li>
  <li>Cavi e prolunghe per posa mobile di tipo H07RN-F o equivalenti, protetti dal passaggio dei mezzi</li>
  <li>Impianto di terra denunciato e verificato ogni 2 anni (DPR 462/2001)</li>
</ul>`
  : `<p>L'impresa non installa impianti elettrici di cantiere: utilizza quelli predisposti dall'impresa affidataria o dal committente,
controllando prima dell'uso l'integrità di quadri, prese e cavi; attrezzature con marcatura CE e cavi per posa mobile.</p>`}
<div class="sub-title">4.4 Servizi igienico-assistenziali</div>
<p>Servizi igienici, spogliatoio e locale per i pasti secondo l'Allegato XIII del D.lgs 81/2008, propri o messi a disposizione
dall'impresa affidataria o dal committente; acqua potabile disponibile; cassetta di primo soccorso secondo il D.M. 388/2003.</p>
<div class="sub-title">4.5 Depositi e stoccaggi</div>
<ul>
  <li>Materiali depositati su superfici piane e stabili, lontano dai bordi e dai percorsi</li>
  <li>Sostanze pericolose in contenitori chiusi ed etichettati, in area dedicata, con le schede di sicurezza</li>
  <li>Rifiuti separati per tipo in contenitori identificati (Sezione 11)</li>
</ul>
<div class="sub-title">4.6 Rischi specifici del cantiere</div>
${(d.rischiSpecifici && d.rischiSpecifici.length > 0)
  ? `<ul>${d.rischiSpecifici.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`
  : '<p class="muted">Nessun rischio specifico indicato.</p>'
}
<div class="sub-title">4.7 Opere provvisionali</div>
${(d.opereProvvisionali && d.opereProvvisionali.length > 0)
  ? `<ul>${d.opereProvvisionali.map(o => `<li>${esc(o)}</li>`).join('')}</ul>`
  : '<p class="muted">Nessuna opera provvisionale indicata.</p>'
}
${d.lavoriInQuota ? `<p><strong>Lavori in quota:</strong> ${esc(d.lavoriInQuota)}</p>` : ''}
<div class="sub-title">4.8 Impianti di cantiere</div>
${(d.impiantiCantiere && d.impiantiCantiere.length > 0)
  ? `<ul>${d.impiantiCantiere.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
  : '<p class="muted">Nessun impianto di cantiere indicato.</p>'
}
${d.noteAggiuntive ? `<div class="sub-title">4.${n4++} Note e condizioni particolari</div><p>${esc(d.noteAggiuntive)}</p>` : ''}
${rumoreCalcolato
    // F-350: con le schede nuove l'esposizione è calcolata per gruppo omogeneo
    // nella 5.1; la risposta data a mano in /pos/crea la contraddiceva.
    ? `<div class="sub-title">4.${n4++} Esito della valutazione del rumore (art. 190 D.lgs 81/2008)</div><p>L'esposizione al rumore è valutata per gruppo omogeneo, con dati di letteratura, nella Sezione 5.1: livello di esposizione giornaliera, fascia e obblighi per ogni mansione.</p>`
    : d.rumore ? `<div class="sub-title">4.${n4++} Esito della valutazione del rumore (art. 190 D.lgs 81/2008)</div><p>${esc(d.rumore)}</p>` : ''}
${(Array.isArray(d.pscRichieste) && d.pscRichieste.length > 0) ? `<div class="sub-title">4.${n4++} Misure integrative e procedure richieste dal PSC</div>
${d.pscRef ? `<p class="muted">Riferimento: ${esc(d.pscRef)}</p>` : ''}
<ul>${d.pscRichieste.map(r => `<li><strong>${esc(r.titolo || '')}</strong>${r.dettaglio ? ` — ${esc(r.dettaglio)}` : ''}${r.pagina ? ` <span class="muted">(PSC p. ${esc(String(r.pagina))})</span>` : ''}</li>`).join('')}</ul>` : ''}`;

  const s5 = `
<div class="section-title">Sezione 5 — Lavorazioni, Rischi e Misure di Prevenzione</div>
${buildLavorazioneHtml(aiRisks)}`;

  const s6 = `
<div class="section-title">Sezione 6 — Segnaletica di Sicurezza (ISO 7010)</div>
${buildSegnaleticaHtml(signsWithImages)}`;

  const s7 = `
<div class="section-title">Sezione 7 — Procedure di Emergenza</div>
<div class="sub-title">7.1 Numeri di emergenza</div>
<div class="emergency-grid">
  <div class="emergency-card"><span class="emergency-number">112</span><div class="emergency-label">Emergenza Unica Europea</div></div>
  <div class="emergency-card"><span class="emergency-number">115</span><div class="emergency-label">Vigili del Fuoco</div></div>
  <div class="emergency-card"><span class="emergency-number">118</span><div class="emergency-label">Emergenza Sanitaria</div></div>
  <div class="emergency-card"><span class="emergency-number">113</span><div class="emergency-label">Polizia di Stato</div></div>
  <div class="emergency-card"><span class="emergency-number">112</span><div class="emergency-label">Carabinieri</div></div>
  <div class="emergency-card alt">
    <span class="emergency-number small">02 66101029</span>
    <div class="emergency-label">Centro Antiveleni — Milano</div>
  </div>
</div>
<table class="no-break">
  <thead><tr><th style="width:60%">Servizio</th><th>Numero / Riferimento</th></tr></thead>
  <tbody>
    <tr><td>Centro Antiveleni Roma</td><td>06 49978000</td></tr>
    <tr><td>INAIL (denuncia infortuni)</td><td>06 6001</td></tr>
    <tr><td>Addetto Primo Soccorso interno</td><td>${v(d.primoSoccorso)}</td></tr>
    <tr><td>Addetto Antincendio interno</td><td>${v(d.antincendio)}</td></tr>
    <tr><td>CSE</td><td>${v(d.cse)}</td></tr>
  </tbody>
</table>
<div class="sub-title">7.2 Procedura emergenza incendio</div>
<ol style="margin-left:16pt;">
  <li>Chi rileva l'incendio avvisa immediatamente l'Addetto Antincendio e il Preposto</li>
  <li>Se di piccola entità: tentare lo spegnimento con gli estintori disponibili</li>
  <li>Se non controllabile: attivare l'allarme e chiamare il 115</li>
  <li>Evacuare l'area seguendo le vie di fuga predisposte</li>
  <li>Raggiungere il punto di raccolta prestabilito e attendere l'appello</li>
  <li>Attendere i Vigili del Fuoco e fornire indicazioni sulla situazione</li>
  <li>Non rientrare fino all'autorizzazione delle autorità</li>
</ol>
<div class="sub-title">7.3 Procedura primo soccorso</div>
<ol style="margin-left:16pt;">
  <li>Chi rileva l'infortunio avvisa immediatamente l'Addetto Primo Soccorso</li>
  <li>Valutare la scena (sicurezza dell'area, rischi residui)</li>
  <li>Valutare lo stato dell'infortunato (coscienza, respiro, circolo)</li>
  <li>Chiamare il 118: luogo esatto, numero infortunati, dinamica, condizioni</li>
  <li>Prestare i primi soccorsi nei limiti delle proprie competenze</li>
  <li>Non spostare l'infortunato salvo pericolo imminente</li>
  <li>Compilare il registro infortuni e la denuncia INAIL entro 48 ore</li>
</ol>
<div class="sub-title">7.4 Punto di raccolta</div>
<p>Il punto di raccolta è individuato in area esterna al cantiere, facilmente raggiungibile e segnalato
con cartello E007. La sua posizione è comunicata a tutti i lavoratori all'ingresso in cantiere.</p>`;

  const s8 = `
<div class="section-title">Sezione 8 — Dispositivi di Protezione Individuale (DPI)</div>
<div class="sub-title">8.1 Obblighi generali — Reg. UE 2016/425</div>
<p>Il Datore di Lavoro fornisce ai lavoratori i DPI necessari, conformi al Reg. UE 2016/425. I lavoratori
hanno l'obbligo di utilizzarli correttamente e segnalare difetti. La consegna è documentata con registro firmato.</p>
<div class="sub-title">8.2 DPI di base obbligatori in cantiere</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:28%">DPI</th>
    <th style="width:28%">Norma di riferimento</th>
    <th style="width:8%">Cat.</th>
    <th>Note</th>
  </tr></thead>
  <tbody>
    <tr><td>Casco di protezione</td><td>UNI EN 397:2012</td><td>II</td><td>Obbligatorio in tutta l'area cantiere</td></tr>
    <tr><td>Calzature di sicurezza S3</td><td>UNI EN ISO 20345:2022</td><td>II</td><td>Puntale 200J, suola antiperforazione</td></tr>
    <tr><td>Guanti da lavoro</td><td>UNI EN 388:2016</td><td>II</td><td>Resistenza a taglio, abrasione, perforazione</td></tr>
    <tr><td>Giubbotto alta visibilità</td><td>UNI EN ISO 20471:2013</td><td>II</td><td>Classe 2 — zone transito mezzi</td></tr>
    <tr><td>Occhiali di protezione</td><td>UNI EN 166:2001</td><td>II</td><td>Lavorazioni con proiezione schegge/polveri</td></tr>
  </tbody>
</table>
<div class="sub-title">8.3 DPI specifici per lavorazioni a rischio</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:28%">DPI</th>
    <th style="width:30%">Norma di riferimento</th>
    <th>Impiego specifico</th>
  </tr></thead>
  <tbody>
    <tr><td>Imbracatura anticaduta</td><td>UNI EN 361:2002</td><td>Lavori in quota &gt;2 m senza protezioni collettive</td></tr>
    <tr><td>Cordino con assorbitore</td><td>UNI EN 355:2002</td><td>In abbinamento all'imbracatura anticaduta</td></tr>
    <tr><td>Cuffie/inserti auricolari</td><td>UNI EN 352-1/2:2020</td><td>Esposizione rumore &gt;85 dB(A)</td></tr>
    <tr><td>Facciale filtrante FFP2/FFP3</td><td>UNI EN 149:2009</td><td>Polveri, fibre, aerosol</td></tr>
    <tr><td>Maschera con filtri</td><td>UNI EN 14387:2004</td><td>Vapori organici e gas</td></tr>
    <tr><td>Guanti antitaglio</td><td>UNI EN 388:2016 (Lv.E)</td><td>Taglio lamiere, vetro, materiali affilati</td></tr>
    <tr><td>Guanti anticalore</td><td>UNI EN 407:2020</td><td>Saldatura, taglio termico, superfici calde</td></tr>
    <tr><td>Tuta monouso tipo 5/6</td><td>UNI EN 13034:2005</td><td>Manipolazione sostanze chimiche</td></tr>
  </tbody>
</table>`;

  const s9 = `
<div class="section-title">Sezione 9 — Macchine, Attrezzature e Verifiche</div>
${(Array.isArray(d.macchine) && d.macchine.length > 0) ? `<div class="sub-title">Macchine e attrezzature impiegate dall'impresa in questo cantiere</div><ul>${d.macchine.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
<div class="sub-title">9.1 Disposizioni generali</div>
<p>Tutte le macchine e attrezzature devono essere conformi alla Direttiva Macchine 2006/42/CE, dotate di
marcatura CE e dichiarazione di conformità. Devono essere usate secondo le istruzioni del fabbricante.</p>
<div class="sub-title">9.2 Verifiche delle attrezzature</div>
${PC.tabellaVerifiche(d)}
<div class="sub-title">9.3 Abilitazioni degli operatori</div>
${PC.tabellaAbilitazioni(d)}`;

  const s10 = `
<div class="section-title">Sezione 10 — Sostanze e Preparati Pericolosi</div>
${(Array.isArray(d.sostanze) && d.sostanze.length > 0) ? `<div class="sub-title">Sostanze impiegate dall'impresa in questo cantiere</div><ul>${d.sostanze.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="muted">Le schede di sicurezza (SDS) sono conservate in cantiere e a disposizione dei lavoratori.</p>` : ''}
<div class="sub-title">10.1 Obblighi — Regolamento REACH e Reg. CLP</div>
<p>Per ogni sostanza pericolosa: SDS (Scheda Dati di Sicurezza) aggiornata in 16 sezioni, conservata accessibile
a tutti i lavoratori, stoccaggio in area dedicata con bacino di contenimento.</p>
<div class="sub-title">10.2 ${PC.nuovoPercorso(d) ? 'Rischi e cautele delle sostanze impiegate' : 'Sostanze comuni in cantiere'}</div>
${PC.tabellaSostanze(d)}`;

  const s11 = `
<div class="section-title">Sezione 11 — Gestione Rifiuti</div>
<div class="sub-title">11.1 Normativa — D.lgs 152/2006 (TUA) e s.m.i.</div>
<p>La gestione dei rifiuti è effettuata nel rispetto del D.lgs 152/2006. Deposito temporaneo effettuato
nel rispetto dell'art. 183 co. 1 lett. bb) TUA. Formulari di Identificazione Rifiuti per ogni trasporto.</p>
<div class="sub-title">11.2 Codici CER dei rifiuti ${PC.nuovoPercorso(d) ? 'prodotti dalle lavorazioni' : 'tipici di cantiere'}</div>
${PC.tabellaRifiuti(d)}`;

  const s12 = `
<div class="section-title">Sezione 12 — Formazione e Informazione dei Lavoratori</div>
<div class="sub-title">12.1 Formazione obbligatoria — art. 37 D.lgs 81/2008 e Accordo Stato-Regioni 17/04/2025</div>
${PC.tabellaFormazione(d)}
<p class="muted">La formazione e l'idoneità di ciascun lavoratore impiegato in questo cantiere sono riportate nella tabella 2.2.</p>
<div class="sub-title">12.2 Informazione all'ingresso in cantiere</div>
<p>All'ingresso in cantiere, ogni lavoratore riceve informazione su: rischi specifici, misure preventive,
procedure di emergenza, nominativi delle figure di sicurezza, ubicazione presidi di primo soccorso,
estintori e punto di raccolta. L'avvenuta informazione è documentata con firma su apposito registro.</p>
<p>Inoltre, quando timbra l'entrata con il badge Palladia, ogni lavoratore vede un riepilogo dei rischi principali di questo POS
e delle misure per proteggersi, nella sua lingua, e ne conferma la presa visione: data, ora e lingua restano registrate
e il riepilogo si ripropone finché non è confermato e a ogni nuova revisione del POS.</p>`;

  const s13 = `
<div class="section-title">Sezione 13 — Sorveglianza Sanitaria</div>
<div class="sub-title">13.1 Protocollo sanitario</div>
<p>Il Medico Competente (${v(d.medico)}) definisce il protocollo sanitario in base ai rischi specifici.
La sorveglianza comprende visita preventiva, periodica, su richiesta, alla cessazione e al rientro
da assenza &gt;60 giorni per malattia.</p>
<div class="sub-title">13.2 Accertamenti tipici per lavoratori edili</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:32%">Rischio</th>
    <th style="width:38%">Accertamento sanitario</th>
    <th>Periodicità</th>
  </tr></thead>
  <tbody>
    <tr><td>Movimentazione manuale carichi</td><td>Visita medica + rachide</td><td>Annuale</td></tr>
    <tr><td>Rumore &gt;85 dB(A)</td><td>Audiometria tonale</td><td>Annuale</td></tr>
    <tr><td>Vibrazioni mano-braccio</td><td>Visita + arti superiori</td><td>Biennale</td></tr>
    <tr><td>Polveri (silice, cemento)</td><td>Spirometria + Rx torace</td><td>Annuale / biennale</td></tr>
    <tr><td>Sostanze chimiche</td><td>Esami ematochimici specifici</td><td>Secondo SDS</td></tr>
    <tr><td>Lavoro in quota</td><td>Visita + idoneità specifica</td><td>Annuale</td></tr>
  </tbody>
</table>`;

  const s14 = `
<div class="section-title page-break">Sezione 14 — Presa visione dei lavoratori</div>
<p class="muted">Le firme del datore di lavoro, dell'RSPP, dell'RLS, del medico competente e del CSE sono nella pagina «Firme e sottoscrizione del documento», all'inizio del POS.</p>
<div class="sub-title" style="margin-top:16pt;">Dichiarazione presa visione dei lavoratori</div>
<p>I sottoscritti dichiarano di aver ricevuto copia del presente POS e di impegnarsi al rispetto delle disposizioni
ai sensi dell'art. 17 D.lgs 81/2008.</p>
<table class="allow-break">
  <thead><tr>
    <th style="width:6%">N.</th>
    <th style="width:36%">Nominativo</th>
    <th style="width:29%">Data</th>
    <th>Firma</th>
  </tr></thead>
  <tbody>${workerDeclRows}</tbody>
</table>
<hr>
<p class="muted" style="text-align:center;margin-top:8pt;font-size:7.5pt;">
  Documento generato con Palladia — D.lgs 81/2008 e s.m.i. — ${oggi} — Revisione ${rev}
</p>`;

  // F-489: «Sezione N — Titolo In Maiuscole» → numero grigio e titolo normale
  const sezione = (html) => html.replace(/<div class="section-title( page-break)?">Sezione (\d+) — ([^<]+)<\/div>/g, (_, pb, n, t) => `<div class="section-title${pb || ''}"><span class="n">${n}</span>${titoloSezione(t)}</div>`);

  // F-302: dimensioni a mezzo pixel e niente crenatura → testo modificabile in Acrobat
  return editablePdfHtml(sezione(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>${esc(docTitle)}</title>
  <style>${buildCss()}</style>
</head>
<body>
<div class="doc">
${cover}
<div class="content">
${s0_firme}
${s1}${s2}${s3}${s4}${s5}${s6}${s7}${s8}${s9}${s10}${s11}${s12}${s13}${s14}
</div>
</div>

</body>
</html>`));
}

// «Intestazione e Dati Identificativi» → «Intestazione e dati identificativi»; sigle intatte
function titoloSezione(t) {
  return t.split(' ').map((w, i) => (i === 0 || /^[A-Z0-9().]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
}

/**
 * F-489: opzioni di stampa del POS. In testa a ogni pagina l'impresa che fa il
 * POS (prima «PALLADIA», il valore di riserva del piè di pagina).
 */
function posPdfOptions(posData, revision, siteName) {
  const d = posData || {};
  const rev = revision || 1;
  // «Cantiere» è il valore di riserva delle rotte quando non trovano il nome: lì vale quello del POS
  const cantiere = [siteName !== 'Cantiere' ? siteName : '', d.siteName, d.siteAddress].find(pieno) || 'Cantiere';
  return {
    docTitle: `POS · ${cantiere} · Rev. ${rev}`,
    headerLeft: pieno(d.companyName) ? d.companyName : 'POS',
    footerLeft: 'D.Lgs. 81/2008 · Allegato XV',
    revision: rev,
  };
}

module.exports = { generatePosHtml, posPdfOptions };
