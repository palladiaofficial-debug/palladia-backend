'use strict';

/**
 * PIMUS HTML Generator — v1
 * Piano di Montaggio, Uso e Smontaggio dei Ponteggi (D.Lgs 81/2008 Art. 136, Allegato XXII)
 * Pattern identico a dvr-html-generator.js — margini e CSS invariati.
 */

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function v(val) {
  return (val && val !== 'N/A') ? esc(val) : '<span class="placeholder">[DA COMPILARE]</span>';
}
function vOpt(val) {
  return val ? esc(val) : '<span style="color:#AAAAAA;font-style:italic;">—</span>';
}
function boldify(text) {
  if (!text) return '';
  return esc(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
}
function formatDate(val) {
  if (!val) return null;
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(val);
}

// ── Markdown → HTML (stesso parser del DVR) ───────────────────────────────────
function isTableRow(line)  { return line.trim().startsWith('|') && line.trim().endsWith('|'); }
function isSepRow(line)    { return /^\|[\s\-:|]+\|$/.test(line.trim()); }

function parseTable(rows) {
  const valid = rows.filter(r => !isSepRow(r));
  if (valid.length === 0) return '';
  const headers = valid[0].split('|').slice(1,-1).map(c => c.trim());
  let html = '<table class="allow-break"><thead><tr>';
  headers.forEach(h => { html += `<th>${boldify(h)}</th>`; });
  html += '</tr></thead><tbody>';
  valid.slice(1).forEach(row => {
    const cells = row.split('|').slice(1,-1).map(c => c.trim());
    html += '<tr>';
    cells.forEach(cell => { html += `<td>${boldify(cell)}</td>`; });
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

function markdownToHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line)) {
      const tableLines = [];
      while (i < lines.length && isTableRow(lines[i])) { tableLines.push(lines[i]); i++; }
      html += parseTable(tableLines);
      continue;
    }
    if (/^### /.test(line))      { html += `<h4>${boldify(line.slice(4).trim())}</h4>`; i++; continue; }
    if (/^## /.test(line))       { html += `<h3>${boldify(line.slice(3).trim())}</h3>`; i++; continue; }
    if (/^# /.test(line))        { html += `<h2>${boldify(line.slice(2).trim())}</h2>`; i++; continue; }
    if (/^\*\*\*\*/.test(line))  { html += `<hr/>`; i++; continue; }
    if (/^---/.test(line.trim())) { html += `<hr/>`; i++; continue; }
    if (/^- /.test(line))        { html += `<li>${boldify(line.slice(2).trim())}</li>`; i++; continue; }
    if (/^\d+\. /.test(line))    { html += `<li class="ordered">${boldify(line.replace(/^\d+\. /,'').trim())}</li>`; i++; continue; }
    if (line.trim() === '')      { html += '<br/>'; i++; continue; }
    html += `<p>${boldify(line)}</p>`;
    i++;
  }
  return html;
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function buildCss() {
  return `
  /* ─── Reset & base ─────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; min-width: 0; word-break: break-word; overflow-wrap: break-word; }
  @page { size: A4; margin: 26mm 0 24mm 0; }
  html, body { font-family: Arial, Helvetica, sans-serif;
    font-size: 9pt; color: #1a1a1a; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc { padding: 0 16mm; }

  /* ─── Cover ────────────────────────────── */
  .cover {
    height: 247mm; overflow: hidden;
    background: linear-gradient(150deg, #0f1923 0%, #1a2840 60%, #0f1923 100%);
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 24mm 16mm 16mm;
    break-after: page;
  }
  .cover-badge {
    display: inline-block; padding: 3pt 9pt;
    border: 0.75pt solid rgba(59,130,246,0.4); border-radius: 15pt;
    background: rgba(59,130,246,0.1);
    color: #93c5fd; font-size: 8pt; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 15pt;
  }
  .cover h1 {
    font-size: 28pt; font-weight: 900; color: #fff;
    letter-spacing: -0.02em; line-height: 1.15; margin-bottom: 4.5pt;
  }
  .cover h2 { font-size: 14pt; color: #93c5fd; font-weight: 600; margin-bottom: 18pt; }
  .cover-divider { width: 36pt; height: 2.25pt; background: #3b82f6; border-radius: 1.5pt; margin-bottom: 18pt; }
  .cover-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 9pt 24pt; margin-bottom: 21pt; }
  .cover-meta-item { }
  .cover-meta-label { font-size: 7pt; color: #64748b; text-transform: uppercase;
    letter-spacing: 0.1em; font-weight: 700; margin-bottom: 1.5pt; }
  .cover-meta-value { font-size: 9pt; color: #e2e8f0; font-weight: 600; }
  .cover-footer { border-top: 0.75pt solid rgba(255,255,255,0.1); padding-top: 10.5pt;
    display: flex; justify-content: space-between; align-items: center; }
  .cover-footer-text { font-size: 7.5pt; color: #64748b; }
  .cover-norm { font-size: 7pt; color: #3b82f6; font-weight: 600; letter-spacing: 0.05em; }

  /* ─── Sections ──────────────────────────── */
  .section { margin-bottom: 18pt; }
  .section-title {
    font-size: 10pt; font-weight: 800; color: #1e3a5f;
    text-transform: uppercase; letter-spacing: 0.06em;
    border-left: 2.25pt solid #3b82f6; padding: 3pt 0 3pt 7.5pt;
    margin: 14pt 0 9pt 0;
    break-after: avoid; page-break-after: avoid;
  }
  .section-title:first-child { margin-top: 6pt; }
  .section-num {
    display: inline-block; background: #3b82f6; color: #fff;
    font-size: 7pt; font-weight: 800; padding: 0.75pt 4.5pt;
    border-radius: 2.25pt; margin-right: 6pt;
  }

  /* ─── Data grid ─────────────────────────── */
  .data-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6pt 15pt; margin-bottom: 9pt; }
  .data-grid-3 { grid-template-columns: 1fr 1fr 1fr; }
  .data-item { border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 4.5pt; }
  .data-label { font-size: 7pt; color: #64748b; text-transform: uppercase;
    letter-spacing: 0.06em; font-weight: 700; margin-bottom: 1.5pt; }
  .data-value { font-size: 9pt; color: #1a1a1a; font-weight: 500; }

  /* ─── Tables ────────────────────────────── */
  table { width: 100%; border-collapse: collapse; margin: 6pt 0 9pt; font-size: 8pt;
    table-layout: fixed; }
  th { background: #1e3a5f; color: #fff; padding: 4pt 6pt; text-align: left;
    font-size: 7.5pt; font-weight: 700; letter-spacing: 0.04em;
    overflow-wrap: anywhere; word-break: break-word; }
  td { padding: 4pt 6pt; border-bottom: 0.75pt solid #e2e8f0; vertical-align: top;
    overflow-wrap: anywhere; word-break: break-word; }
  tr:nth-child(even) td { background: #f8fafc; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  table.allow-break tr { break-inside: auto !important; page-break-inside: auto !important; }
  thead { display: table-header-group; }

  /* ─── AI content ────────────────────────── */
  .ai-content h2 { font-size: 11pt; font-weight: 800; color: #1e3a5f;
    margin: 12pt 0 4.5pt; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 3pt;
    break-after: avoid; page-break-after: avoid; }
  .ai-content h3 { font-size: 10pt; font-weight: 700; color: #1e3a5f;
    margin: 9pt 0 4.5pt; break-after: avoid; page-break-after: avoid; }
  .ai-content h4 { font-size: 9pt; font-weight: 700; color: #374151;
    margin: 7.5pt 0 3pt; break-after: avoid; page-break-after: avoid; }
  .ai-content p  { margin: 3pt 0; line-height: 1.6; }
  .ai-content ul, .ai-content ol { margin: 3pt 0 6pt 15pt; }
  .ai-content li { margin: 1.5pt 0; line-height: 1.6; list-style: disc; }
  .ai-content li.ordered { list-style: decimal; }
  .ai-content hr { border: none; border-top: 0.75pt solid #e2e8f0; margin: 7.5pt 0; }

  /* ─── Addetti table ─────────────────────── */
  .addetti-table th, .addetti-table td { padding: 4.5pt 7.5pt; }

  /* ─── Signature area ────────────────────── */
  .sign-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12pt; margin-top: 18pt; }
  .sign-box { border: 0.75pt solid #e2e8f0; border-radius: 4.5pt; padding: 9pt; break-inside: avoid; }
  .sign-label { font-size: 7.5pt; color: #64748b; text-transform: uppercase;
    letter-spacing: 0.05em; font-weight: 700; margin-bottom: 3pt; }
  .sign-name  { font-size: 9pt; font-weight: 600; color: #1a1a1a; margin-bottom: 18pt; }
  .sign-line  { border-top: 0.75pt solid #1a1a1a; padding-top: 3pt;
    font-size: 7pt; color: #9ca3af; }

  /* ─── Misc ──────────────────────────────── */
  .placeholder { color: #e02020; font-style: italic; }
  .info-box { background: #eff6ff; border: 0.75pt solid #bfdbfe; border-radius: 4.5pt;
    padding: 7.5pt 10.5pt; margin-bottom: 9pt; font-size: 8pt; color: #1e40af; break-inside: avoid; }
  .warning-box { background: #fffbeb; border: 0.75pt solid #fde68a; border-radius: 4.5pt;
    padding: 7.5pt 10.5pt; margin-bottom: 9pt; font-size: 8pt; color: #92400e; break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  `;
}

// ── Cover page ────────────────────────────────────────────────────────────────
function buildCover(d, revision) {
  const dataDoc  = formatDate(d.dataDocumento) || new Date().toLocaleDateString('it-IT');
  const dataMont = formatDate(d.dataInizioMontaggio) || '<span class="placeholder">[DATA]</span>';

  return `
<div class="cover">
  <div>
    <div class="cover-badge">D.Lgs 81/2008 · Art. 136 · Allegato XXII</div>
    <h1>PIMUS</h1>
    <h2>Piano di Montaggio, Uso<br/>e Smontaggio Ponteggi</h2>
    <div class="cover-divider"></div>
    <div class="cover-meta">
      <div class="cover-meta-item">
        <div class="cover-meta-label">Impresa installatrice</div>
        <div class="cover-meta-value">${v(d.ragioneSociale)}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Cantiere</div>
        <div class="cover-meta-value">${v(d.nomeCantiere || d.indirizzoCantiere)}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Tipo ponteggio</div>
        <div class="cover-meta-value">${v(d.tipoPonteggio)}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Data inizio montaggio</div>
        <div class="cover-meta-value">${dataMont}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Altezza max</div>
        <div class="cover-meta-value">${v(d.altezzaMax)} m</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Revisione</div>
        <div class="cover-meta-value">Rev. ${revision}</div>
      </div>
    </div>
  </div>
  <div class="cover-footer">
    <div class="cover-footer-text">
      Documento redatto in conformità al D.Lgs. 81/2008, Art. 136 e Allegato XXII<br/>
      Data documento: ${dataDoc}
    </div>
    <div class="cover-norm">PALLADIA · Sicurezza sul Lavoro</div>
  </div>
</div>`;
}

// ── Sezione 1: Anagrafica ────────────────────────────────────────────────────
function buildAnagrafica(d) {
  return `
<div class="section">
  <div class="section-title"><span class="section-num">1</span>Anagrafica Aziendale e Cantiere</div>
  <div class="data-grid">
    <div class="data-item"><div class="data-label">Ragione Sociale</div><div class="data-value">${v(d.ragioneSociale)}</div></div>
    <div class="data-item"><div class="data-label">P.IVA / C.F.</div><div class="data-value">${v(d.partitaIva)}</div></div>
    <div class="data-item"><div class="data-label">Datore di Lavoro</div><div class="data-value">${v(d.datoreLavoro)}</div></div>
    <div class="data-item"><div class="data-label">RSPP / Preposto</div><div class="data-value">${v(d.preposto)}</div></div>
    <div class="data-item"><div class="data-label">Cantiere / Committente</div><div class="data-value">${v(d.nomeCantiere)}</div></div>
    <div class="data-item"><div class="data-label">Indirizzo cantiere</div><div class="data-value">${v(d.indirizzoCantiere)}</div></div>
  </div>
</div>`;
}

// ── Sezione 2: Dati Ponteggio ────────────────────────────────────────────────
function buildDatiPonteggio(d) {
  const superf = (d.lunghezzaTotale && d.altezzaMax)
    ? `${(parseFloat(d.lunghezzaTotale) * parseFloat(d.altezzaMax)).toFixed(1)} m²`
    : v(d.superficieTotale);

  return `
<div class="section">
  <div class="section-title"><span class="section-num">2</span>Dati Tecnici del Ponteggio</div>
  <div class="data-grid data-grid-3">
    <div class="data-item"><div class="data-label">Tipo ponteggio</div><div class="data-value">${v(d.tipoPonteggio)}</div></div>
    <div class="data-item"><div class="data-label">Marca / Modello</div><div class="data-value">${v(d.marcaModello)}</div></div>
    <div class="data-item"><div class="data-label">Aut. Ministeriale N°</div><div class="data-value">${v(d.autorizzazioneMin)}</div></div>
    <div class="data-item"><div class="data-label">Altezza max (m)</div><div class="data-value">${v(d.altezzaMax)}</div></div>
    <div class="data-item"><div class="data-label">Lunghezza totale (m)</div><div class="data-value">${v(d.lunghezzaTotale)}</div></div>
    <div class="data-item"><div class="data-label">N° piani di lavoro</div><div class="data-value">${v(d.numPiani)}</div></div>
    <div class="data-item"><div class="data-label">Superficie totale</div><div class="data-value">${superf}</div></div>
    <div class="data-item"><div class="data-label">Carico previsto (kg/m²)</div><div class="data-value">${v(d.caricoPrevisto) || '200'}</div></div>
    <div class="data-item"><div class="data-label">Destinazione d'uso</div><div class="data-value">${v(d.destinazione)}</div></div>
  </div>
  ${d.noteStrutturali ? `<div class="info-box"><strong>Note strutturali:</strong> ${esc(d.noteStrutturali)}</div>` : ''}
</div>`;
}

// ── Sezione 3: Addetti al montaggio ──────────────────────────────────────────
function buildAddetti(d) {
  const addetti = Array.isArray(d.addetti) ? d.addetti : [];
  if (addetti.length === 0) return '';
  const rows = addetti.map(a =>
    `<tr><td>${esc(a.nome || a.name || '')}</td><td>${esc(a.qualifica || '')}</td><td>${esc(a.formazione || 'Corso ponteggi (lav. quota)')}</td></tr>`
  ).join('');
  return `
<div class="section">
  <div class="section-title"><span class="section-num">3</span>Lavoratori Addetti al Ponteggio</div>
  <table class="addetti-table allow-break">
    <thead><tr>
      <th style="width:35%">Nominativo</th>
      <th style="width:30%">Qualifica</th>
      <th style="width:35%">Formazione specifica</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ── Sezione 4+: Contenuto AI ──────────────────────────────────────────────────
function buildAiContent(content, startSection) {
  if (!content) return '';
  return `
<div class="section">
  <div class="section-title"><span class="section-num">${startSection}</span>Procedure, DPI e Misure di Sicurezza</div>
  <div class="ai-content">${markdownToHtml(content)}</div>
</div>`;
}

// ── Sezione firme ─────────────────────────────────────────────────────────────
function buildFirme(d) {
  return `
<div class="section">
  <div class="section-title"><span class="section-num">5</span>Approvazione e Firme</div>
  <div class="warning-box">
    Il presente PIMUS è stato redatto in conformità all'Art. 136 e all'Allegato XXII del D.Lgs. 81/2008.
    Le procedure di montaggio, uso e smontaggio devono essere seguite scrupolosamente.
    Il Preposto è tenuto a vigilare sull'applicazione delle presenti disposizioni.
  </div>
  <div class="sign-grid">
    <div class="sign-box">
      <div class="sign-label">Datore di Lavoro</div>
      <div class="sign-name">${v(d.datoreLavoro)}</div>
      <div class="sign-line">Firma e data</div>
    </div>
    <div class="sign-box">
      <div class="sign-label">RSPP / Preposto</div>
      <div class="sign-name">${v(d.preposto)}</div>
      <div class="sign-line">Firma e data</div>
    </div>
    <div class="sign-box">
      <div class="sign-label">Capo Squadra montaggio</div>
      <div class="sign-name">${vOpt(d.capoSquadra)}</div>
      <div class="sign-line">Firma e data</div>
    </div>
  </div>
</div>`;
}

// ── Main export ───────────────────────────────────────────────────────────────
function generatePimusHtml(pimusData, revision, aiContent) {
  const d = pimusData || {};

  const body = `
${buildCover(d, revision)}
<div class="doc">
${buildAnagrafica(d)}
${buildDatiPonteggio(d)}
${buildAddetti(d)}
${buildAiContent(aiContent, 4)}
${buildFirme(d)}
</div>`;

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>PIMUS – ${esc(d.ragioneSociale || 'Azienda')} – Rev. ${revision}</title>
  <style>${buildCss()}</style>
</head>
<body>${body}</body>
</html>`;
}

module.exports = { generatePimusHtml };
