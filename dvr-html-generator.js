'use strict';

/**
 * DVR HTML Generator — v1
 * Genera l'HTML completo per il Documento di Valutazione dei Rischi (D.Lgs 81/2008 Art. 28).
 * Pattern identico a pos-html-generator.js:
 *  - Stessi margini Puppeteer (top:26mm, bottom:24mm) — NESSUNA modifica
 *  - Stessa griglia .doc { padding: 0 16mm }
 *  - Header/Footer gestiti da pdf-renderer.js (buildHeaderTemplate / buildFooterTemplate)
 */

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
function vOpt(val) {
  return val ? esc(val) : '<span style="color:#AAAAAA;font-style:italic;">—</span>';
}
function boldify(text) {
  if (!text) return '';
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function formatDate(val) {
  if (!val) return null;
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(val);
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
      const isRiskNum = /^\s*r\s*[(=]|^\s*r\s*$/i.test(hdr);
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

// ── MANSIONE BLOCKS (sezione AI) ──────────────────────────────────────────────
function buildMansioneBlocks(aiContent) {
  if (!aiContent || !aiContent.trim()) {
    return '<div class="callout">Valutazione rischi non disponibile. Integrare manualmente.</div>';
  }
  const blocks = aiContent.split(/(?=^### )/m).filter(b => b.trim());
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
    <div class="mansione-block">
      <div class="mans-header">${esc(title)}</div>
      <div class="mans-body">${parseMd(bodyStr)}</div>
    </div>`;
  }
  return html || '<div class="callout">Nessuna mansione generata.</div>';
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function buildCss() {
  return `
/* Regola fondamentale: @page margin DEVE corrispondere esattamente a Puppeteer margin */
@page {
  size: A4;
  margin: 26mm 0 24mm 0;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  min-width: 0;
}
body {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 10pt;
  color: #1E1E1E;
  line-height: 1.65;
  background: #FFFFFF;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.doc {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 0 16mm;
}
img { max-width: 100%; height: auto; display: block; break-inside: avoid; }
table { max-width: 100%; }

h1, h2, h3 {
  break-after: avoid-page;
  page-break-after: avoid;
}
tr {
  break-inside: avoid;
  page-break-inside: avoid;
}
thead { display: table-header-group; }
.no-break { break-inside: avoid; page-break-inside: avoid; }

/* ── COVER ─────────────────────────────────────────────────────────────── */
.cover {
  height: 247mm;
  overflow: hidden;
  break-after: page;
  page-break-after: always;
  display: flex;
  width: 100%;
  max-width: 100%;
}
.cover-sidebar {
  width: 58mm;
  max-width: 58mm;
  flex-shrink: 0;
  background: #1A3A5C;
  color: #FFFFFF;
  padding: 12mm 8mm 10mm 10mm;
  display: flex;
  flex-direction: column;
}
.cover-sidebar-brand {
  font-size: 9pt;
  font-weight: bold;
  letter-spacing: 3pt;
  text-transform: uppercase;
  color: #7BADD6;
  margin-bottom: 9mm;
  padding-bottom: 5mm;
  border-bottom: 0.5pt solid #2D5A8A;
}
.cover-sidebar-item { margin-bottom: 6mm; }
.cover-label {
  font-size: 5.5pt;
  letter-spacing: 1.2pt;
  text-transform: uppercase;
  color: #7BADD6;
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
  font-size: 6pt;
  color: #4A7BAA;
  padding-top: 5mm;
  border-top: 0.5pt solid #2D5A8A;
  line-height: 1.5;
}
.cover-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  padding: 12mm 10mm 10mm 12mm;
  display: flex;
  flex-direction: column;
  background: #FFFFFF;
}
.cover-top { flex: 1; min-height: 0; }
.cover-norm-badge {
  display: inline-block;
  background: #EBF3FB;
  color: #1A3A5C;
  font-size: 7.5pt;
  font-weight: bold;
  padding: 3pt 10pt;
  border-radius: 2pt;
  margin-bottom: 6mm;
  letter-spacing: 0.3pt;
  border: 0.5pt solid #B8D4EC;
}
.cover-title {
  font-size: 20pt;
  font-weight: bold;
  color: #1A3A5C;
  text-transform: uppercase;
  letter-spacing: 0.3pt;
  line-height: 1.15;
  margin-bottom: 3mm;
}
.cover-subtitle {
  font-size: 9pt;
  color: #777777;
  margin-bottom: 7mm;
  font-style: italic;
}
.cover-rev-badge {
  display: inline-block;
  background: #1A3A5C;
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
  background: #F8FBFE;
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
  border-top: 2pt solid #1A3A5C;
  padding: 7pt 8pt 10pt;
  min-height: 30mm;
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
  color: #AAAAAA;
  margin-top: 6mm;
  line-height: 1.5;
}

/* ── SECTION TITLE ──────────────────────────────────────────────────────── */
.section-title {
  background: #1A3A5C;
  color: #FFFFFF;
  font-size: 9.5pt;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 1pt;
  padding: 8pt 11pt;
  margin: 16pt 0 14pt 0;
  break-after: avoid;
  page-break-after: avoid;
}
.section-title:first-child { margin-top: 8pt; }

.sub-title {
  background: #F0F5FA;
  border-left: 3pt solid #1A3A5C;
  font-size: 9pt;
  font-weight: bold;
  padding: 6pt 10pt;
  margin: 18pt 0 9pt 0;
  break-after: avoid;
  page-break-after: avoid;
  color: #1A3A5C;
}

/* ── TABLES ─────────────────────────────────────────────────────────────── */
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
table.allow-break { break-inside: auto; page-break-inside: auto; }
table.allow-break thead { display: table-header-group; }
thead th {
  background: #1A3A5C;
  color: #FFFFFF;
  font-weight: bold;
  font-size: 8pt;
  padding: 5pt 7pt;
  text-align: left;
  border: 0.5pt solid #123057;
  overflow: hidden;
  word-break: break-word;
  line-height: 1.4;
}
tbody tr:nth-child(even) { background: #F4F8FC; }
tbody tr:nth-child(odd)  { background: #FFFFFF; }
tbody td {
  padding: 6pt 8pt;
  border: 0.5pt solid #DDDDDD;
  vertical-align: top;
  line-height: 1.6;
}

/* ── RISK BADGES ─────────────────────────────────────────────────────────── */
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

/* ── CALLOUT ─────────────────────────────────────────────────────────────── */
.callout {
  background: #FFFDE7;
  border-left: 3pt solid #F9A825;
  padding: 7pt 10pt;
  margin: 8pt 0;
  font-size: 9pt;
  break-inside: avoid;
}
.callout-info {
  background: #E3F2FD;
  border-left: 3pt solid #1A3A5C;
  padding: 7pt 10pt;
  margin: 8pt 0;
  font-size: 9pt;
  break-inside: avoid;
}

/* ── MANSIONE BLOCKS ─────────────────────────────────────────────────────── */
.mansione-block {
  border: 0.75pt solid #DDDDDD;
  border-radius: 2pt;
  margin: 16pt 0 22pt 0;
  break-inside: auto;
  page-break-inside: auto;
}
.mans-header {
  background: #1A3A5C;
  color: #FFFFFF;
  font-weight: bold;
  font-size: 9.5pt;
  padding: 8pt 11pt;
  break-after: avoid;
  page-break-after: avoid;
}
.mans-body { padding: 11pt 13pt 10pt 13pt; }
.mans-body p          { margin-bottom: 6pt; }
.mans-body ul         { margin: 5pt 0 8pt 18pt; }
.mans-body li         { margin-bottom: 4pt; }
.mans-body .bold-line { font-weight: bold; margin: 8pt 0 3pt 0; color: #1A3A5C; }
.mans-body table      { margin: 6pt 0 9pt 0; font-size: 8.5pt; }

/* ── MATRICE RISCHI ──────────────────────────────────────────────────────── */
.matrix-table { table-layout: auto !important; width: auto !important; margin: 10pt auto !important; }
.matrix-table td {
  width: 22mm; height: 14mm;
  text-align: center; vertical-align: middle;
  font-size: 8pt; font-weight: bold;
  border: 0.5pt solid #FFFFFF;
}
.mx-1 { background: #2E7D32; color: #fff; }
.mx-2 { background: #558B2F; color: #fff; }
.mx-3 { background: #F9A825; color: #1E1E1E; }
.mx-4 { background: #E65100; color: #fff; }
.mx-6 { background: #B71C1C; color: #fff; }
.mx-9 { background: #880E4F; color: #fff; }
.mx-12{ background: #4A0072; color: #fff; }
.mx-16{ background: #1A237E; color: #fff; }
.mx-label { background: #1A3A5C !important; color: #fff !important; font-size: 7.5pt !important; }

/* ── FIRMA BOXES ─────────────────────────────────────────────────────────── */
.firma-row {
  display: flex;
  gap: 8pt;
  margin: 14pt 0 20pt 0;
  break-inside: avoid;
}
.firma-box {
  flex: 1;
  border: 0.5pt solid #DDDDDD;
  border-top: 2pt solid #1A3A5C;
  padding: 8pt 10pt 30pt;
}
.firma-role {
  font-size: 7pt;
  color: #999999;
  text-transform: uppercase;
  letter-spacing: 0.5pt;
  margin-bottom: 3pt;
}
.firma-name { font-size: 9pt; font-weight: bold; color: #1E1E1E; }
.firma-line {
  margin-top: 18mm;
  border-top: 0.5pt solid #AAAAAA;
  font-size: 7pt;
  color: #AAAAAA;
  padding-top: 3pt;
}

/* ── MISC ────────────────────────────────────────────────────────────────── */
.bold-line { font-weight: bold; margin: 8pt 0 3pt 0; color: #2C2C2C; }
p { margin-bottom: 7pt; }
ul { margin: 5pt 0 10pt 20pt; }
li { margin-bottom: 4pt; }
.placeholder { color: #CCCCCC; font-style: italic; }
.info-row {
  display: flex;
  gap: 5pt;
  margin-bottom: 5pt;
  font-size: 9pt;
}
.info-label { font-weight: bold; color: #2C2C2C; width: 45mm; flex-shrink: 0; }
.info-val   { flex: 1; }
`;
}

// ── COVER ─────────────────────────────────────────────────────────────────────
function buildCover(d, revision) {
  const oggi = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const dataDoc = formatDate(d.dataDocumento) || oggi;
  const luogo   = esc(d.luogoRedazione || d.sedeLegale?.split(',').pop()?.trim() || '');

  const mansioni = Array.isArray(d.mansioni) ? d.mansioni : [];
  const nDip = d.numDipendenti ? `${d.numDipendenti} lavoratori` : '';

  return `
<div class="cover">
  <div class="cover-sidebar">
    <div class="cover-sidebar-brand" style="display:flex;align-items:center;gap:5pt"><svg width="8" height="9" viewBox="0 0 544 592" style="flex-shrink:0"><path fill="currentColor" fill-rule="evenodd" d="M 4 4 L 311 4 L 333 6 L 365 12 L 394 21 L 430 38 L 450 51 L 478 75 L 493 92 L 507 112 L 526 151 L 537 195 L 539 214 L 539 245 L 533 285 L 521 321 L 511 341 L 498 361 L 487 375 L 465 397 L 447 411 L 406 434 L 372 446 L 340 453 L 310 456 L 148 456 L 147 587 L 4 587 L 4 4 Z M 107 100 L 305 100 L 329 103 L 354 110 L 370 117 L 389 129 L 413 153 L 421 165 L 429 182 L 434 199 L 437 219 L 437 240 L 433 265 L 428 280 L 419 298 L 408 313 L 394 327 L 377 339 L 359 348 L 338 355 L 305 360 L 148 360 L 147 443 L 107 483 L 107 100 Z"/></svg>PALLADIA</div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Norma di riferimento</div>
      <div class="cover-value">D.Lgs 81/2008<br>Art. 17 e 28</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Datore di lavoro</div>
      <div class="cover-value">${v(d.datoreLavoro)}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">RSPP</div>
      <div class="cover-value">${v(d.rspp)}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">RLS</div>
      <div class="cover-value">${v(d.rls)}</div>
    </div>

    ${d.medicoCompetente ? `
    <div class="cover-sidebar-item">
      <div class="cover-label">Medico Competente</div>
      <div class="cover-value">${esc(d.medicoCompetente)}</div>
    </div>` : ''}

    ${nDip ? `
    <div class="cover-sidebar-item">
      <div class="cover-label">Organico</div>
      <div class="cover-value">${esc(nDip)}</div>
    </div>` : ''}

    <div class="cover-sidebar-footer">
      Generato con Palladia<br>
      Sistema AI D.Lgs 81/2008
    </div>
  </div>

  <div class="cover-main">
    <div class="cover-top">
      <div class="cover-norm-badge">D.Lgs 81/2008 — Art. 28</div>
      <div class="cover-title">Documento di<br>Valutazione<br>dei Rischi</div>
      <div class="cover-subtitle">Valutazione di tutti i rischi per la sicurezza e la salute dei lavoratori</div>
      <div class="cover-rev-badge">Revisione ${revision}</div>
      <hr class="cover-divider">
      <div class="cover-info-box">
        <div class="cover-info-row">
          <span class="cover-info-label">Azienda</span>
          <span class="cover-info-val">${v(d.ragioneSociale)}</span>
        </div>
        ${d.piva ? `
        <div class="cover-info-row">
          <span class="cover-info-label">Partita IVA</span>
          <span class="cover-info-val">${esc(d.piva)}</span>
        </div>` : ''}
        <div class="cover-info-row">
          <span class="cover-info-label">Sede legale</span>
          <span class="cover-info-val">${v(d.sedeLegale)}</span>
        </div>
        ${d.settore ? `
        <div class="cover-info-row">
          <span class="cover-info-label">Settore ATECO</span>
          <span class="cover-info-val">${esc(d.settore)}${d.codiceAteco ? ` (${esc(d.codiceAteco)})` : ''}</span>
        </div>` : ''}
        <div class="cover-info-row">
          <span class="cover-info-label">Mansioni valutate</span>
          <span class="cover-info-val">${mansioni.length > 0 ? esc(mansioni.map(m => m.nome).join(', ')) : v(null)}</span>
        </div>
        <div class="cover-info-row">
          <span class="cover-info-label">Data documento</span>
          <span class="cover-info-val">${esc(dataDoc)}${luogo ? ` — ${luogo}` : ''}</span>
        </div>
      </div>
    </div>

    <div class="cover-bottom">
      <div class="cover-sig-row">
        <div class="cover-sig-box">
          <div class="cover-sig-label">Datore di Lavoro</div>
          <div class="cover-sig-name">${v(d.datoreLavoro)}</div>
        </div>
        <div class="cover-sig-box">
          <div class="cover-sig-label">RSPP</div>
          <div class="cover-sig-name">${v(d.rspp)}</div>
        </div>
        <div class="cover-sig-box">
          <div class="cover-sig-label">RLS</div>
          <div class="cover-sig-name">${v(d.rls)}</div>
        </div>
        ${d.medicoCompetente ? `
        <div class="cover-sig-box">
          <div class="cover-sig-label">Medico Competente</div>
          <div class="cover-sig-name">${esc(d.medicoCompetente)}</div>
        </div>` : ''}
      </div>
      <div class="cover-footer-note">
        Il presente documento è stato redatto ai sensi dell'art. 28 del D.Lgs 81/2008 e successive modifiche e integrazioni.
        La valutazione dei rischi è stata effettuata tenendo conto di tutti i rischi per la sicurezza e la salute dei lavoratori,
        ivi compresi quelli riguardanti gruppi di lavoratori esposti a rischi particolari.
      </div>
    </div>
  </div>
</div>`;
}

// ── SEZIONE 1: ANAGRAFICA ─────────────────────────────────────────────────────
function buildAnagrafica(d) {
  return `
<div class="section-title">1. Anagrafica Azienda</div>
<table class="allow-break">
  <colgroup><col style="width:35%"><col style="width:65%"></colgroup>
  <thead><tr><th>Campo</th><th>Valore</th></tr></thead>
  <tbody>
    <tr><td><strong>Ragione sociale</strong></td><td>${v(d.ragioneSociale)}</td></tr>
    <tr><td><strong>Partita IVA</strong></td><td>${vOpt(d.piva)}</td></tr>
    <tr><td><strong>Codice Fiscale</strong></td><td>${vOpt(d.codiceFiscale)}</td></tr>
    <tr><td><strong>Codice ATECO</strong></td><td>${vOpt(d.codiceAteco)}</td></tr>
    <tr><td><strong>Settore di attività</strong></td><td>${v(d.settore)}</td></tr>
    <tr><td><strong>Sede legale</strong></td><td>${v(d.sedeLegale)}</td></tr>
    ${d.sedeOperativa ? `<tr><td><strong>Sede operativa</strong></td><td>${esc(d.sedeOperativa)}</td></tr>` : ''}
    <tr><td><strong>N° lavoratori</strong></td><td>${d.numDipendenti ? esc(String(d.numDipendenti)) : v(null)}</td></tr>
    ${d.inailPosizione ? `<tr><td><strong>Posizione INAIL</strong></td><td>${esc(d.inailPosizione)}</td></tr>` : ''}
    ${d.inpsMatricola  ? `<tr><td><strong>Matricola INPS</strong></td><td>${esc(d.inpsMatricola)}</td></tr>`  : ''}
  </tbody>
</table>`;
}

// ── SEZIONE 2: FIGURE DELLA SICUREZZA ─────────────────────────────────────────
function buildFigureSicurezza(d) {
  const preposti = Array.isArray(d.preposti) ? d.preposti : [];

  return `
<div class="section-title">2. Figure della Sicurezza (D.Lgs 81/2008 Art. 2)</div>
<table class="allow-break">
  <colgroup><col style="width:28%"><col style="width:30%"><col style="width:42%"></colgroup>
  <thead><tr><th>Figura</th><th>Nominativo</th><th>Note / Contatti</th></tr></thead>
  <tbody>
    <tr>
      <td><strong>Datore di Lavoro (DL)</strong></td>
      <td>${v(d.datoreLavoro)}</td>
      <td>Responsabile dell'adempimento degli obblighi ex Art. 17</td>
    </tr>
    <tr>
      <td><strong>RSPP</strong></td>
      <td>${v(d.rspp)}</td>
      <td>${d.rsppTipo === 'esterno' ? 'Servizio esterno' : 'Servizio interno'}${d.rsppEmail ? ` — ${esc(d.rsppEmail)}` : ''}</td>
    </tr>
    <tr>
      <td><strong>RLS</strong><br><span style="font-size:7.5pt;color:#777;">Rappresentante Lavoratori</span></td>
      <td>${v(d.rls)}</td>
      <td>Designato ai sensi dell'Art. 47</td>
    </tr>
    ${d.medicoCompetente ? `
    <tr>
      <td><strong>Medico Competente (MC)</strong></td>
      <td>${esc(d.medicoCompetente)}</td>
      <td>${d.medicoOrdine ? esc(d.medicoOrdine) : 'Sorveglianza sanitaria ex Art. 41'}</td>
    </tr>` : ''}
    ${preposti.length > 0 ? `
    <tr>
      <td><strong>Preposto/i</strong></td>
      <td>${preposti.map(p => esc(p)).join('<br>')}</td>
      <td>Sovraintende alle attività lavorative ex Art. 19</td>
    </tr>` : ''}
    ${d.addettoPrimoSoccorso ? `
    <tr>
      <td><strong>Addetto Primo Soccorso</strong></td>
      <td>${esc(d.addettoPrimoSoccorso)}</td>
      <td>Squadra emergenza — Gruppo A/B/C (D.M. 388/2003)</td>
    </tr>` : ''}
    ${d.addettoAntincendio ? `
    <tr>
      <td><strong>Addetto Antincendio</strong></td>
      <td>${esc(d.addettoAntincendio)}</td>
      <td>Rischio incendio ex D.M. 2/9/2021</td>
    </tr>` : ''}
  </tbody>
</table>`;
}

// ── SEZIONE 3: DESCRIZIONE ATTIVITÀ ───────────────────────────────────────────
function buildDescrizioneAttivita(d) {
  const attrezzature = Array.isArray(d.attrezzature)
    ? d.attrezzature : (d.attrezzature ? [d.attrezzature] : []);
  const agentiChimici = Array.isArray(d.agentiChimici)
    ? d.agentiChimici : (d.agentiChimici ? [d.agentiChimici] : []);
  const agentiFisici = Array.isArray(d.agentiFisici)
    ? d.agentiFisici : (d.agentiFisici ? [d.agentiFisici] : []);

  return `
<div class="section-title">3. Descrizione dell'Attività Lavorativa</div>
<div class="sub-title">3.1 Attività principale</div>
<p>${v(d.descrizioneAttivita)}</p>

<div class="sub-title">3.2 Ambienti di lavoro</div>
<p>${d.ambientiLavoro ? esc(d.ambientiLavoro) : v(null)}</p>

${attrezzature.length > 0 ? `
<div class="sub-title">3.3 Attrezzature e macchine</div>
<ul>
  ${attrezzature.map(a => `<li>${esc(a)}</li>`).join('')}
</ul>` : ''}

${agentiChimici.length > 0 ? `
<div class="sub-title">3.4 Agenti chimici presenti</div>
<ul>
  ${agentiChimici.map(a => `<li>${esc(a)}</li>`).join('')}
</ul>` : ''}

${agentiFisici.length > 0 ? `
<div class="sub-title">3.5 Agenti fisici presenti</div>
<ul>
  ${agentiFisici.map(a => `<li>${esc(a)}</li>`).join('')}
</ul>` : ''}

${Array.isArray(d.mansioni) && d.mansioni.length > 0 ? `
<div class="sub-title">3.6 Mansioni presenti in azienda</div>
<table class="allow-break">
  <colgroup><col style="width:40%"><col style="width:15%"><col style="width:45%"></colgroup>
  <thead><tr><th>Mansione</th><th>N° addetti</th><th>Descrizione attività</th></tr></thead>
  <tbody>
    ${d.mansioni.map(m => `
    <tr>
      <td>${esc(m.nome)}</td>
      <td style="text-align:center;">${m.numAddetti || '—'}</td>
      <td>${m.attivita ? esc(m.attivita) : '—'}</td>
    </tr>`).join('')}
  </tbody>
</table>` : ''}`;
}

// ── SEZIONE 4: METODOLOGIA ────────────────────────────────────────────────────
function buildMetodologia() {
  return `
<div class="section-title">4. Metodologia di Valutazione dei Rischi</div>
<p>La metodologia adottata per la valutazione dei rischi è basata sull'analisi e la stima del
<strong>livello di rischio R</strong>, ottenuto come prodotto tra la <strong>probabilità P</strong>
dell'evento dannoso e la <strong>gravità del danno D</strong>:</p>

<p style="text-align:center;font-size:12pt;font-weight:bold;margin:10pt 0;">R = P × D</p>

<div class="callout-info">
  <strong>Legenda indici:</strong><br>
  P = Probabilità: 1=Improbabile · 2=Poco probabile · 3=Probabile · 4=Molto probabile<br>
  D = Danno: 1=Lieve · 2=Medio · 3=Grave · 4=Gravissimo (irreversibile/mortale)
</div>

<div class="sub-title">4.1 Matrice di valutazione P × D</div>
<table class="matrix-table no-break">
  <thead>
    <tr>
      <td class="mx-label" style="background:#2C2C2C!important;">P / D</td>
      <td class="mx-label">D=1 Lieve</td>
      <td class="mx-label">D=2 Medio</td>
      <td class="mx-label">D=3 Grave</td>
      <td class="mx-label">D=4 Gravissimo</td>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td class="mx-label">P=1 Improbabile</td>
      <td class="mx-1">1 — Basso</td>
      <td class="mx-2">2 — Basso</td>
      <td class="mx-3">3 — Medio</td>
      <td class="mx-4">4 — Medio</td>
    </tr>
    <tr>
      <td class="mx-label">P=2 Poco prob.</td>
      <td class="mx-2">2 — Basso</td>
      <td class="mx-4">4 — Medio</td>
      <td class="mx-6">6 — Medio</td>
      <td class="mx-6">8 — Alto</td>
    </tr>
    <tr>
      <td class="mx-label">P=3 Probabile</td>
      <td class="mx-3">3 — Medio</td>
      <td class="mx-6">6 — Medio</td>
      <td class="mx-9">9 — Alto</td>
      <td class="mx-12">12 — Alto</td>
    </tr>
    <tr>
      <td class="mx-label">P=4 Molto prob.</td>
      <td class="mx-4">4 — Medio</td>
      <td class="mx-6">8 — Alto</td>
      <td class="mx-12">12 — Alto</td>
      <td class="mx-16">16 — Molto Alto</td>
    </tr>
  </tbody>
</table>

<div class="sub-title">4.2 Scala qualitativa del rischio</div>
<table class="no-break">
  <colgroup><col style="width:20%"><col style="width:20%"><col style="width:60%"></colgroup>
  <thead><tr><th>Indice R</th><th>Livello</th><th>Intervento richiesto</th></tr></thead>
  <tbody>
    <tr><td style="text-align:center;"><span class="risk-num risk-low">1–3</span></td>
        <td><span class="badge badge-low">Basso</span></td>
        <td>Accettabile — monitoraggio periodico; formazione di base</td></tr>
    <tr><td style="text-align:center;"><span class="risk-num risk-medium">4–8</span></td>
        <td><span class="badge badge-medium">Medio</span></td>
        <td>Tollerabile — misure preventive da definire; valutazioni specifiche</td></tr>
    <tr><td style="text-align:center;"><span class="risk-num risk-high">9–12</span></td>
        <td><span class="badge badge-high">Alto</span></td>
        <td>Rilevante — interventi urgenti; procedure operative; DPI specifici</td></tr>
    <tr><td style="text-align:center;"><span class="risk-num risk-very-high">13–16</span></td>
        <td><span class="badge badge-very-high">Molto Alto</span></td>
        <td>Inaccettabile — stop immediato; misure strutturali prima della ripresa</td></tr>
  </tbody>
</table>`;
}

// ── SEZIONE 5: VALUTAZIONE RISCHI (AI content) ────────────────────────────────
function buildValutazioneRischi(aiContent) {
  return `
<div class="section-title">5. Valutazione dei Rischi per Mansione</div>
<div class="callout-info" style="margin-bottom:14pt;">
  La valutazione è stata condotta per ogni mansione presente in azienda, identificando i rischi specifici,
  stimando probabilità e danno secondo la matrice P×D, e definendo le misure di prevenzione e protezione
  ai sensi dell'Art. 28 e dell'Allegato IV del D.Lgs 81/2008.
</div>
${buildMansioneBlocks(aiContent)}`;
}

// ── SEZIONE 6: SORVEGLIANZA SANITARIA ─────────────────────────────────────────
function buildSorveglianzaSanitaria(d) {
  const mc = d.medicoCompetente || '[DA NOMINARE]';
  return `
<div class="section-title">6. Sorveglianza Sanitaria (Art. 41 D.Lgs 81/2008)</div>
<p>La sorveglianza sanitaria è effettuata dal <strong>Medico Competente: ${esc(mc)}</strong>.
Le visite mediche preventive e periodiche sono obbligatorie per tutte le mansioni che espongono
i lavoratori a rischi per i quali la normativa prevede la sorveglianza.</p>

<div class="sub-title">6.1 Mansioni soggette a sorveglianza sanitaria obbligatoria</div>
<table class="allow-break">
  <colgroup><col style="width:30%"><col style="width:25%"><col style="width:25%"><col style="width:20%"></colgroup>
  <thead><tr><th>Mansione</th><th>Rischio specifico</th><th>Periodicità visita</th><th>Riferimento normativo</th></tr></thead>
  <tbody>
    ${Array.isArray(d.mansioni) && d.mansioni.length > 0
      ? d.mansioni.map(m => `
    <tr>
      <td>${esc(m.nome)}</td>
      <td><span class="placeholder">[RISCHIO]</span></td>
      <td><span class="placeholder">[PERIODICITÀ]</span></td>
      <td>Art. 41 D.Lgs 81/2008</td>
    </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:#AAAAAA;">Mansioni non specificate</td></tr>'
    }
  </tbody>
</table>

<div class="callout">
  <strong>Nota:</strong> La periodicità delle visite viene stabilita dal Medico Competente in funzione della specifica
  valutazione del rischio. Le cartelle sanitarie sono conservate presso il MC nel rispetto della privacy (D.Lgs 196/2003).
</div>`;
}

// ── SEZIONE 7: FORMAZIONE E INFORMAZIONE ──────────────────────────────────────
function buildFormazione(d) {
  return `
<div class="section-title">7. Formazione, Informazione e Addestramento (Art. 36-37)</div>
<p>Ai sensi degli artt. 36 e 37 del D.Lgs 81/2008 tutti i lavoratori ricevono formazione, informazione
e addestramento adeguati in materia di salute e sicurezza sul lavoro.</p>

<div class="sub-title">7.1 Piano formativo</div>
<table class="allow-break">
  <colgroup><col style="width:30%"><col style="width:35%"><col style="width:15%"><col style="width:20%"></colgroup>
  <thead><tr><th>Mansione / Figura</th><th>Corso obbligatorio</th><th>Ore minime</th><th>Rinnovo</th></tr></thead>
  <tbody>
    <tr><td>Tutti i lavoratori</td><td>Formazione generale sicurezza</td><td>4h</td><td>5 anni</td></tr>
    <tr><td>Tutti i lavoratori</td><td>Formazione specifica (rischio medio)</td><td>8h</td><td>5 anni</td></tr>
    ${d.rsppTipo === 'interno' ? '<tr><td>RSPP interno</td><td>Corso RSPP (Moduli A+B+C)</td><td>28–48h</td><td>5 anni</td></tr>' : ''}
    <tr><td>Preposti</td><td>Formazione preposti</td><td>8h</td><td>5 anni</td></tr>
    <tr><td>Addetti primo soccorso</td><td>Corso primo soccorso (D.M. 388/2003)</td><td>12–16h</td><td>3 anni</td></tr>
    <tr><td>Addetti antincendio</td><td>Corso antincendio (D.M. 2/9/2021)</td><td>4–16h</td><td>3 anni</td></tr>
    ${Array.isArray(d.mansioni) ? d.mansioni.map(m => `
    <tr>
      <td>${esc(m.nome)}</td>
      <td><span class="placeholder">[CORSO SPECIFICO]</span></td>
      <td><span class="placeholder">[ORE]</span></td>
      <td><span class="placeholder">[RINNOVO]</span></td>
    </tr>`).join('') : ''}
  </tbody>
</table>`;
}

// ── SEZIONE 8: MISURE DI EMERGENZA ────────────────────────────────────────────
function buildEmergenza(d) {
  return `
<div class="section-title">8. Misure di Emergenza e Primo Soccorso (Art. 43-45)</div>
<p>Il datore di lavoro ha predisposto le misure necessarie in materia di primo soccorso, lotta antincendio
ed evacuazione dei lavoratori, designando i lavoratori incaricati e organizzando i necessari contatti con
i servizi esterni.</p>

<div class="sub-title">8.1 Squadra di emergenza</div>
<table class="allow-break">
  <colgroup><col style="width:40%"><col style="width:30%"><col style="width:30%"></colgroup>
  <thead><tr><th>Ruolo</th><th>Nominativo</th><th>Formazione</th></tr></thead>
  <tbody>
    ${d.addettoPrimoSoccorso ? `<tr><td>Addetto Primo Soccorso</td><td>${esc(d.addettoPrimoSoccorso)}</td><td>D.M. 388/2003</td></tr>` : ''}
    ${d.addettoAntincendio   ? `<tr><td>Addetto Antincendio</td><td>${esc(d.addettoAntincendio)}</td><td>D.M. 2/9/2021</td></tr>` : ''}
    <tr><td>Responsabile evacuazione</td><td><span class="placeholder">[DA COMPILARE]</span></td><td>Corso evacuazione</td></tr>
  </tbody>
</table>

<div class="sub-title">8.2 Numeri di emergenza</div>
<table class="no-break">
  <colgroup><col style="width:40%"><col style="width:60%"></colgroup>
  <thead><tr><th>Servizio</th><th>Numero</th></tr></thead>
  <tbody>
    <tr><td>Emergenza generale</td><td><strong>112</strong></td></tr>
    <tr><td>Pronto Soccorso / Ambulanza</td><td><strong>118</strong></td></tr>
    <tr><td>Vigili del Fuoco</td><td><strong>115</strong></td></tr>
    <tr><td>Carabinieri</td><td><strong>112</strong></td></tr>
    <tr><td>Centro Antiveleni</td><td><strong>800 274 274</strong></td></tr>
    <tr><td>Ospedale di riferimento</td><td><span class="placeholder">[DA COMPILARE]</span></td></tr>
  </tbody>
</table>

<div class="callout">
  Il Piano di Emergenza ed Evacuazione (PEE) è affisso nei locali dell'azienda e viene
  comunicato a tutti i lavoratori in occasione dell'ingresso e della formazione iniziale.
</div>`;
}

// ── SEZIONE 9: PIANO DI MIGLIORAMENTO ─────────────────────────────────────────
function buildPianoMiglioramento() {
  return `
<div class="section-title">9. Piano di Miglioramento (Art. 28 c.2 lett. c)</div>
<p>Il programma delle misure ritenute opportune per garantire il miglioramento nel tempo dei livelli
di sicurezza, con l'indicazione delle misure di prevenzione e protezione da adottare.</p>

<table class="allow-break">
  <colgroup><col style="width:35%"><col style="width:15%"><col style="width:20%"><col style="width:15%"><col style="width:15%"></colgroup>
  <thead><tr>
    <th>Misura / Intervento</th>
    <th>Rischio correlato</th>
    <th>Responsabile</th>
    <th>Scadenza</th>
    <th>Stato</th>
  </tr></thead>
  <tbody>
    <tr>
      <td><span class="placeholder">[Intervento 1 — es. Aggiornamento formazione]</span></td>
      <td><span class="placeholder">[Rischio]</span></td>
      <td><span class="placeholder">[Resp.]</span></td>
      <td><span class="placeholder">[Data]</span></td>
      <td><span class="badge badge-medium">In corso</span></td>
    </tr>
    <tr>
      <td><span class="placeholder">[Intervento 2 — es. Sostituzione attrezzatura]</span></td>
      <td><span class="placeholder">[Rischio]</span></td>
      <td><span class="placeholder">[Resp.]</span></td>
      <td><span class="placeholder">[Data]</span></td>
      <td><span class="badge badge-low">Pianificato</span></td>
    </tr>
    <tr>
      <td><span class="placeholder">[Intervento 3]</span></td>
      <td><span class="placeholder">[Rischio]</span></td>
      <td><span class="placeholder">[Resp.]</span></td>
      <td><span class="placeholder">[Data]</span></td>
      <td><span class="badge badge-low">Pianificato</span></td>
    </tr>
  </tbody>
</table>

<div class="callout">
  Il piano di miglioramento viene aggiornato annualmente o in occasione di modifiche significative
  del processo produttivo, dell'organizzazione del lavoro o dell'insorgere di infortuni o near-miss.
</div>`;
}

// ── SEZIONE 10: FIRME ─────────────────────────────────────────────────────────
function buildFirme(d) {
  const oggi = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dataDoc = formatDate(d.dataDocumento) || oggi;
  const luogo   = d.luogoRedazione || '';

  return `
<div class="section-title">10. Firme e Approvazione</div>
<p>Il presente Documento di Valutazione dei Rischi è stato elaborato ai sensi dell'Art. 28 del D.Lgs 81/2008
con la partecipazione del Responsabile del Servizio di Prevenzione e Protezione e la consultazione del
Rappresentante dei Lavoratori per la Sicurezza.</p>

<p>Luogo e data: <strong>${luogo ? `${esc(luogo)}, ` : ''}${esc(dataDoc)}</strong></p>

<div class="firma-row">
  <div class="firma-box">
    <div class="firma-role">Datore di Lavoro</div>
    <div class="firma-name">${v(d.datoreLavoro)}</div>
    <div class="firma-line">Firma</div>
  </div>
  <div class="firma-box">
    <div class="firma-role">RSPP — Responsabile SPP</div>
    <div class="firma-name">${v(d.rspp)}</div>
    <div class="firma-line">Firma</div>
  </div>
</div>
<div class="firma-row">
  <div class="firma-box">
    <div class="firma-role">RLS — Rappresentante Lavoratori</div>
    <div class="firma-name">${v(d.rls)}</div>
    <div class="firma-line">Firma di consultazione (Art. 29 c.2)</div>
  </div>
  ${d.medicoCompetente ? `
  <div class="firma-box">
    <div class="firma-role">Medico Competente</div>
    <div class="firma-name">${esc(d.medicoCompetente)}</div>
    <div class="firma-line">Firma</div>
  </div>` : '<div class="firma-box" style="opacity:0;pointer-events:none;"></div>'}
</div>

<div class="callout-info" style="margin-top:20pt;">
  <strong>Revisioni del documento:</strong><br>
  Revisione 1 — Prima emissione — ${esc(dataDoc)}<br>
  Il presente DVR è soggetto a revisione: ogni qualvolta si verifichino infortuni significativi,
  in occasione di modifiche del processo produttivo o dell'organizzazione del lavoro,
  con cadenza non superiore a 3 anni (Art. 29 c.3).
</div>`;
}

// ── MAIN BUILDER ──────────────────────────────────────────────────────────────
function generateDvrHtml(dvrData, revision, aiContent) {
  const d   = dvrData || {};
  const rev = revision || 1;

  const body = [
    buildCover(d, rev),
    buildAnagrafica(d),
    buildFigureSicurezza(d),
    buildDescrizioneAttivita(d),
    buildMetodologia(),
    buildValutazioneRischi(aiContent),
    buildSorveglianzaSanitaria(d),
    buildFormazione(d),
    buildEmergenza(d),
    buildPianoMiglioramento(),
    buildFirme(d),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DVR — ${esc(d.ragioneSociale || 'Documento di Valutazione dei Rischi')}</title>
  <style>${buildCss()}</style>
</head>
<body>
  <div class="doc">
    ${body}
  </div>
</body>
</html>`;
}

module.exports = { generateDvrHtml };
