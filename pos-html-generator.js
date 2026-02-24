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
const path = require('path');
const { ZONE_ORDER } = require('./sign-selector');

// ── ESCAPE / HELPERS ──────────────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function v(val) {
  return (val && val !== 'N/A')
    ? esc(val)
    : '<span class="placeholder">[DA COMPILARE]</span>';
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
function riskNumClass(val) {
  const n = parseFloat(String(val || '').replace(',', '.'));
  if (isNaN(n)) return '';
  if (n <= 3)  return 'risk-low';
  if (n <= 8)  return 'risk-medium';
  if (n <= 12) return 'risk-high';
  return 'risk-very-high';
}

// ── SIGN IMAGE LOADER (async) ─────────────────────────────────────────────────
async function loadSignImage(imagePath) {
  try {
    const data = fs.readFileSync(imagePath); // sync ok — called once at render time
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
  let html = '<table class="allow-break"><thead><tr>';
  headers.forEach(h => { html += `<th>${boldify(h)}</th>`; });
  html += '</tr></thead><tbody>';
  valid.slice(1).forEach(row => {
    const cells = row.split('|').slice(1, -1).map(c => c.trim());
    html += '<tr>';
    cells.forEach((cell, ci) => {
      const hdr = (headers[ci] || '').toLowerCase();
      const isLivello = /livello/i.test(hdr);
      const isRiskNum = /^\s*r\s*[\(=]|^\s*r\s*$/i.test(hdr);
      let content = boldify(cell);
      if (isLivello && cell) {
        const bc = riskBadgeClass(cell);
        if (bc) content = `<span class="badge ${bc}">${esc(cell)}</span>`;
      } else if (isRiskNum && /^\d+([,.]\d+)?$/.test(cell.trim())) {
        const rc = riskNumClass(cell);
        content = `<span class="risk-num ${rc}">${esc(cell)}</span>`;
      }
      html += `<td>${content}</td>`;
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
      html += `<p class="bold-line" style="font-size:10pt;color:#2C2C2C;margin-top:6pt">${boldify(text)}</p>`;
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
function buildLavorazioneHtml(aiRisks) {
  if (!aiRisks || !aiRisks.trim()) {
    return '<div class="callout">Nessuna lavorazione generata. Integrare manualmente.</div>';
  }
  const blocks = aiRisks.split(/(?=^### )/m).filter(b => b.trim());
  let html = '';
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
    const bodyStr = lines.slice(bodyIdx).join('\n').replace(/^---\s*$/mg, '').trim();
    html += `
    <div class="lavorazione-block">
      <div class="lav-header">${esc(title)}</div>
      <div class="lav-body">${parseMd(bodyStr)}</div>
    </div>`;
  }
  return html || '<div class="callout">Nessuna lavorazione generata.</div>';
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
function catLabel(category) {
  return (CAT_META[category] || CAT_META['Generale']).label;
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
      <td style="font-size:8pt;color:#555">D.lgs 81/08 Titolo V${meta.iso ? ` — ISO 7010 ${meta.iso}xxx` : ''}</td>
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
   PALLADIA PDF — Stylesheet v9
   Architettura header/footer DOM-based (position:fixed):
     @page { margin:0 }  → zero margini PDF (nessun overlay Puppeteer).
     Verticale  : .doc { padding: 22mm 16mm 20mm 16mm } — unica sorgente.
                  22mm = header 10mm + respiro 12mm
                  20mm = footer  9mm + respiro 11mm
     Orizzontale: .doc { padding: 0 16mm } — unica sorgente laterale.
     H/F : position:fixed, height:10mm/9mm, padding:0 16mm → allineati
           al testo su ogni pagina senza overlay.
     Numerazione: CSS counter(page) per corrente + JS inject per totale.
   ═══════════════════════════════════════════════════════════════════ */

/* ── RESET ─────────────────────────────────────────────────────────── */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  word-break: break-word;
  overflow-wrap: break-word;
  min-width: 0;
}

/* ── BASE ───────────────────────────────────────────────────────────── */
html, body {
  margin: 0;
  padding: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
body {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 10pt;
  color: #1E1E1E;
  line-height: 1.65;
  background: #FFFFFF;
  /* Nessun padding sul body — tutto il padding è in .doc */
}

/* ── DOC WRAPPER ─────────────────────────────────────────────────────
   .doc è l'unico contenitore di TUTTO il padding del documento:
     top  22mm = spazio per header (10mm) + respiro (12mm)
     btm  20mm = spazio per footer ( 9mm) + respiro (11mm)
     sx/dx 16mm = margini laterali
   width:100% → non supera mai la larghezza pagina. */
.doc {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 22mm 16mm 20mm 16mm;
}
.doc.debug { outline: 1px dashed #ff0000; }

img {
  max-width: 100%;
  height: auto;
  display: block;
  break-inside: avoid;
  page-break-inside: avoid;
}
table {
  max-width: 100%;
}

/* ── ANTI-TAGLIO ─────────────────────────────────────────────────────
   Titoli: non isolare in fondo a una pagina.
   Righe tabella: non dividere a metà. thead si ripete.
   Le tabelle possono continuare su più pagine (NO table break-inside:avoid). */
h1, h2, h3 {
  break-after: avoid-page;
  page-break-after: avoid;
}
tr {
  break-inside: avoid;
  page-break-inside: avoid;
}
thead {
  display: table-header-group;
}
.no-break {
  break-inside: avoid;
  page-break-inside: avoid;
}

/* ── COVER ─────────────────────────────────────────────────────────────
   min-height = A4 (297mm) - Puppeteer top (22mm) - Puppeteer bottom (20mm)
             = 255mm → cover occupa esattamente la prima pagina di contenuto.
   ───────────────────────────────────────────────────────────────────── */
.cover {
  break-after: page;
  page-break-after: always;
  display: flex;
  width: 100%;
  max-width: 100%;
  min-height: 255mm;
  overflow: hidden;
}
.cover-sidebar {
  width: 62mm;
  max-width: 62mm;
  flex-shrink: 0;
  background: #2C2C2C;
  color: #FFFFFF;
  padding: 12mm 9mm 10mm 10mm;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.cover-sidebar-brand {
  font-size: 10pt;
  font-weight: bold;
  letter-spacing: 3.5pt;
  text-transform: uppercase;
  color: #AAAAAA;
  margin-bottom: 10mm;
  padding-bottom: 6mm;
  border-bottom: 0.5pt solid #484848;
}
.cover-sidebar-item {
  margin-bottom: 6mm;
  overflow: hidden;
}
.cover-label {
  font-size: 5.5pt;
  letter-spacing: 1.2pt;
  text-transform: uppercase;
  color: #888888;
  margin-bottom: 2pt;
}
.cover-value {
  font-size: 8.5pt;
  font-weight: bold;
  color: #FFFFFF;
  line-height: 1.35;
}
.cover-sidebar-footer {
  margin-top: auto;
  font-size: 6.5pt;
  color: #666666;
  padding-top: 5mm;
  border-top: 0.5pt solid #444444;
  line-height: 1.5;
}
.cover-main {
  flex: 1;
  min-width: 0;
  max-width: 100%;
  padding: 12mm 10mm 10mm 12mm;
  display: flex;
  flex-direction: column;
  background: #FFFFFF;
  overflow: hidden;
}
.cover-top { flex: 1; }
.cover-title {
  font-size: 22pt;
  font-weight: bold;
  color: #1E1E1E;
  text-transform: uppercase;
  letter-spacing: 0.3pt;
  line-height: 1.15;
  margin-bottom: 4mm;
}
.cover-subtitle {
  font-size: 9pt;
  color: #777777;
  margin-bottom: 7mm;
  font-style: italic;
}
.cover-rev-badge {
  display: inline-block;
  background: #2C2C2C;
  color: #FFFFFF;
  font-size: 8.5pt;
  font-weight: bold;
  padding: 3pt 11pt;
  border-radius: 2pt;
  margin-bottom: 7mm;
  letter-spacing: 0.3pt;
}
.cover-divider {
  border: none;
  border-top: 0.75pt solid #E8E8E8;
  margin: 0 0 6mm 0;
}
.cover-info-box {
  border: 0.75pt solid #E8E8E8;
  border-radius: 2pt;
  padding: 5mm 7mm;
  background: #F8F8F8;
  margin-bottom: 6mm;
}
.cover-info-row {
  display: flex;
  align-items: baseline;
  margin-bottom: 4pt;
  font-size: 8.5pt;
}
.cover-info-row:last-child { margin-bottom: 0; }
.cover-info-label {
  font-weight: bold;
  color: #2C2C2C;
  width: 34mm;
  flex-shrink: 0;
  font-size: 8pt;
}
.cover-info-val {
  color: #333333;
  flex: 1;
  overflow: hidden;
  font-size: 8.5pt;
}
.cover-bottom { flex-shrink: 0; }
.cover-sig-row {
  display: flex;
  gap: 5pt;
  margin-top: 5mm;
}
.cover-sig-box {
  flex: 1;
  border: 0.5pt solid #DDDDDD;
  border-top: 2pt solid #2C2C2C;
  padding: 7pt 8pt 10pt;
  min-height: 38mm;
}
.cover-sig-label {
  font-size: 5.5pt;
  color: #999999;
  text-transform: uppercase;
  letter-spacing: 0.5pt;
  margin-bottom: 3pt;
}
.cover-sig-name {
  font-size: 8pt;
  font-weight: bold;
  color: #1E1E1E;
}
.cover-footer-note {
  font-size: 6.5pt;
  color: #BBBBBB;
  margin-top: 4mm;
  padding-top: 3mm;
  border-top: 0.5pt solid #EEEEEE;
  line-height: 1.4;
}

/* ── SECTION TITLE ──────────────────────────────────────────────────── */
.section-title {
  background: #2C2C2C;
  color: #FFFFFF;
  font-size: 9.5pt;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 1pt;
  padding: 8pt 11pt;
  margin: 28pt 0 14pt 0;
  break-after: avoid;
  page-break-after: avoid;
  break-before: avoid;
  page-break-before: avoid;
}
.section-title:first-child { margin-top: 0; }

/* ── SUB-TITLE ──────────────────────────────────────────────────────── */
.sub-title {
  background: #F0F0F0;
  border-left: 3pt solid #2C2C2C;
  font-size: 9pt;
  font-weight: bold;
  padding: 6pt 10pt;
  margin: 18pt 0 9pt 0;
  break-after: avoid;
  page-break-after: avoid;
  color: #1E1E1E;
}

/* ── TABLES ─────────────────────────────────────────────────────────── */
table {
  width: 100%;
  max-width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 9pt;
  margin: 6pt 0 14pt 0;
}
th, td {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}
table.allow-break {
  break-inside: auto;
  page-break-inside: auto;
}
table.allow-break thead { display: table-header-group; }
thead th {
  background: #2C2C2C;
  color: #FFFFFF;
  font-weight: bold;
  font-size: 8pt;
  padding: 5pt 7pt;
  text-align: left;
  border: 0.5pt solid #1E1E1E;
  overflow: hidden;
  word-break: break-word;
  overflow-wrap: anywhere;
  line-height: 1.4;
}
tbody tr:nth-child(even) { background: #F7F7F7; }
tbody tr:nth-child(odd)  { background: #FFFFFF; }
tbody td {
  padding: 6pt 8pt;
  border: 0.5pt solid #DDDDDD;
  vertical-align: top;
  line-height: 1.6;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* ── RISK BADGES ────────────────────────────────────────────────────── */
.badge {
  display: inline-block;
  border-radius: 2pt;
  padding: 1.5pt 6pt;
  font-size: 7.5pt;
  font-weight: bold;
  color: #FFFFFF;
  white-space: nowrap;
}
.badge-low       { background: #2E7D32; }
.badge-medium    { background: #E65100; }
.badge-high      { background: #B71C1C; }
.badge-very-high { background: #880E4F; }
.risk-num {
  display: inline-block;
  border-radius: 2pt;
  padding: 1.5pt 5pt;
  font-size: 8pt;
  font-weight: bold;
  color: #FFFFFF;
  min-width: 22pt;
  text-align: center;
}
.risk-low       { background: #2E7D32; }
.risk-medium    { background: #E65100; }
.risk-high      { background: #B71C1C; }
.risk-very-high { background: #880E4F; }

/* ── CALLOUT ────────────────────────────────────────────────────────── */
.callout {
  background: #FFFDE7;
  border-left: 3pt solid #F9A825;
  padding: 7pt 10pt;
  margin: 8pt 0;
  font-size: 9pt;
  break-inside: avoid;
  border-radius: 0 2pt 2pt 0;
}

/* ── LAVORAZIONE BLOCKS ─────────────────────────────────────────────── */
.lavorazione-block {
  border: 0.75pt solid #DDDDDD;
  border-radius: 2pt;
  margin: 16pt 0 22pt 0;
  break-inside: auto;
  page-break-inside: auto;
}
.lav-header {
  background: #484848;
  color: #FFFFFF;
  font-weight: bold;
  font-size: 9.5pt;
  padding: 8pt 11pt;
  break-after: avoid;
  page-break-after: avoid;
  letter-spacing: 0.2pt;
}
.lav-body { padding: 11pt 13pt 10pt 13pt; }
.lav-body p          { margin-bottom: 6pt; }
.lav-body ul         { margin: 5pt 0 8pt 18pt; }
.lav-body ol         { margin: 5pt 0 8pt 20pt; }
.lav-body li         { margin-bottom: 4pt; }
.lav-body .bold-line { font-weight: bold; margin: 8pt 0 3pt 0; color: #2C2C2C; }
.lav-body table      { margin: 6pt 0 9pt 0; font-size: 8.5pt; }

/* ── SEGNALETICA ────────────────────────────────────────────────────── */
.sign-intro {
  margin-bottom: 10pt;
  font-size: 9pt;
  line-height: 1.6;
  color: #444444;
}
.sign-summary-table { margin-bottom: 14pt !important; }
.sign-summary-table thead th { background: #1E1E1E; }
.sign-summary-total td {
  background: #EEEEEE !important;
  border-top: 1pt solid #AAAAAA;
}
.cat-dot {
  display: inline-block;
  width: 9pt;
  height: 9pt;
  border-radius: 50%;
  vertical-align: middle;
}
.sign-zone-header {
  background: #1E1E1E;
  color: #FFFFFF;
  font-size: 8pt;
  font-weight: bold;
  letter-spacing: 1pt;
  text-transform: uppercase;
  padding: 5pt 9pt;
  margin: 14pt 0 6pt 0;
  break-after: avoid;
  page-break-after: avoid;
}
.signs-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7pt;
  margin: 0 0 8pt 0;
  break-inside: auto;
}
.sign-card {
  border: 0.5pt solid #E0E0E0;
  border-radius: 0 0 2pt 2pt;
  padding: 6pt 4pt 5pt;
  text-align: center;
  background: #FFFFFF;
  break-inside: avoid;
  page-break-inside: avoid;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.sign-img {
  width: 100%;
  max-width: 32mm;
  height: 26mm;
  object-fit: contain;
  display: block;
  margin: 3pt auto 5pt;
  background: #FFFFFF;
}
.sign-img-placeholder {
  width: 32mm;
  height: 26mm;
  background: #F0F0F0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13pt;
  color: #AAAAAA;
  margin: 3pt auto 5pt;
}
.sign-name {
  font-size: 6pt;
  font-weight: bold;
  color: #1A1A1A;
  margin-bottom: 2pt;
  line-height: 1.3;
}
.sign-iso {
  font-size: 5.5pt;
  font-weight: bold;
  letter-spacing: 0.3pt;
  margin-bottom: 2pt;
  text-transform: uppercase;
}
.sign-location-text {
  font-size: 5pt;
  color: #777777;
  font-style: italic;
  line-height: 1.3;
  text-align: center;
  margin-top: auto;
  padding-top: 2pt;
}

/* ── EMERGENCY GRID ─────────────────────────────────────────────────── */
.emergency-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7pt;
  margin: 8pt 0 14pt 0;
}
.emergency-card {
  background: #2C2C2C;
  color: #FFFFFF;
  text-align: center;
  padding: 9pt 6pt;
  border-radius: 2pt;
  break-inside: avoid;
  overflow: hidden;
}
.emergency-number { font-size: 17pt; font-weight: bold; display: block; letter-spacing: 0.5pt; }
.emergency-label  { font-size: 6.5pt; color: #AAAAAA; margin-top: 3pt; line-height: 1.3; }

/* ── SIGNATURES ─────────────────────────────────────────────────────── */
.signature-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14pt;
  margin: 12pt 0;
}
.signature-box {
  border: 0.5pt solid #DDDDDD;
  border-left: 3pt solid #2C2C2C;
  border-radius: 0 2pt 2pt 0;
  padding: 11pt 13pt 14pt;
  min-height: 75mm;
  break-inside: avoid;
  page-break-inside: avoid;
}
.sig-role {
  font-weight: bold;
  font-size: 9pt;
  color: #1A1A1A;
  margin-bottom: 3pt;
  padding-bottom: 6pt;
  border-bottom: 0.5pt solid #EEEEEE;
  line-height: 1.4;
}
.sig-name  { font-size: 8.5pt; color: #555555; margin-bottom: 12pt; margin-top: 4pt; }
.sig-body  { display: flex; gap: 12pt; align-items: flex-start; }
.sig-stamp {
  flex-shrink: 0;
  width: 34mm;
  height: 28mm;
  border: 0.5pt dashed #CCCCCC;
  border-radius: 2pt;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #DDDDDD;
  font-size: 6pt;
  letter-spacing: 1pt;
  text-transform: uppercase;
}
.sig-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 14pt; }
.sig-field  { flex: 1; min-width: 0; }
.sig-label  { font-size: 6.5pt; color: #888888; margin-bottom: 5pt; text-transform: uppercase; letter-spacing: 0.3pt; }
.sig-line   { border-bottom: 0.5pt solid #BBBBBB; min-height: 20pt; }

/* ── TYPOGRAPHY ─────────────────────────────────────────────────────── */
p          { margin-bottom: 8pt; line-height: 1.7; orphans: 3; widows: 3; }
ul, ol     { margin: 6pt 0 10pt 19pt; }
li         { margin-bottom: 5pt; line-height: 1.6; }
strong     { font-weight: bold; }
.bold-line { font-weight: bold; margin: 9pt 0 3pt 0; }
.muted     { color: #888888; font-size: 8.5pt; }
.placeholder { color: #C0852A; font-weight: bold; font-style: italic; }
hr         { border: none; border-top: 0.5pt solid #E8E8E8; margin: 12pt 0; }
h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
h1 { font-size: 13pt; margin: 16pt 0 8pt 0; color: #1E1E1E; }
h2 { font-size: 11pt; margin: 14pt 0 6pt 0; color: #1E1E1E; }
h3 { font-size: 10pt; margin: 11pt 0 5pt 0; color: #1E1E1E; }

/* ── CONTENT WRAPPER ─────────────────────────────────────────────────
   Il div.content avvolge tutte le sezioni dopo la cover.
   Nessun padding aggiuntivo: lo spazio verticale è già in .doc. */
.content { }

/* ── PAGE BREAK UTILITIES ───────────────────────────────────────────── */
.page-break { break-before: page; page-break-before: always; }
.no-break   { break-inside: avoid; page-break-inside: avoid; }
.keep-next  { break-after: avoid; page-break-after: avoid; }

/* ══════════════════════════════════════════════════════════════════════
   BLOCCO FINALE — vince su tutto (ordine di cascata CSS, ultimo = forte)
   ══════════════════════════════════════════════════════════════════════ */

/* @page: zero margini → tutto gestito dal DOM */
@page { size: A4; margin: 0; }

*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0 !important;
  padding: 0 !important;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ── HEADER FISSO ─────────────────────────────────────────────────────
   Si ripete su ogni pagina stampata grazie a position:fixed.
   height:10mm = barra visiva. Il padding-top:22mm di .doc riserva
   10mm (header) + 12mm (respiro) sopra il contenuto. */
.print-header {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 10mm;
  padding: 0 16mm;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 0.4pt solid #DDDDDD;
  background: #FFFFFF;
  z-index: 9999;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 0; /* container font-size:0 → ogni span ha il suo */
  line-height: 1.1;
  box-sizing: border-box;
}
.ph-brand {
  font-size: 9px;
  font-weight: bold;
  color: #2C2C2C;
  letter-spacing: 0.5pt;
  line-height: 1.1;
  flex: 0 0 auto;
}
.ph-title {
  font-size: 9px;
  color: #AAAAAA;
  line-height: 1.1;
  flex: 1;
  text-align: right;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding-left: 8px;
}

/* ── FOOTER FISSO ─────────────────────────────────────────────────────
   height:9mm. Il padding-bottom:20mm di .doc riserva
   9mm (footer) + 11mm (respiro) sotto il contenuto.
   Numerazione 2-pass:
     .page-num::after { content: counter(page) } → pagina corrente CSS-puro
     .total-pages → inizia con "—"; pdf-renderer.js (Pass 1) ottiene il
     conteggio reale via pdf-lib.getPageCount(), poi lo inietta server-side
     prima di Pass 2. Deterministico: si basa su pagine PDF reali. */
.print-footer {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  height: 9mm;
  padding: 0 16mm;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 0.4pt solid #DDDDDD;
  background: #FFFFFF;
  z-index: 9999;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 0;
  line-height: 1.1;
  box-sizing: border-box;
}
.pf-left  { font-size: 9px; color: #BBBBBB; line-height: 1.1; flex: 1; }
.pf-center {
  font-size: 9px;
  color: #444444;
  font-weight: bold;
  line-height: 1.1;
  flex: 0 0 auto;
  white-space: nowrap;
}
.pf-right { font-size: 9px; color: #BBBBBB; line-height: 1.1; flex: 1; text-align: right; }

/* CSS counter(page): pagina corrente su ogni pagina stampa (position:fixed in Chrome) */
.page-num::after { content: counter(page); font-size: 9px; line-height: 1.1; }
/* .total-pages: placeholder "—" → sostituito da _twoPassRender() con il totale reale */
.total-pages { font-size: 9px; line-height: 1.1; }

/* ── DOC: padding unico per tutto lo spazio verticale e laterale ─────── */
.doc {
  width: 100% !important;
  max-width: 100% !important;
  padding: 22mm 16mm 20mm 16mm !important;
  box-sizing: border-box !important;
}

/* ── TABELLE ─────────────────────────────────────────────────────────── */
table {
  width: 100% !important;
  max-width: 100% !important;
  table-layout: fixed !important;
  border-collapse: collapse !important;
}
th, td {
  max-width: 100% !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr    { break-inside: avoid; page-break-inside: avoid; }

/* ── ANTI-TAGLIO DEFINITIVO ─────────────────────────────────────────── */
h1, h2, h3, .section-title, .sub-title {
  break-after: avoid-page;
  page-break-after: avoid;
}
img, .card, .signature-box, .callout, .lav-header, .sign-card {
  break-inside: avoid;
  page-break-inside: avoid;
}
`;
}

// ── FIRMA BOX — helper riusabile ──────────────────────────────────────────────
function buildSigBox(role, name, fullWidth = false) {
  return `
  <div class="signature-box"${fullWidth ? ' style="margin:8pt 0;"' : ''}>
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
async function generatePosHtml(posData, revision, aiRisks, signs = []) {
  const d    = posData || {};
  const rev  = revision || 1;
  const oggi = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const siteName = d.siteAddress || d.siteName || 'Cantiere';
  const docTitle = `POS – ${siteName} – Rev. ${rev}`;

  const workersCount = (d.workers && d.workers.length > 0)
    ? d.workers.length
    : (d.numWorkers || '[DA COMPILARE]');

  const workerRows = (d.workers && d.workers.length > 0)
    ? d.workers.map((w, i) => `<tr>
        <td>${i + 1}</td><td>${v(w.name)}</td>
        <td>${v(w.qualification)}</td><td>${v(w.matricola)}</td>
      </tr>`).join('')
    : `<tr><td>1</td><td><span class="placeholder">[DA COMPILARE]</span></td>
       <td><span class="placeholder">[DA COMPILARE]</span></td>
       <td><span class="placeholder">[DA COMPILARE]</span></td></tr>`;

  const workerDeclRows = (d.workers && d.workers.length > 0)
    ? d.workers.map((w, i) => `<tr>
        <td>${i + 1}</td><td>${v(w.name)}</td><td>&nbsp;</td><td>&nbsp;</td>
      </tr>`).join('')
    : `<tr><td>1</td><td><span class="placeholder">[DA COMPILARE]</span></td><td>&nbsp;</td><td>&nbsp;</td></tr>
       <tr><td>2</td><td><span class="placeholder">[DA COMPILARE]</span></td><td>&nbsp;</td><td>&nbsp;</td></tr>
       <tr><td>3</td><td><span class="placeholder">[DA COMPILARE]</span></td><td>&nbsp;</td><td>&nbsp;</td></tr>`;

  // Carica immagini cartelli in parallelo
  const signsWithImages = await enrichSignsWithImages(signs);

  // ── COPERTINA ──────────────────────────────────────────────────────────────
  const cover = `
<div class="cover">

  <div class="cover-sidebar">
    <div class="cover-sidebar-brand">Palladia</div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Oggetto</div>
      <div class="cover-value">${esc(d.workType || '[DA COMPILARE]')}</div>
    </div>
    <div class="cover-sidebar-item">
      <div class="cover-label">Committente</div>
      <div class="cover-value">${esc(d.client || '[DA COMPILARE]')}</div>
    </div>
    <div class="cover-sidebar-item">
      <div class="cover-label">Cantiere</div>
      <div class="cover-value">${esc(siteName)}</div>
    </div>
    <div class="cover-sidebar-item">
      <div class="cover-label">Impresa esecutrice</div>
      <div class="cover-value">${esc(d.companyName || '[DA COMPILARE]')}</div>
    </div>
    <div class="cover-sidebar-item">
      <div class="cover-label">P.IVA</div>
      <div class="cover-value">${esc(d.companyVat || '[DA COMPILARE]')}</div>
    </div>
    <div class="cover-sidebar-item">
      <div class="cover-label">Revisione</div>
      <div class="cover-value">Rev.&#160;${rev}</div>
    </div>
    <div class="cover-sidebar-item">
      <div class="cover-label">Data emissione</div>
      <div class="cover-value">${oggi}</div>
    </div>

    <div class="cover-sidebar-footer">
      Redatto ai sensi del D.lgs 81/2008 e s.m.i.<br>
      Generato con Palladia
    </div>
  </div>

  <div class="cover-main">
    <div class="cover-top">
      <div class="cover-title">Piano Operativo<br>di Sicurezza</div>
      <div class="cover-subtitle">ai sensi del D.lgs 81/2008 e s.m.i. — Allegato XV</div>
      <div class="cover-rev-badge">Revisione ${rev}</div>
      <div class="cover-divider"></div>
      <div class="cover-info-box">
        ${d.workType    ? `<div class="cover-info-row"><span class="cover-info-label">Natura dei lavori</span><span class="cover-info-val">${esc(d.workType)}</span></div>` : ''}
        ${d.client      ? `<div class="cover-info-row"><span class="cover-info-label">Committente</span><span class="cover-info-val">${esc(d.client)}</span></div>` : ''}
        ${siteName      ? `<div class="cover-info-row"><span class="cover-info-label">Cantiere</span><span class="cover-info-val">${esc(siteName)}</span></div>` : ''}
        ${(d.startDate||d.endDate) ? `<div class="cover-info-row"><span class="cover-info-label">Periodo</span><span class="cover-info-val">${esc(d.startDate||'')}&#160;–&#160;${esc(d.endDate||'')}</span></div>` : ''}
        ${d.budget      ? `<div class="cover-info-row"><span class="cover-info-label">Importo lavori</span><span class="cover-info-val">€&#160;${esc(String(d.budget))}</span></div>` : ''}
        <div class="cover-info-row"><span class="cover-info-label">Impresa</span><span class="cover-info-val">${esc(d.companyName||'[DA COMPILARE]')}</span></div>
      </div>
    </div>

    <div class="cover-bottom">
      <div style="font-size:6pt;color:#AAAAAA;text-transform:uppercase;letter-spacing:0.8pt;margin-bottom:5pt;">Firme del documento</div>
      <div class="cover-sig-row">
        <div class="cover-sig-box">
          <div class="cover-sig-label">Datore di lavoro</div>
          <div class="cover-sig-name">${esc(d.companyName||'—')}</div>
        </div>
        <div class="cover-sig-box">
          <div class="cover-sig-label">RSPP</div>
          <div class="cover-sig-name">${esc(d.rspp||'[DA COMPILARE]')}</div>
        </div>
        <div class="cover-sig-box">
          <div class="cover-sig-label">CSE (presa visione)</div>
          <div class="cover-sig-name">${esc(d.cse||'[DA COMPILARE]')}</div>
        </div>
      </div>
      <div class="cover-footer-note">
        Elaborato ai sensi del D.lgs 81/2008 art. 89 c.1 lett. h) — Versione digitale generata con Palladia
      </div>
    </div>
  </div>

</div>`;

  // ── PAGINA FIRME (INIZIO DOCUMENTO) ────────────────────────────────────────
  const s0_firme = `
<div class="section-title page-break">Firme e Sottoscrizione del Documento</div>
<p>Il presente Piano Operativo di Sicurezza, redatto ai sensi dell'art. 89 comma 1 lettera h)
del D.lgs 81/2008 e s.m.i., viene sottoscritto dalle figure responsabili dell'impresa esecutrice
per attestazione di redazione, presa visione e accettazione delle disposizioni contenute.</p>
<div class="signature-grid">
  ${buildSigBox('Datore di Lavoro dell\'impresa esecutrice', v(d.companyName))}
  ${buildSigBox('RSPP — Responsabile Servizio Prevenzione e Protezione', v(d.rspp))}
  ${buildSigBox('RLS — Rappresentante dei Lavoratori per la Sicurezza', v(d.rls))}
  ${buildSigBox('Medico Competente', v(d.medico))}
</div>
${buildSigBox('CSE — Coordinatore per la Sicurezza in fase di Esecuzione (per presa visione)', v(d.cse), true)}
<p class="muted" style="margin-top:10pt;font-size:8pt;text-align:center;">
  Le firme apposte nella presente pagina, corredate del timbro aziendale, attestano l'avvenuta
  redazione e condivisione del POS ai sensi del D.lgs 81/2008.
</p>`;

  const s1 = `
<div class="section-title">Sezione 1 — Intestazione e Dati Identificativi</div>
<p>Il presente Piano Operativo di Sicurezza (POS) viene redatto ai sensi dell'art. 89, comma 1, lettera h)
del D.lgs 81/2008 e s.m.i., come documento complementare al Piano di Sicurezza e Coordinamento (PSC),
ove previsto, e contiene le misure preventive e protettive specifiche dell'impresa esecutrice.</p>
<table class="no-break">
  <thead><tr><th style="width:40%">Campo</th><th>Valore</th></tr></thead>
  <tbody>
    <tr><td>Impresa esecutrice</td><td>${v(d.companyName)}</td></tr>
    <tr><td>Partita IVA</td><td>${v(d.companyVat)}</td></tr>
    <tr><td>Cantiere</td><td>${v(d.siteAddress)}</td></tr>
    <tr><td>Committente</td><td>${v(d.client)}</td></tr>
    <tr><td>Natura dei lavori</td><td>${v(d.workType)}</td></tr>
    <tr><td>Revisione</td><td>${rev}</td></tr>
    <tr><td>Data di emissione</td><td>${oggi}</td></tr>
  </tbody>
</table>`;

  const s2 = `
<div class="section-title">Sezione 2 — Dati Generali del Lavoro</div>
<div class="sub-title">2.1 Descrizione dell'opera</div>
<table class="no-break">
  <thead><tr><th style="width:40%">Campo</th><th>Valore</th></tr></thead>
  <tbody>
    <tr><td>Indirizzo cantiere</td><td>${v(d.siteAddress)}</td></tr>
    <tr><td>Committente</td><td>${v(d.client)}</td></tr>
    <tr><td>Natura dei lavori</td><td>${v(d.workType)}</td></tr>
    <tr><td>Importo lavori</td><td>EUR ${d.budget ? esc(String(d.budget)) : '<span class="placeholder">[DA COMPILARE]</span>'}</td></tr>
    <tr><td>Data inizio prevista</td><td>${v(d.startDate)}</td></tr>
    <tr><td>Data fine prevista</td><td>${v(d.endDate)}</td></tr>
    <tr><td>Numero massimo operai</td><td>${esc(String(workersCount))}</td></tr>
  </tbody>
</table>
<div class="sub-title">2.2 Elenco lavoratori impiegati in cantiere</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:6%">N.</th>
    <th style="width:30%">Nominativo</th>
    <th style="width:34%">Qualifica</th>
    <th style="width:30%">Matricola</th>
  </tr></thead>
  <tbody>${workerRows}</tbody>
</table>
<div class="sub-title">2.3 Orario di lavoro</div>
<ul>
  <li>Orario ordinario: 08:00 – 12:00 / 13:00 – 17:00</li>
  <li>Sabato: solo se autorizzato dal Coordinatore per l'Esecuzione</li>
  <li>Lavoro notturno: non previsto (salvo autorizzazione specifica)</li>
</ul>`;

  const s3 = `
<div class="section-title">Sezione 3 — Soggetti con Compiti di Sicurezza</div>
<div class="sub-title">3.1 Organigramma della sicurezza</div>
<table class="no-break">
  <thead><tr><th style="width:50%">Ruolo</th><th>Nominativo</th></tr></thead>
  <tbody>
    <tr><td>Datore di Lavoro</td><td>${v(d.companyName)}</td></tr>
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
<div class="sub-title">3.2 Compiti e responsabilità</div>
<p><strong>Datore di Lavoro:</strong> Responsabile dell'organizzazione della sicurezza in cantiere. Nomina le figure,
fornisce i DPI, assicura la formazione (art. 17 D.lgs 81/2008).</p>
<p><strong>RSPP:</strong> Collabora nella valutazione dei rischi, elaborazione delle misure preventive, scelta dei DPI e formazione.</p>
<p><strong>RLS:</strong> Rappresenta i lavoratori per la sicurezza. Partecipa alle riunioni periodiche, può richiedere verifiche.</p>
<p><strong>Medico Competente:</strong> Effettua la sorveglianza sanitaria, esprime i giudizi di idoneità.</p>
<p><strong>Preposto:</strong> Sorveglia le attività lavorative, verifica il rispetto delle procedure di sicurezza (art. 19 D.lgs 81/2008).</p>`;

  const s4 = `
<div class="section-title">Sezione 4 — Area di Cantiere e Organizzazione</div>
<div class="sub-title">4.1 Caratteristiche dell'area e recinzione</div>
<p>L'area di cantiere sarà delimitata con recinzione perimetrale continua di altezza minima 2 metri,
realizzata con pannelli metallici modulari su basi in calcestruzzo. Accessi controllati con cancello chiudibile a chiave.</p>
<div class="sub-title">4.2 Viabilità di cantiere</div>
<ul>
  <li>Accesso carraio: cancello principale larghezza minima 4 m</li>
  <li>Accesso pedonale: separato, con percorso protetto</li>
  <li>Velocità massima in cantiere: 10 km/h</li>
  <li>Senso unico di marcia dove la larghezza non consente doppio senso</li>
</ul>
<div class="sub-title">4.3 Impianto elettrico di cantiere</div>
<ul>
  <li>Quadro generale con interruttore differenziale Id = 30 mA</li>
  <li>Sottoquadri di zona con protezioni magnetotermiche e differenziali</li>
  <li>Impianto di messa a terra con verifica biennale (DPR 462/01)</li>
  <li>Cavi e prolunghe di tipo H07RN-F (resistenti all'acqua e all'abrasione)</li>
</ul>
<div class="sub-title">4.4 Servizi igienico-assistenziali</div>
<ul>
  <li>Spogliatoi con armadietti a doppio scomparto</li>
  <li>Servizi igienici: min. 1 ogni 10 lavoratori</li>
  <li>Locale refettorio con scaldavivande e frigorifero</li>
  <li>Cassetta di primo soccorso conforme al D.M. 388/2003 (Gruppo B)</li>
</ul>
<div class="sub-title">4.5 Depositi e stoccaggi</div>
<ul>
  <li>Deposito materiali: superficie piana e stabile, accatastamento sicuro</li>
  <li>Deposito sostanze pericolose: area dedicata, coperta, con bacino di contenimento</li>
  <li>Deposito rifiuti: area recintata con contenitori differenziati e cartellonistica</li>
</ul>`;

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
  <div class="emergency-card" style="background:#555;">
    <span class="emergency-number" style="font-size:12pt;">02 66101029</span>
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
<div class="sub-title">9.1 Disposizioni generali</div>
<p>Tutte le macchine e attrezzature devono essere conformi alla Direttiva Macchine 2006/42/CE, dotate di
marcatura CE e dichiarazione di conformità. Devono essere usate secondo le istruzioni del fabbricante.</p>
<div class="sub-title">9.2 Verifiche obbligatorie — All. VII D.lgs 81/2008</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:28%">Attrezzatura</th>
    <th style="width:28%">Tipo di verifica</th>
    <th style="width:18%">Frequenza</th>
    <th>Riferimento normativo</th>
  </tr></thead>
  <tbody>
    <tr><td>Gru a torre</td><td>Prima verifica + periodica</td><td>Biennale</td><td>All. VII D.lgs 81/08</td></tr>
    <tr><td>Gru su autocarro</td><td>Prima verifica + periodica</td><td>Annuale</td><td>All. VII D.lgs 81/08</td></tr>
    <tr><td>Piattaforme elevabili (PLE)</td><td>Prima verifica + periodica</td><td>Annuale</td><td>All. VII D.lgs 81/08</td></tr>
    <tr><td>Ponteggi metallici</td><td>Verifica prima del montaggio</td><td>Ad ogni montaggio</td><td>Art. 137 D.lgs 81/08</td></tr>
    <tr><td>Scale portatili</td><td>Controllo visivo</td><td>Giornaliero</td><td>UNI EN 131</td></tr>
    <tr><td>Impianto elettrico</td><td>Verifica impianto di terra</td><td>Biennale</td><td>DPR 462/01</td></tr>
    <tr><td>Funi e catene</td><td>Controllo periodico</td><td>Trimestrale</td><td>Art. 71 D.lgs 81/08</td></tr>
  </tbody>
</table>
<div class="sub-title">9.3 Abilitazioni operatori — Acc. Stato-Regioni 22/02/2012</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:35%">Attrezzatura</th>
    <th style="width:35%">Abilitazione richiesta</th>
    <th>Riferimento</th>
  </tr></thead>
  <tbody>
    <tr><td>Gru a torre e su autocarro</td><td>Patentino gruista</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Piattaforme elevabili (PLE)</td><td>Patentino PLE</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Escavatori (&gt;6 t)</td><td>Patentino escavatorista</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Carrello elevatore</td><td>Patentino carrellista</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Autobetoniera</td><td>Patente C + CQC</td><td>Codice della Strada</td></tr>
  </tbody>
</table>`;

  const s10 = `
<div class="section-title">Sezione 10 — Sostanze e Preparati Pericolosi</div>
<div class="sub-title">10.1 Obblighi — Regolamento REACH e Reg. CLP</div>
<p>Per ogni sostanza pericolosa: SDS (Scheda Dati di Sicurezza) aggiornata in 16 sezioni, conservata accessibile
a tutti i lavoratori, stoccaggio in area dedicata con bacino di contenimento.</p>
<div class="sub-title">10.2 Sostanze comuni in cantiere</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:22%">Sostanza</th>
    <th style="width:22%">Classificazione CLP</th>
    <th style="width:30%">Rischi principali</th>
    <th>DPI richiesti</th>
  </tr></thead>
  <tbody>
    <tr><td>Cemento / calcestruzzo</td><td>H315, H317, H318</td><td>Irritazione cutanea, sensibilizzazione, lesioni oculari</td><td>Guanti, occhiali, mascherina</td></tr>
    <tr><td>Vernici e solventi</td><td>H225, H304, H336</td><td>Infiammabile, tossicità per inalazione</td><td>Maschera filtri A, guanti chimici</td></tr>
    <tr><td>Resine epossidiche</td><td>H315, H317, H319</td><td>Sensibilizzazione cutanea e oculare</td><td>Guanti nitrile, occhiali</td></tr>
    <tr><td>Gasolio per macchine</td><td>H226, H304, H332</td><td>Infiammabile, nocivo per inalazione</td><td>Guanti, maschera se vapori</td></tr>
    <tr><td>Amianto (se presente)</td><td>H350 — Cancerogeno</td><td>Cancerogeno — gestione speciale</td><td>Piano specifico art. 256 D.lgs 81/08</td></tr>
  </tbody>
</table>`;

  const s11 = `
<div class="section-title">Sezione 11 — Gestione Rifiuti</div>
<div class="sub-title">11.1 Normativa — D.lgs 152/2006 (TUA) e s.m.i.</div>
<p>La gestione dei rifiuti è effettuata nel rispetto del D.lgs 152/2006. Deposito temporaneo effettuato
nel rispetto dell'art. 183 co. 1 lett. bb) TUA. Formulari di Identificazione Rifiuti per ogni trasporto.</p>
<div class="sub-title">11.2 Codici CER dei rifiuti tipici di cantiere</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:18%">Codice CER</th>
    <th style="width:35%">Descrizione</th>
    <th style="width:20%">Tipo</th>
    <th>Gestione</th>
  </tr></thead>
  <tbody>
    <tr><td>17 01 01</td><td>Cemento</td><td>Non pericoloso</td><td>Recupero / discarica</td></tr>
    <tr><td>17 01 02</td><td>Mattoni</td><td>Non pericoloso</td><td>Recupero / discarica</td></tr>
    <tr><td>17 02 01</td><td>Legno</td><td>Non pericoloso</td><td>Recupero</td></tr>
    <tr><td>17 02 02</td><td>Vetro</td><td>Non pericoloso</td><td>Recupero</td></tr>
    <tr><td>17 04 05</td><td>Ferro e acciaio</td><td>Non pericoloso</td><td>Recupero</td></tr>
    <tr><td>17 09 04</td><td>Rifiuti misti costruzione/demolizione</td><td>Non pericoloso</td><td>Recupero / discarica</td></tr>
    <tr><td>17 06 01*</td><td>Materiali isolanti con amianto</td><td><strong>Pericoloso</strong></td><td>Ditta specializzata</td></tr>
    <tr><td>08 01 11*</td><td>Pitture/vernici con solventi organici</td><td><strong>Pericoloso</strong></td><td>Impianto autorizzato</td></tr>
    <tr><td>13 02 08*</td><td>Oli esausti</td><td><strong>Pericoloso</strong></td><td>Consorzio CONOU</td></tr>
  </tbody>
</table>`;

  const s12 = `
<div class="section-title">Sezione 12 — Formazione e Informazione dei Lavoratori</div>
<div class="sub-title">12.1 Formazione obbligatoria — Acc. Stato-Regioni 21/12/2011</div>
<table class="allow-break">
  <thead><tr>
    <th style="width:38%">Tipo di formazione</th>
    <th style="width:14%">Durata</th>
    <th style="width:22%">Aggiornamento</th>
    <th>Note</th>
  </tr></thead>
  <tbody>
    <tr><td>Formazione generale</td><td>4 ore</td><td>—</td><td>Valida per sempre</td></tr>
    <tr><td>Formazione specifica (rischio alto — edilizia)</td><td>12 ore</td><td>6 ore ogni 5 anni</td><td>Obbligatoria per cantieri</td></tr>
    <tr><td>Preposto</td><td>+8 ore</td><td>6 ore ogni 2 anni</td><td>Per chi svolge funzioni di preposto</td></tr>
    <tr><td>Primo Soccorso (Gruppo B)</td><td>12 ore</td><td>4 ore ogni 3 anni</td><td>Addetti designati</td></tr>
    <tr><td>Antincendio (rischio medio)</td><td>8 ore</td><td>5 ore ogni 5 anni</td><td>Addetti designati</td></tr>
    <tr><td>RLS</td><td>32 ore</td><td>4 ore/anno</td><td>Rappresentante Lavoratori Sicurezza</td></tr>
    <tr><td>Ponteggi PIMUS</td><td>28 ore</td><td>4 ore ogni 4 anni</td><td>Montaggio/smontaggio ponteggi</td></tr>
    <tr><td>Lavori in quota</td><td>4–8 ore</td><td>Secondo tipologia</td><td>Per chi opera oltre 2 m</td></tr>
  </tbody>
</table>
<div class="sub-title">12.2 Informazione all'ingresso in cantiere</div>
<p>All'ingresso in cantiere, ogni lavoratore riceve informazione su: rischi specifici, misure preventive,
procedure di emergenza, nominativi delle figure di sicurezza, ubicazione presidi di primo soccorso,
estintori e punto di raccolta. L'avvenuta informazione è documentata con firma su apposito registro.</p>`;

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
<div class="section-title page-break">Sezione 14 — Firme e Presa Visione</div>
<p>Il presente Piano Operativo di Sicurezza è stato redatto ai sensi del D.lgs 81/2008 e s.m.i.
e viene sottoscritto per accettazione e presa visione dalle seguenti figure responsabili.
Le firme devono essere apposte con timbro aziendale a fianco della firma per piena validità.</p>
<div class="signature-grid">
  ${buildSigBox('Datore di Lavoro dell\'impresa esecutrice', v(d.companyName))}
  ${buildSigBox('RSPP — Responsabile Servizio Prevenzione e Protezione', v(d.rspp))}
  ${buildSigBox('RLS — Rappresentante dei Lavoratori per la Sicurezza', v(d.rls))}
  ${buildSigBox('Medico Competente', v(d.medico))}
</div>
${buildSigBox('CSE — Coordinatore per la Sicurezza in fase di Esecuzione (per presa visione)', v(d.cse), true)}
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

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>${esc(docTitle)}</title>
  <style>${buildCss()}</style>
</head>
<body>

<div class="print-header">
  <span class="ph-brand">PALLADIA</span>
  <span class="ph-title">${esc(docTitle)}</span>
</div>

<div class="print-footer">
  <span class="pf-left">D.Lgs 81/2008 e s.m.i.</span>
  <span class="pf-center">Pagina&#160;<span class="page-num"></span>&#160;/&#160;<span class="total-pages">—</span></span>
  <span class="pf-right">Rev.&#160;${rev}</span>
</div>

<div class="doc">
${cover}
<div class="content">
${s0_firme}
${s1}${s2}${s3}${s4}${s5}${s6}${s7}${s8}${s9}${s10}${s11}${s12}${s13}${s14}
</div>
</div>

</body>
</html>`;
}

module.exports = { generatePosHtml };
