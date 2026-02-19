'use strict';

/**
 * POS HTML Generator — Standard v1
 * Genera HTML completo (con CSS print embedded) da PosData JSON.
 * Output pronto per Puppeteer printToPDF.
 */

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
      const isLivello    = /livello/i.test(hdr);
      const isRiskNum    = /^\s*r\s*[\(=]|^\s*r\s*$/i.test(hdr);
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

    if (isTableRow(t)) {
      flushList();
      tableRows.push(t);
      continue;
    } else if (tableRows.length) {
      flushTable();
    }

    if (/^[-*•]\s+/.test(t)) {
      listItems.push(boldify(t.replace(/^[-*•]\s+/, '')));
      continue;
    } else if (listItems.length && t) {
      flushList();
    } else if (listItems.length && !t) {
      flushList();
      continue;
    }

    if (!t) { continue; }
    if (t === '---' || t === '***' || t === '___') continue;
    if (/^\*\*[^*].*(\*\*:?|:)$/.test(t)) {
      html += `<p class="bold-line">${boldify(t)}</p>`;
      continue;
    }
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

// ── SEGNALETICA ───────────────────────────────────────────────────────────────
function buildSegnaleticaHtml(signs) {
  if (!signs || signs.length === 0) {
    return `<p>La segnaletica di sicurezza è definita in conformità al D.lgs 81/2008 Titolo V
    e alle norme ISO 7010. I cartelli devono essere esposti nelle aree indicate dal coordinatore
    per la sicurezza, in posizione visibile e ad altezza non inferiore a 2 m da terra.</p>`;
  }

  let html = `<p>La segnaletica di sicurezza è predisposta in conformità al D.lgs 81/2008 Titolo V
  (artt. 161–166) e alle norme ISO 7010:2019. I cartelli sono stati selezionati automaticamente
  in base alle lavorazioni previste e devono essere esposti nelle ubicazioni indicate, in posizione
  ben visibile e ad altezza minima di 2 m da terra.</p>`;

  let nr = 1;
  for (const zone of ZONE_ORDER) {
    const zoneSigns = signs.filter(s => s.zone === zone);
    if (!zoneSigns.length) continue;

    html += `<div class="sub-title">${esc(zone)}</div>
    <table class="allow-break">
      <thead><tr>
        <th style="width:4%">Nr.</th>
        <th>Cartello</th>
        <th>Categoria</th>
        <th>Ubicazione raccomandata</th>
        <th>Rif. normativo</th>
      </tr></thead>
      <tbody>`;

    for (const sign of zoneSigns) {
      html += `<tr>
        <td>${nr}</td>
        <td>${esc(sign.name.replace(/\.jpg$/i, ''))}</td>
        <td>${esc(sign.category || '')}</td>
        <td>${esc((sign.location || '[DA DEFINIRE]').replace(/\n/g, ' '))}</td>
        <td>${esc((sign.norm || '[DA COMPILARE]').replace(/\n/g, ' '))}</td>
      </tr>`;
      nr++;
    }
    html += '</tbody></table>';
  }
  return html;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function buildCss() {
  return `
/* ═══ RESET ═══════════════════════════════════════════════════════ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ═══ PAGE ═════════════════════════════════════════════════════════ */
@page { size: A4; margin: 16mm 15mm 20mm 15mm; }
@page :first { margin: 0; }

/* ═══ BASE ═════════════════════════════════════════════════════════ */
body {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 10.5pt;
  color: #2C2C2C;
  line-height: 1.55;
  background: white;
}

/* ═══ COVER ════════════════════════════════════════════════════════ */
.cover {
  break-after: page;
  page-break-after: always;
  width: 210mm;
  height: 297mm;
  display: flex;
  overflow: hidden;
}
.cover-sidebar {
  width: 68mm;
  min-height: 297mm;
  background: #3A3A3A;
  color: white;
  padding: 28mm 10mm 14mm 14mm;
  display: flex;
  flex-direction: column;
  position: relative;
}
.cover-sidebar-brand {
  font-size: 11pt;
  font-weight: bold;
  letter-spacing: 4pt;
  text-transform: uppercase;
  color: #BBBBBB;
  margin-bottom: 16mm;
}
.cover-sidebar-item { margin-bottom: 9mm; }
.cover-label {
  font-size: 6pt;
  letter-spacing: 1.5pt;
  text-transform: uppercase;
  color: #888888;
  margin-bottom: 2pt;
}
.cover-value {
  font-size: 9.5pt;
  font-weight: bold;
  color: white;
  line-height: 1.3;
}
.cover-sidebar-footer {
  margin-top: auto;
  font-size: 7pt;
  color: #666666;
  padding-top: 6mm;
  border-top: 0.5pt solid #555555;
}
.cover-main {
  flex: 1;
  padding: 22mm 14mm 14mm 16mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: white;
}
.cover-title {
  font-size: 21pt;
  font-weight: bold;
  color: #2C2C2C;
  text-transform: uppercase;
  letter-spacing: 0.5pt;
  line-height: 1.2;
  margin-bottom: 4mm;
}
.cover-subtitle {
  font-size: 9.5pt;
  color: #666666;
  margin-bottom: 10mm;
}
.cover-rev-badge {
  display: inline-block;
  background: #3A3A3A;
  color: white;
  font-size: 9pt;
  font-weight: bold;
  padding: 3pt 12pt;
  border-radius: 3pt;
  margin-bottom: 10mm;
}
.cover-divider {
  border: none;
  border-top: 1pt solid #E0E0E0;
  margin: 0 0 8mm 0;
}
.cover-info-box {
  border: 0.5pt solid #DDDDDD;
  border-radius: 3pt;
  padding: 8mm 10mm;
  background: #FAFAFA;
  margin-bottom: 8mm;
}
.cover-info-row {
  display: flex;
  margin-bottom: 4pt;
  font-size: 9.5pt;
}
.cover-info-label {
  font-weight: bold;
  color: #3A3A3A;
  min-width: 38mm;
  flex-shrink: 0;
}
.cover-info-val { color: #2C2C2C; }
.cover-sig-row {
  display: flex;
  gap: 6pt;
  margin-top: 6mm;
}
.cover-sig-box {
  flex: 1;
  border: 0.5pt solid #CCCCCC;
  border-radius: 2pt;
  padding: 6pt 8pt;
  min-height: 22mm;
}
.cover-sig-label {
  font-size: 6.5pt;
  color: #888888;
  text-transform: uppercase;
  letter-spacing: 0.5pt;
  margin-bottom: 2pt;
}
.cover-sig-name {
  font-size: 8.5pt;
  font-weight: bold;
  color: #2C2C2C;
}
.cover-footer-note {
  font-size: 7pt;
  color: #AAAAAA;
  margin-top: 6mm;
  border-top: 0.5pt solid #EEEEEE;
  padding-top: 3mm;
}

/* ═══ CONTENT AREA ═════════════════════════════════════════════════ */
.content { /* margins handled by @page */ }

/* ═══ SECTION TITLE ════════════════════════════════════════════════ */
.section-title {
  background: #3A3A3A;
  color: white;
  font-size: 10.5pt;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.8pt;
  padding: 6.5pt 11pt;
  margin: 18pt 0 10pt 0;
  break-after: avoid;
  page-break-after: avoid;
}

/* ═══ SUB-TITLE ════════════════════════════════════════════════════ */
.sub-title {
  background: #EEEEEE;
  border-left: 4pt solid #3A3A3A;
  font-size: 9.5pt;
  font-weight: bold;
  padding: 4.5pt 9pt;
  margin: 11pt 0 6pt 0;
  break-after: avoid;
  page-break-after: avoid;
}

/* ═══ TABLES ═══════════════════════════════════════════════════════ */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9pt;
  margin: 6pt 0 12pt 0;
  break-inside: avoid;
  page-break-inside: avoid;
}
table.allow-break {
  break-inside: auto;
  page-break-inside: auto;
}
table.allow-break thead {
  display: table-header-group;
}
table.allow-break tr {
  break-inside: avoid;
  page-break-inside: avoid;
}
thead th {
  background: #3A3A3A;
  color: white;
  font-weight: bold;
  font-size: 8.5pt;
  padding: 5pt 7pt;
  text-align: left;
  border: 0.5pt solid #2A2A2A;
}
tbody tr:nth-child(even) { background: #F6F6F6; }
tbody tr:nth-child(odd)  { background: white; }
tbody td {
  padding: 4pt 7pt;
  border: 0.5pt solid #CCCCCC;
  vertical-align: top;
  line-height: 1.45;
}

/* ═══ RISK BADGES ══════════════════════════════════════════════════ */
.badge {
  display: inline-block;
  border-radius: 3pt;
  padding: 2pt 7pt;
  font-size: 7.5pt;
  font-weight: bold;
  color: white;
  white-space: nowrap;
}
.badge-low       { background: #27AE60; }
.badge-medium    { background: #E8A000; }
.badge-high      { background: #E67E22; }
.badge-very-high { background: #C0392B; }

.risk-num {
  display: inline-block;
  border-radius: 3pt;
  padding: 2pt 7pt;
  font-size: 8pt;
  font-weight: bold;
  color: white;
}
.risk-low       { background: #27AE60; }
.risk-medium    { background: #E8A000; }
.risk-high      { background: #E67E22; }
.risk-very-high { background: #C0392B; }

/* ═══ CALLOUT ══════════════════════════════════════════════════════ */
.callout {
  background: #FFF8E1;
  border-left: 4pt solid #E8A000;
  padding: 6pt 10pt;
  margin: 8pt 0;
  font-size: 9.5pt;
  break-inside: avoid;
  page-break-inside: avoid;
}

/* ═══ LAVORAZIONE BLOCKS ════════════════════════════════════════════ */
.lavorazione-block {
  border: 0.8pt solid #C8C8C8;
  margin: 12pt 0 16pt 0;
  break-inside: avoid;
  page-break-inside: avoid;
}
.lav-header {
  background: #5A5A5A;
  color: white;
  font-weight: bold;
  font-size: 10pt;
  padding: 6pt 10pt;
  break-after: avoid;
  page-break-after: avoid;
}
.lav-body {
  padding: 8pt 10pt 5pt 10pt;
}
.lav-body p          { margin-bottom: 4pt; }
.lav-body ul         { margin: 4pt 0 6pt 16pt; }
.lav-body ol         { margin: 4pt 0 6pt 18pt; }
.lav-body li         { margin-bottom: 3pt; }
.lav-body .bold-line { font-weight: bold; margin: 7pt 0 3pt 0; color: #3A3A3A; }
.lav-body table      { margin: 5pt 0 8pt 0; font-size: 8.5pt; }

/* ═══ EMERGENCY GRID ════════════════════════════════════════════════ */
.emergency-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7pt;
  margin: 8pt 0 14pt 0;
}
.emergency-card {
  background: #3A3A3A;
  color: white;
  text-align: center;
  padding: 8pt 6pt;
  border-radius: 3pt;
  break-inside: avoid;
  page-break-inside: avoid;
}
.emergency-number {
  font-size: 20pt;
  font-weight: bold;
  display: block;
}
.emergency-label {
  font-size: 7pt;
  color: #BBBBBB;
  margin-top: 2pt;
}

/* ═══ SIGNATURES ════════════════════════════════════════════════════ */
.signature-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8pt;
  margin: 8pt 0;
}
.signature-box {
  border: 0.5pt solid #CCCCCC;
  border-left: 3pt solid #3A3A3A;
  border-radius: 0 2pt 2pt 0;
  padding: 8pt 10pt;
  min-height: 48mm;
  break-inside: avoid;
  page-break-inside: avoid;
}
.sig-role  { font-weight: bold; font-size: 9.5pt; color: #3A3A3A; margin-bottom: 4pt; }
.sig-name  { font-size: 9pt; margin-bottom: 10pt; }
.sig-lines { display: flex; gap: 12pt; margin-top: 8pt; }
.sig-field { flex: 1; }
.sig-label { font-size: 7pt; color: #777777; margin-bottom: 2pt; }
.sig-line  { border-bottom: 0.5pt solid #AAAAAA; height: 14pt; }

/* ═══ TYPOGRAPHY ════════════════════════════════════════════════════ */
p            { margin-bottom: 5pt; line-height: 1.55; orphans: 3; widows: 3; }
ul, ol       { margin: 4pt 0 8pt 18pt; }
li           { margin-bottom: 3pt; }
strong       { font-weight: bold; }
.bold-line   { font-weight: bold; margin: 7pt 0 3pt 0; }
.muted       { color: #777777; font-size: 9pt; }
.placeholder { color: #D68910; font-weight: bold; font-style: italic; }
hr           { border: none; border-top: 0.5pt solid #E0E0E0; margin: 8pt 0; }
h1, h2, h3  { break-after: avoid; page-break-after: avoid; }
h1 { font-size: 14pt; margin: 12pt 0 6pt 0; }
h2 { font-size: 12pt; margin: 10pt 0 5pt 0; }
h3 { font-size: 10.5pt; margin: 8pt 0 4pt 0; }

/* ═══ PAGE BREAK UTILITIES ══════════════════════════════════════════ */
.page-break   { break-before: page; page-break-before: always; }
.no-break     { break-inside: avoid; page-break-inside: avoid; }
.keep-next    { break-after: avoid; page-break-after: avoid; }
`;
}

// ── MAIN BUILDER ──────────────────────────────────────────────────────────────
function generatePosHtml(posData, revision, aiRisks, signs = []) {
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
      <div class="cover-value">Rev. ${rev}</div>
    </div>
    <div class="cover-sidebar-item">
      <div class="cover-label">Data emissione</div>
      <div class="cover-value">${oggi}</div>
    </div>

    <div class="cover-sidebar-footer">
      Documento generato con Palladia<br>D.lgs 81/2008 e s.m.i.
    </div>
  </div>

  <div class="cover-main">
    <div>
      <div class="cover-title">Piano Operativo<br>di Sicurezza</div>
      <div class="cover-subtitle">ai sensi del D.lgs 81/2008 e s.m.i. — Allegato XV</div>
      <div class="cover-rev-badge">Revisione ${rev}</div>
      <div class="cover-divider"></div>

      <div class="cover-info-box">
        ${d.workType    ? `<div class="cover-info-row"><span class="cover-info-label">Natura dei lavori</span><span class="cover-info-val">${esc(d.workType)}</span></div>` : ''}
        ${d.client      ? `<div class="cover-info-row"><span class="cover-info-label">Committente</span><span class="cover-info-val">${esc(d.client)}</span></div>` : ''}
        ${siteName      ? `<div class="cover-info-row"><span class="cover-info-label">Cantiere</span><span class="cover-info-val">${esc(siteName)}</span></div>` : ''}
        ${(d.startDate || d.endDate) ? `<div class="cover-info-row"><span class="cover-info-label">Periodo</span><span class="cover-info-val">${esc(d.startDate || '')} – ${esc(d.endDate || '')}</span></div>` : ''}
        ${d.budget      ? `<div class="cover-info-row"><span class="cover-info-label">Importo lavori</span><span class="cover-info-val">€ ${esc(String(d.budget))}</span></div>` : ''}
        <div class="cover-info-row"><span class="cover-info-label">Impresa</span><span class="cover-info-val">${esc(d.companyName || '[DA COMPILARE]')}</span></div>
      </div>
    </div>

    <div>
      <div style="font-size:7pt; color:#777; text-transform:uppercase; letter-spacing:0.5pt; margin-bottom:5pt;">Firme del documento</div>
      <div class="cover-sig-row">
        <div class="cover-sig-box">
          <div class="cover-sig-label">Datore di lavoro</div>
          <div class="cover-sig-name">${esc(d.companyName || '...')}</div>
        </div>
        <div class="cover-sig-box">
          <div class="cover-sig-label">RSPP</div>
          <div class="cover-sig-name">${esc(d.rspp || '[DA COMPILARE]')}</div>
        </div>
        <div class="cover-sig-box">
          <div class="cover-sig-label">CSE (presa visione)</div>
          <div class="cover-sig-name">${esc(d.cse || '[DA COMPILARE]')}</div>
        </div>
      </div>
      <div class="cover-footer-note">
        Elaborato ai sensi del D.lgs 81/2008 art. 89 c.1 lett. h — Versione digitale generata con Palladia
      </div>
    </div>
  </div>
</div>`;

  // ── SEZ. 1 ────────────────────────────────────────────────────────────────
  const s1 = `
<div class="section-title">Sezione 1 — Intestazione e Dati Identificativi</div>
<p>Il presente Piano Operativo di Sicurezza (POS) viene redatto ai sensi dell'art. 89, comma 1, lettera h)
del D.lgs 81/2008 e s.m.i., come documento complementare al Piano di Sicurezza e Coordinamento (PSC),
ove previsto, e contiene le misure preventive e protettive specifiche dell'impresa esecutrice.</p>
<table class="no-break">
  <thead><tr><th>Campo</th><th>Valore</th></tr></thead>
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

  // ── SEZ. 2 ────────────────────────────────────────────────────────────────
  const s2 = `
<div class="section-title">Sezione 2 — Dati Generali del Lavoro</div>

<div class="sub-title">2.1 Descrizione dell'opera</div>
<table class="no-break">
  <thead><tr><th>Campo</th><th>Valore</th></tr></thead>
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
  <thead><tr><th style="width:5%">N.</th><th>Nominativo</th><th>Qualifica</th><th>Matricola</th></tr></thead>
  <tbody>${workerRows}</tbody>
</table>

<div class="sub-title">2.3 Orario di lavoro</div>
<ul>
  <li>Orario ordinario: 08:00 – 12:00 / 13:00 – 17:00</li>
  <li>Sabato: solo se autorizzato dal Coordinatore per l'Esecuzione</li>
  <li>Lavoro notturno: non previsto (salvo autorizzazione specifica)</li>
</ul>`;

  // ── SEZ. 3 ────────────────────────────────────────────────────────────────
  const s3 = `
<div class="section-title">Sezione 3 — Soggetti con Compiti di Sicurezza</div>

<div class="sub-title">3.1 Organigramma della sicurezza</div>
<table class="no-break">
  <thead><tr><th>Ruolo</th><th>Nominativo</th></tr></thead>
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
    <tr><td>Direttore Tecnico di Cantiere</td><td>${v(d.direttoreTecnico || d.responsabileLavori)}</td></tr>
    <tr><td>Preposto/i</td><td>${v(d.preposto)}</td></tr>
  </tbody>
</table>

<div class="sub-title">3.2 Compiti e responsabilità</div>
<p><strong>Datore di Lavoro:</strong> Responsabile dell'organizzazione della sicurezza in cantiere. Nomina le figure,
fornisce i DPI, assicura la formazione e l'informazione dei lavoratori (art. 17 D.lgs 81/2008).</p>
<p><strong>RSPP:</strong> Collabora nella valutazione dei rischi, elaborazione delle misure di prevenzione e protezione,
scelta dei DPI e organizzazione della formazione.</p>
<p><strong>RLS:</strong> Rappresenta i lavoratori per quanto riguarda la sicurezza. Ha accesso alla documentazione,
partecipa alle riunioni periodiche, può richiedere verifiche e sopralluoghi.</p>
<p><strong>Medico Competente:</strong> Effettua la sorveglianza sanitaria, esprime i giudizi di idoneità,
collabora alla valutazione dei rischi per gli aspetti sanitari.</p>
<p><strong>Preposto:</strong> Sorveglia le attività lavorative, verifica il rispetto delle procedure di sicurezza,
segnala tempestivamente le situazioni di pericolo al datore di lavoro (art. 19 D.lgs 81/2008).</p>`;

  // ── SEZ. 4 ────────────────────────────────────────────────────────────────
  const s4 = `
<div class="section-title">Sezione 4 — Area di Cantiere e Organizzazione</div>

<div class="sub-title">4.1 Caratteristiche dell'area e recinzione</div>
<p>L'area di cantiere sarà delimitata con recinzione perimetrale continua di altezza minima 2 metri,
realizzata con pannelli metallici modulari su basi in calcestruzzo. Gli accessi saranno controllati
e dotati di cancello chiudibile a chiave. Cartellonistica obbligatoria (vietato accesso ai non addetti)
sarà esposta su tutto il perimetro.</p>

<div class="sub-title">4.2 Viabilità di cantiere</div>
<ul>
  <li>Accesso carraio: tramite cancello principale con larghezza minima 4 m</li>
  <li>Accesso pedonale: separato da quello carraio, con percorso protetto</li>
  <li>Viabilità interna: percorsi distinti per mezzi e pedoni, segnalati con cartellonistica</li>
  <li>Velocità massima in cantiere: 10 km/h</li>
  <li>Senso unico di marcia dove le dimensioni non consentono il doppio senso</li>
</ul>

<div class="sub-title">4.3 Impianto elettrico di cantiere</div>
<ul>
  <li>Quadro generale di cantiere con interruttore differenziale Id = 30 mA</li>
  <li>Sottoquadri di zona con protezioni magnetotermiche e differenziali</li>
  <li>Impianto di messa a terra con verifica biennale (DPR 462/01)</li>
  <li>Cavi e prolunghe di tipo H07RN-F o equivalente (resistenti all'acqua e all'abrasione)</li>
</ul>

<div class="sub-title">4.4 Servizi igienico-assistenziali</div>
<ul>
  <li>Baraccamento spogliatoio con armadietti a doppio scomparto</li>
  <li>Servizi igienici chimici o allacciati alla rete fognaria (min. 1 ogni 10 lavoratori)</li>
  <li>Locale refettorio con tavoli, sedie, scaldavivande, frigorifero</li>
  <li>Cassetta di primo soccorso conforme al D.M. 388/2003 (Gruppo B)</li>
  <li>Acqua potabile disponibile in cantiere</li>
</ul>

<div class="sub-title">4.5 Depositi e stoccaggi</div>
<ul>
  <li>Area deposito materiali: superficie piana e stabile, materiali accatastati in modo sicuro</li>
  <li>Deposito sostanze pericolose: area dedicata, coperta, con bacino di contenimento</li>
  <li>Deposito rifiuti: area recintata con contenitori differenziati e cartellonistica conforme</li>
</ul>`;

  // ── SEZ. 5 ────────────────────────────────────────────────────────────────
  const s5 = `
<div class="section-title">Sezione 5 — Lavorazioni, Rischi e Misure di Prevenzione</div>
${buildLavorazioneHtml(aiRisks)}`;

  // ── SEZ. 6 ────────────────────────────────────────────────────────────────
  const s6 = `
<div class="section-title">Sezione 6 — Segnaletica di Sicurezza (ISO 7010)</div>
${buildSegnaleticaHtml(signs)}`;

  // ── SEZ. 7 ────────────────────────────────────────────────────────────────
  const s7 = `
<div class="section-title">Sezione 7 — Procedure di Emergenza</div>

<div class="sub-title">7.1 Numeri di emergenza</div>
<div class="emergency-grid">
  <div class="emergency-card"><span class="emergency-number">112</span><div class="emergency-label">Emergenza Unica Europea</div></div>
  <div class="emergency-card"><span class="emergency-number">115</span><div class="emergency-label">Vigili del Fuoco</div></div>
  <div class="emergency-card"><span class="emergency-number">118</span><div class="emergency-label">Emergenza Sanitaria</div></div>
  <div class="emergency-card"><span class="emergency-number">113</span><div class="emergency-label">Polizia di Stato</div></div>
  <div class="emergency-card"><span class="emergency-number">112</span><div class="emergency-label">Carabinieri</div></div>
  <div class="emergency-card" style="background:#555555;">
    <span class="emergency-number" style="font-size:13pt;">02 66101029</span>
    <div class="emergency-label">Centro Antiveleni — Milano</div>
  </div>
</div>

<table class="no-break">
  <thead><tr><th>Servizio</th><th>Numero</th></tr></thead>
  <tbody>
    <tr><td>Centro Antiveleni Roma</td><td>06 49978000</td></tr>
    <tr><td>INAIL (denuncia infortuni)</td><td>06 6001</td></tr>
    <tr><td>Addetto Primo Soccorso interno</td><td>${v(d.primoSoccorso)}</td></tr>
    <tr><td>Addetto Antincendio interno</td><td>${v(d.antincendio)}</td></tr>
    <tr><td>CSE</td><td>${v(d.cse)}</td></tr>
  </tbody>
</table>

<div class="sub-title">7.2 Procedura di emergenza incendio</div>
<ol style="margin-left:18pt;">
  <li>Chi rileva l'incendio avvisa immediatamente l'Addetto Antincendio e il Preposto</li>
  <li>Se di piccola entità: tentare lo spegnimento con gli estintori disponibili</li>
  <li>Se non controllabile: attivare l'allarme e chiamare il 115</li>
  <li>Evacuare l'area seguendo le vie di fuga predisposte</li>
  <li>Raggiungere il punto di raccolta prestabilito</li>
  <li>Effettuare l'appello nominativo dei lavoratori</li>
  <li>Attendere i Vigili del Fuoco e fornire indicazioni precise sulla situazione</li>
  <li>Non rientrare nell'area fino all'autorizzazione delle autorità</li>
</ol>

<div class="sub-title">7.3 Procedura di primo soccorso</div>
<ol style="margin-left:18pt;">
  <li>Chi rileva l'infortunio avvisa immediatamente l'Addetto Primo Soccorso</li>
  <li>Valutare la scena (sicurezza dell'area, rischi residui)</li>
  <li>Valutare lo stato dell'infortunato (coscienza, respiro, circolo)</li>
  <li>Chiamare il 118: luogo esatto, numero infortunati, dinamica, condizioni</li>
  <li>Prestare i primi soccorsi nei limiti delle proprie competenze</li>
  <li>Non spostare l'infortunato salvo pericolo imminente</li>
  <li>Attendere i soccorsi mantenendo il contatto telefonico con il 118</li>
  <li>Compilare il registro infortuni e la denuncia INAIL entro 48 ore</li>
</ol>

<div class="sub-title">7.4 Punto di raccolta</div>
<p>Il punto di raccolta è individuato in area esterna al cantiere, facilmente raggiungibile e segnalato
con cartello E007 (Punto di raccolta). La sua posizione è comunicata a tutti i lavoratori all'ingresso
in cantiere e riportata nella planimetria allegata.</p>`;

  // ── SEZ. 8 ────────────────────────────────────────────────────────────────
  const s8 = `
<div class="section-title">Sezione 8 — Dispositivi di Protezione Individuale (DPI)</div>

<div class="sub-title">8.1 Obblighi generali — Reg. UE 2016/425</div>
<p>Il Datore di Lavoro fornisce ai lavoratori i DPI necessari, conformi al Reg. UE 2016/425, adeguati
ai rischi specifici e mantenuti in buono stato. I lavoratori hanno l'obbligo di utilizzarli correttamente
e segnalare difetti o malfunzionamenti. La consegna è documentata con registro firmato.</p>

<div class="sub-title">8.2 DPI di base obbligatori in cantiere</div>
<table class="allow-break">
  <thead><tr><th>DPI</th><th>Norma di riferimento</th><th>Cat.</th><th>Note</th></tr></thead>
  <tbody>
    <tr><td>Casco di protezione</td><td>UNI EN 397:2012</td><td>II</td><td>Obbligatorio in tutta l'area cantiere</td></tr>
    <tr><td>Calzature di sicurezza S3</td><td>UNI EN ISO 20345:2022</td><td>II</td><td>Puntale 200J, suola antiperforazione</td></tr>
    <tr><td>Guanti da lavoro</td><td>UNI EN 388:2016</td><td>II</td><td>Resistenza a taglio, abrasione, perforazione</td></tr>
    <tr><td>Giubbotto alta visibilità</td><td>UNI EN ISO 20471:2013</td><td>II</td><td>Classe 2 minimo — zone transito mezzi</td></tr>
    <tr><td>Occhiali di protezione</td><td>UNI EN 166:2001</td><td>II</td><td>Lavorazioni con proiezione schegge/polveri</td></tr>
  </tbody>
</table>

<div class="sub-title">8.3 DPI specifici per lavorazioni a rischio</div>
<table class="allow-break">
  <thead><tr><th>DPI</th><th>Norma di riferimento</th><th>Impiego specifico</th></tr></thead>
  <tbody>
    <tr><td>Imbracatura anticaduta</td><td>UNI EN 361:2002</td><td>Lavori in quota &gt;2 m senza protezioni collettive</td></tr>
    <tr><td>Cordino con assorbitore energia</td><td>UNI EN 355:2002</td><td>In abbinamento all'imbracatura anticaduta</td></tr>
    <tr><td>Cuffie/inserti auricolari</td><td>UNI EN 352-1/2:2020</td><td>Esposizione rumore &gt;85 dB(A)</td></tr>
    <tr><td>Facciale filtrante FFP2/FFP3</td><td>UNI EN 149:2009</td><td>Polveri, fibre, aerosol</td></tr>
    <tr><td>Maschera con filtri</td><td>UNI EN 14387:2004</td><td>Vapori organici e gas</td></tr>
    <tr><td>Guanti antitaglio</td><td>UNI EN 388:2016 (Lv.E)</td><td>Taglio lamiere, vetro, materiali affilati</td></tr>
    <tr><td>Guanti anticalore</td><td>UNI EN 407:2020</td><td>Saldatura, taglio termico, superfici calde</td></tr>
    <tr><td>Tuta monouso tipo 5/6</td><td>UNI EN 13034:2005</td><td>Manipolazione sostanze chimiche</td></tr>
  </tbody>
</table>`;

  // ── SEZ. 9 ────────────────────────────────────────────────────────────────
  const s9 = `
<div class="section-title">Sezione 9 — Macchine, Attrezzature e Verifiche</div>

<div class="sub-title">9.1 Disposizioni generali</div>
<p>Tutte le macchine e attrezzature devono essere conformi alle direttive europee applicabili (Direttiva
Macchine 2006/42/CE), dotate di marcatura CE e dichiarazione di conformità. Devono essere usate secondo
le istruzioni del fabbricante e mantenute in piena efficienza con documentazione aggiornata.</p>

<div class="sub-title">9.2 Verifiche obbligatorie — All. VII D.lgs 81/2008</div>
<table class="allow-break">
  <thead><tr><th>Attrezzatura</th><th>Tipo di verifica</th><th>Frequenza</th><th>Riferimento normativo</th></tr></thead>
  <tbody>
    <tr><td>Gru a torre</td><td>Prima verifica + periodica</td><td>Biennale</td><td>All. VII D.lgs 81/08</td></tr>
    <tr><td>Gru su autocarro</td><td>Prima verifica + periodica</td><td>Annuale</td><td>All. VII D.lgs 81/08</td></tr>
    <tr><td>Piattaforme elevabili (PLE)</td><td>Prima verifica + periodica</td><td>Annuale</td><td>All. VII D.lgs 81/08</td></tr>
    <tr><td>Ponteggi metallici</td><td>Verifica prima del montaggio</td><td>Ad ogni montaggio</td><td>Art. 137 D.lgs 81/08</td></tr>
    <tr><td>Scale portatili</td><td>Controllo visivo</td><td>Giornaliero</td><td>UNI EN 131</td></tr>
    <tr><td>Impianto elettrico di cantiere</td><td>Verifica impianto di terra</td><td>Biennale</td><td>DPR 462/01</td></tr>
    <tr><td>Funi e catene di sollevamento</td><td>Controllo periodico</td><td>Trimestrale</td><td>Art. 71 D.lgs 81/08</td></tr>
    <tr><td>Apparecchi a pressione</td><td>Verifica periodica</td><td>Secondo tabella All. VII</td><td>All. VII D.lgs 81/08</td></tr>
  </tbody>
</table>

<div class="sub-title">9.3 Abilitazioni operatori — Acc. Stato-Regioni 22/02/2012</div>
<table class="allow-break">
  <thead><tr><th>Attrezzatura</th><th>Abilitazione richiesta</th><th>Riferimento</th></tr></thead>
  <tbody>
    <tr><td>Gru a torre e su autocarro</td><td>Patentino gruista</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Piattaforme elevabili (PLE)</td><td>Patentino PLE</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Escavatori (&gt;6 t)</td><td>Patentino escavatorista</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Carrello elevatore</td><td>Patentino carrellista</td><td>Acc. Stato-Regioni 22/02/2012</td></tr>
    <tr><td>Autobetoniera</td><td>Patente C + CQC</td><td>Codice della Strada</td></tr>
  </tbody>
</table>`;

  // ── SEZ. 10 ───────────────────────────────────────────────────────────────
  const s10 = `
<div class="section-title">Sezione 10 — Sostanze e Preparati Pericolosi</div>

<div class="sub-title">10.1 Obblighi — Regolamento REACH e Reg. CLP</div>
<p>Per ogni sostanza pericolosa è obbligatorio: disporre della SDS (Scheda Dati di Sicurezza) aggiornata
in 16 sezioni, conservarla accessibile a tutti i lavoratori, formare il personale sui rischi e le misure
protettive, stoccare le sostanze in area dedicata con bacino di contenimento.</p>

<div class="sub-title">10.2 Sostanze comuni in cantiere</div>
<table class="allow-break">
  <thead><tr><th>Sostanza</th><th>Classificazione CLP</th><th>Rischi principali</th><th>DPI richiesti</th></tr></thead>
  <tbody>
    <tr><td>Cemento / calcestruzzo</td><td>H315, H317, H318</td><td>Irritazione cutanea, sensibilizzazione, lesioni oculari</td><td>Guanti, occhiali, mascherina</td></tr>
    <tr><td>Vernici e solventi</td><td>H225, H304, H336</td><td>Infiammabile, tossicità per inalazione</td><td>Maschera filtri A, guanti chimici</td></tr>
    <tr><td>Resine epossidiche</td><td>H315, H317, H319</td><td>Sensibilizzazione cutanea e oculare</td><td>Guanti nitrile, occhiali</td></tr>
    <tr><td>Gasolio per macchine</td><td>H226, H304, H332</td><td>Infiammabile, nocivo per inalazione</td><td>Guanti, maschera se vapori</td></tr>
    <tr><td>Amianto (se presente)</td><td>H350 (Cancerogeno)</td><td>Cancerogeno — gestione speciale</td><td>Piano specifico art. 256 D.lgs 81/08</td></tr>
  </tbody>
</table>`;

  // ── SEZ. 11 ───────────────────────────────────────────────────────────────
  const s11 = `
<div class="section-title">Sezione 11 — Gestione Rifiuti</div>

<div class="sub-title">11.1 Normativa — D.lgs 152/2006 (TUA) e s.m.i.</div>
<p>La gestione dei rifiuti è effettuata nel rispetto del D.lgs 152/2006. L'impresa è iscritta all'Albo
Nazionale Gestori Ambientali per le categorie pertinenti. Il deposito temporaneo è effettuato nel
rispetto delle condizioni di cui all'art. 183 co. 1 lett. bb) TUA.</p>

<div class="sub-title">11.2 Codici CER dei rifiuti tipici di cantiere</div>
<table class="allow-break">
  <thead><tr><th>Codice CER</th><th>Descrizione</th><th>Tipo</th><th>Gestione</th></tr></thead>
  <tbody>
    <tr><td>17 01 01</td><td>Cemento</td><td>Non pericoloso</td><td>Recupero / discarica</td></tr>
    <tr><td>17 01 02</td><td>Mattoni</td><td>Non pericoloso</td><td>Recupero / discarica</td></tr>
    <tr><td>17 02 01</td><td>Legno</td><td>Non pericoloso</td><td>Recupero</td></tr>
    <tr><td>17 02 02</td><td>Vetro</td><td>Non pericoloso</td><td>Recupero</td></tr>
    <tr><td>17 04 05</td><td>Ferro e acciaio</td><td>Non pericoloso</td><td>Recupero</td></tr>
    <tr><td>17 09 04</td><td>Rifiuti misti costruzione/demolizione</td><td>Non pericoloso</td><td>Recupero / discarica</td></tr>
    <tr><td>17 06 01*</td><td>Materiali isolanti con amianto</td><td><strong>Pericoloso</strong></td><td>Ditta specializzata autorizzata</td></tr>
    <tr><td>08 01 11*</td><td>Pitture/vernici con solventi organici</td><td><strong>Pericoloso</strong></td><td>Impianto autorizzato</td></tr>
    <tr><td>13 02 08*</td><td>Oli esausti</td><td><strong>Pericoloso</strong></td><td>Consorzio CONOU</td></tr>
  </tbody>
</table>`;

  // ── SEZ. 12 ───────────────────────────────────────────────────────────────
  const s12 = `
<div class="section-title">Sezione 12 — Formazione e Informazione dei Lavoratori</div>

<div class="sub-title">12.1 Formazione obbligatoria — Acc. Stato-Regioni 21/12/2011</div>
<table class="allow-break">
  <thead><tr><th>Tipo di formazione</th><th>Durata</th><th>Aggiornamento</th><th>Note</th></tr></thead>
  <tbody>
    <tr><td>Formazione generale</td><td>4 ore</td><td>—</td><td>Valida per sempre</td></tr>
    <tr><td>Formazione specifica (rischio alto — edilizia)</td><td>12 ore</td><td>6 ore ogni 5 anni</td><td>Obbligatoria per cantieri</td></tr>
    <tr><td>Preposto</td><td>+8 ore aggiuntive</td><td>6 ore ogni 2 anni</td><td>Per chi svolge funzioni di preposto</td></tr>
    <tr><td>Primo Soccorso (Gruppo B)</td><td>12 ore</td><td>4 ore ogni 3 anni</td><td>Per gli addetti designati</td></tr>
    <tr><td>Antincendio (rischio medio)</td><td>8 ore</td><td>5 ore ogni 5 anni</td><td>Per gli addetti designati</td></tr>
    <tr><td>RLS</td><td>32 ore</td><td>4 ore/anno</td><td>Rappresentante Lavoratori Sicurezza</td></tr>
    <tr><td>Ponteggi PIMUS</td><td>28 ore</td><td>4 ore ogni 4 anni</td><td>Montaggio/smontaggio ponteggi</td></tr>
    <tr><td>Lavori in quota</td><td>4–8 ore</td><td>Secondo tipologia</td><td>Per chi opera oltre 2 m di altezza</td></tr>
  </tbody>
</table>

<div class="sub-title">12.2 Informazione all'ingresso in cantiere</div>
<p>All'ingresso in cantiere, ogni lavoratore riceve informazione su: rischi specifici, misure preventive,
procedure di emergenza, nominativi delle figure di sicurezza, ubicazione presidi di primo soccorso,
estintori e punto di raccolta. L'avvenuta informazione è documentata con firma su apposito registro.</p>`;

  // ── SEZ. 13 ───────────────────────────────────────────────────────────────
  const s13 = `
<div class="section-title">Sezione 13 — Sorveglianza Sanitaria</div>

<div class="sub-title">13.1 Protocollo sanitario</div>
<p>Il Medico Competente (${v(d.medico)}) definisce il protocollo sanitario in base ai rischi specifici.
La sorveglianza comprende visita preventiva, periodica, su richiesta del lavoratore, alla cessazione
(per rischi specifici) e al rientro da assenza &gt;60 giorni per malattia.</p>

<div class="sub-title">13.2 Accertamenti tipici per lavoratori edili</div>
<table class="allow-break">
  <thead><tr><th>Rischio</th><th>Accertamento sanitario</th><th>Periodicità</th></tr></thead>
  <tbody>
    <tr><td>Movimentazione manuale carichi</td><td>Visita medica + rachide</td><td>Annuale</td></tr>
    <tr><td>Rumore &gt;85 dB(A)</td><td>Audiometria tonale</td><td>Annuale</td></tr>
    <tr><td>Vibrazioni mano-braccio</td><td>Visita + arti superiori</td><td>Biennale</td></tr>
    <tr><td>Polveri (silice, cemento)</td><td>Spirometria + Rx torace</td><td>Annuale / biennale</td></tr>
    <tr><td>Sostanze chimiche</td><td>Esami ematochimici specifici</td><td>Secondo SDS</td></tr>
    <tr><td>Lavoro in quota</td><td>Visita + idoneità specifica</td><td>Annuale</td></tr>
  </tbody>
</table>`;

  // ── SEZ. 14 ───────────────────────────────────────────────────────────────
  const s14 = `
<div class="section-title page-break">Sezione 14 — Firme e Presa Visione</div>
<p>Il presente Piano Operativo di Sicurezza è stato redatto ai sensi del D.lgs 81/2008 e s.m.i. e viene
sottoscritto per accettazione e presa visione dalle seguenti figure responsabili:</p>

<div class="signature-grid">
  <div class="signature-box">
    <div class="sig-role">Datore di Lavoro dell'impresa esecutrice</div>
    <div class="sig-name">${v(d.companyName)}</div>
    <div class="sig-lines">
      <div class="sig-field"><div class="sig-label">Firma</div><div class="sig-line"></div></div>
      <div class="sig-field"><div class="sig-label">Data</div><div class="sig-line"></div></div>
    </div>
  </div>
  <div class="signature-box">
    <div class="sig-role">RSPP</div>
    <div class="sig-name">${v(d.rspp)}</div>
    <div class="sig-lines">
      <div class="sig-field"><div class="sig-label">Firma</div><div class="sig-line"></div></div>
      <div class="sig-field"><div class="sig-label">Data</div><div class="sig-line"></div></div>
    </div>
  </div>
  <div class="signature-box">
    <div class="sig-role">RLS</div>
    <div class="sig-name">${v(d.rls)}</div>
    <div class="sig-lines">
      <div class="sig-field"><div class="sig-label">Firma</div><div class="sig-line"></div></div>
      <div class="sig-field"><div class="sig-label">Data</div><div class="sig-line"></div></div>
    </div>
  </div>
  <div class="signature-box">
    <div class="sig-role">Medico Competente</div>
    <div class="sig-name">${v(d.medico)}</div>
    <div class="sig-lines">
      <div class="sig-field"><div class="sig-label">Firma</div><div class="sig-line"></div></div>
      <div class="sig-field"><div class="sig-label">Data</div><div class="sig-line"></div></div>
    </div>
  </div>
</div>

<div class="signature-box" style="margin: 8pt 0 14pt 0;">
  <div class="sig-role">CSE — Coordinatore per la Sicurezza in fase di Esecuzione (per presa visione)</div>
  <div class="sig-name">${v(d.cse)}</div>
  <div class="sig-lines">
    <div class="sig-field"><div class="sig-label">Firma</div><div class="sig-line"></div></div>
    <div class="sig-field"><div class="sig-label">Data</div><div class="sig-line"></div></div>
  </div>
</div>

<div class="sub-title">Dichiarazione presa visione dei lavoratori</div>
<p>I sottoscritti lavoratori dichiarano di aver ricevuto copia del presente POS, di averne compreso
il contenuto e di impegnarsi al rispetto delle disposizioni in esso contenute.</p>
<table class="allow-break">
  <thead><tr><th style="width:5%">N.</th><th>Nominativo</th><th>Data</th><th>Firma</th></tr></thead>
  <tbody>${workerDeclRows}</tbody>
</table>

<hr>
<p class="muted" style="text-align:center; margin-top:10pt; font-size:8pt;">
  Documento generato con Palladia — ai sensi del D.lgs 81/2008 e s.m.i. — ${oggi} — Revisione ${rev}
</p>`;

  // ── ASSEMBLE ───────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>${esc(docTitle)}</title>
  <style>${buildCss()}</style>
</head>
<body>
${cover}
<div class="content">
${s1}
${s2}
${s3}
${s4}
${s5}
${s6}
${s7}
${s8}
${s9}
${s10}
${s11}
${s12}
${s13}
${s14}
</div>
</body>
</html>`;
}

module.exports = { generatePosHtml };
