'use strict';
/**
 * services/computoPdfGenerator.js
 * Genera il PDF "SAL — Stato Avanzamento Lavori" del computo metrico.
 * Stesso stile del POS: cover dark sidebar + tabella voci per categoria.
 */

const { rendererPool } = require('../pdf-renderer');

// ── helpers ────────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtEuro(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
}

function fmtNum(n) {
  if (n == null || isNaN(Number(n))) return '';
  return Number(n).toLocaleString('it-IT', { maximumFractionDigits: 4 });
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function salBarColor(pct) {
  if (pct >= 100) return '#10b981'; // emerald
  if (pct >= 60)  return '#3b82f6'; // blue
  if (pct >= 30)  return '#f59e0b'; // amber
  return '#94a3b8';                  // slate
}

function salBarHtml(pct, width = 80) {
  const color = salBarColor(pct);
  const filled = Math.min(100, Math.round(pct));
  return `<div style="display:inline-flex;align-items:center;gap:4pt;">
    <div style="width:${width}pt;height:5pt;border-radius:3pt;background:#E2E8F0;overflow:hidden;">
      <div style="width:${filled}%;height:100%;border-radius:3pt;background:${color};"></div>
    </div>
    <span style="font-size:8pt;font-weight:bold;color:${color};min-width:24pt;">${filled}%</span>
  </div>`;
}

// Build a tree: categories with their child voci
function buildTree(voci) {
  const cats = voci.filter(v => v.tipo === 'categoria').sort((a, b) => a.sort_order - b.sort_order);
  const items = voci.filter(v => v.tipo === 'voce').sort((a, b) => a.sort_order - b.sort_order);

  const tree = cats.map(cat => ({
    ...cat,
    children: items.filter(v => v.parent_id === cat.id),
  }));

  const orphans = items.filter(v => !v.parent_id);
  if (orphans.length > 0) {
    tree.push({ id: '__orphans__', codice: null, descrizione: 'Altre voci', sal_percentuale: 0, children: orphans });
  }

  return tree;
}

// SAL% aggregato per categoria (media pesata per importo)
function catSalPct(children) {
  const tot = children.reduce((s, v) => s + (Number(v.importo) || 0), 0);
  if (tot === 0) return 0;
  const mat = children.reduce((s, v) => s + (Number(v.importo) || 0) * (Number(v.sal_percentuale) || 0) / 100, 0);
  return Math.round((mat / tot) * 100);
}

// ── CSS ────────────────────────────────────────────────────────────────────────

function buildCss() {
  return `
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; word-break:break-word; overflow-wrap:break-word; min-width:0; }
html, body { margin:0; padding:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { font-family:Arial,Helvetica,sans-serif; font-size:10pt; color:#1E1E1E; line-height:1.65; background:#FFFFFF; }

@page { size:A4; margin:26mm 0 24mm 0; }

.doc { width:100%; max-width:100%; box-sizing:border-box; padding:0 16mm; }

/* Cover */
.cover {
  break-after: page; page-break-after: always;
  display:flex; width:100%; max-width:100%;
  height:247mm; overflow:hidden;
}
.cover-sidebar {
  width:62mm; max-width:62mm; flex-shrink:0;
  background:#2C2C2C; color:#FFFFFF;
  padding:12mm 9mm 10mm 10mm;
  display:flex; flex-direction:column;
}
.cover-sidebar-brand {
  font-size:10pt; font-weight:bold; letter-spacing:3.5pt; text-transform:uppercase;
  color:#AAAAAA; margin-bottom:10mm; padding-bottom:6mm; border-bottom:0.5pt solid #484848;
}
.cover-sidebar-item { margin-bottom:6mm; }
.cover-label { font-size:5.5pt; letter-spacing:1.2pt; text-transform:uppercase; color:#888888; margin-bottom:2pt; }
.cover-value { font-size:8.5pt; font-weight:bold; color:#FFFFFF; line-height:1.35; }
.cover-sidebar-footer {
  margin-top:auto; font-size:6.5pt; color:#666666;
  padding-top:5mm; border-top:0.5pt solid #444444; line-height:1.5;
}
.cover-main {
  flex:1; min-width:0; max-width:100%;
  padding:12mm 10mm 10mm 12mm;
  display:flex; flex-direction:column; background:#FFFFFF;
}
.cover-top { flex:1; }
.cover-title {
  font-size:22pt; font-weight:bold; color:#1E1E1E;
  text-transform:uppercase; letter-spacing:0.3pt; line-height:1.15; margin-bottom:4mm;
}
.cover-subtitle { font-size:9pt; color:#777777; margin-bottom:7mm; font-style:italic; }
.cover-badge {
  display:inline-block; background:#2C2C2C; color:#FFFFFF;
  font-size:8.5pt; font-weight:bold; padding:3pt 11pt;
  border-radius:2pt; margin-bottom:7mm; letter-spacing:0.3pt;
}
.cover-divider { border:none; border-top:0.75pt solid #E8E8E8; margin:0 0 6mm 0; }
.cover-meta-grid { display:grid; grid-template-columns:1fr 1fr; gap:4mm 6mm; }
.cover-meta-label { font-size:6pt; letter-spacing:1pt; text-transform:uppercase; color:#AAAAAA; margin-bottom:1pt; }
.cover-meta-value { font-size:8.5pt; font-weight:bold; color:#1E1E1E; }

/* KPI bar (cover) */
.kpi-row { display:grid; grid-template-columns:repeat(3,1fr); gap:3mm; margin-top:6mm; }
.kpi-box {
  background:#F8FAFC; border:0.5pt solid #E2E8F0; border-radius:3pt;
  padding:4mm 5mm; text-align:center;
}
.kpi-label { font-size:6pt; letter-spacing:0.8pt; text-transform:uppercase; color:#94A3B8; margin-bottom:2pt; }
.kpi-value { font-size:11pt; font-weight:bold; color:#1E1E1E; line-height:1.2; }
.kpi-value.maturato { color:#10b981; }
.kpi-value.sal       { color:#3b82f6; }

/* SAL globale bar (cover) */
.sal-global-wrap { margin-top:5mm; }
.sal-global-label { font-size:7pt; letter-spacing:0.8pt; text-transform:uppercase; color:#94A3B8; margin-bottom:2pt; }
.sal-global-bar-bg { width:100%; height:7pt; border-radius:4pt; background:#E2E8F0; overflow:hidden; }
.sal-global-bar-fill { height:100%; border-radius:4pt; background:#3b82f6; }

/* Sections (content pages) */
h2 {
  font-size:11pt; font-weight:bold; color:#1E1E1E;
  margin:7mm 0 4mm 0; padding-bottom:2mm;
  border-bottom:1.5pt solid #2C2C2C;
  break-after:avoid-page; page-break-after:avoid;
  text-transform:uppercase; letter-spacing:0.3pt;
}

/* Categoria header */
.cat-header {
  display:flex; align-items:center; justify-content:space-between;
  background:#2C2C2C; color:#FFFFFF;
  padding:3mm 4mm; border-radius:2pt;
  margin-top:5mm; margin-bottom:1mm;
  break-inside:avoid; page-break-inside:avoid;
  break-after:avoid; page-break-after:avoid;
}
.cat-codice { font-size:7pt; font-weight:bold; color:#AAAAAA; margin-right:3mm; flex-shrink:0; }
.cat-desc   { font-size:9pt; font-weight:bold; color:#FFFFFF; flex:1; }
.cat-sal    { display:flex; align-items:center; gap:4pt; flex-shrink:0; margin-left:4mm; }
.cat-sal-bar-bg  { width:50pt; height:4pt; border-radius:3pt; background:#555555; overflow:hidden; }
.cat-sal-bar-fill{ height:100%; border-radius:3pt; }
.cat-sal-pct { font-size:8pt; font-weight:bold; color:#FFFFFF; min-width:20pt; text-align:right; }
.cat-importo { font-size:9pt; font-weight:bold; color:#FFFFFF; margin-left:4mm; flex-shrink:0; }

/* Voci table */
table.voci { width:100%; table-layout:fixed; border-collapse:collapse; font-size:8.5pt; margin-bottom:4mm; }
table.voci th {
  background:#F1F5F9; color:#475569;
  font-size:7pt; letter-spacing:0.5pt; text-transform:uppercase;
  padding:2mm 3mm; text-align:left; border-bottom:0.75pt solid #CBD5E1;
}
table.voci td {
  padding:1.8mm 3mm; border-bottom:0.5pt solid #E2E8F0;
  vertical-align:middle; color:#1E1E1E;
}
table.voci tr:last-child td { border-bottom:none; }
table.voci tr:nth-child(even) td { background:#FAFBFD; }
.col-codice  { width:9%; }
.col-desc    { width:35%; }
.col-um      { width:7%;  text-align:center; }
.col-qty     { width:9%;  text-align:right; }
.col-pu      { width:12%; text-align:right; }
.col-importo { width:13%; text-align:right; }
.col-sal     { width:15%; text-align:center; }
td.num       { text-align:right; font-variant-numeric:tabular-nums; }
td.center    { text-align:center; }

/* Note voce */
.voce-note { font-size:7pt; color:#94A3B8; font-style:italic; margin-top:0.5mm; }

/* Sommario finale */
.summary-table { width:100%; border-collapse:collapse; margin-top:4mm; }
.summary-table td { padding:2mm 4mm; font-size:9pt; border:0.5pt solid #E2E8F0; }
.summary-table .s-label { color:#64748B; }
.summary-table .s-value { font-weight:bold; text-align:right; }
.summary-table .s-total td { background:#2C2C2C; color:#FFFFFF; font-weight:bold; }

/* Firma */
.sign-section { margin-top:12mm; display:grid; grid-template-columns:1fr 1fr; gap:8mm; }
.sign-box { border-top:0.75pt solid #CBD5E1; padding-top:3mm; }
.sign-label { font-size:7pt; letter-spacing:0.8pt; text-transform:uppercase; color:#94A3B8; }

thead { display:table-header-group; }
tr    { break-inside:avoid; page-break-inside:avoid; }
`;
}

// ── HTML builder ───────────────────────────────────────────────────────────────

function buildHtml({ computo, voci, site, company }) {
  const tree = buildTree(voci);
  const totale    = Number(computo.totale_contratto) || 0;
  const maturato  = voci
    .filter(v => v.tipo === 'voce')
    .reduce((s, v) => s + (Number(v.importo) || 0) * (Number(v.sal_percentuale) || 0) / 100, 0);
  const salGlobal = totale > 0 ? Math.round((maturato / totale) * 100) : 0;
  const salColor  = salBarColor(salGlobal);
  const today     = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // ── Cover ──────────────────────────────────────────────────────────────────
  const coverHtml = `
<div class="cover">
  <div class="cover-sidebar">
    <div class="cover-sidebar-brand">Palladia</div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Azienda</div>
      <div class="cover-value">${esc(company?.name || '—')}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Cantiere</div>
      <div class="cover-value">${esc(site?.name || '—')}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Indirizzo</div>
      <div class="cover-value">${esc(site?.address || '—')}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Data emissione</div>
      <div class="cover-value">${today}</div>
    </div>

    <div class="cover-sidebar-footer">
      Documento generato da Palladia<br>
      Gestione digitale cantieri
    </div>
  </div>

  <div class="cover-main">
    <div class="cover-top">
      <div class="cover-title">Stato Avanzamento Lavori</div>
      <div class="cover-subtitle">${esc(computo.nome)}</div>
      <div class="cover-badge">SAL — ${today}</div>
      <hr class="cover-divider">

      <div class="kpi-row">
        <div class="kpi-box">
          <div class="kpi-label">Totale contratto</div>
          <div class="kpi-value">${esc(fmtEuro(totale))}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">Maturato</div>
          <div class="kpi-value maturato">${esc(fmtEuro(Math.round(maturato * 100) / 100))}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">SAL globale</div>
          <div class="kpi-value sal">${salGlobal}%</div>
        </div>
      </div>

      <div class="sal-global-wrap">
        <div class="sal-global-label">Avanzamento complessivo</div>
        <div class="sal-global-bar-bg">
          <div class="sal-global-bar-fill" style="width:${salGlobal}%;background:${salColor};"></div>
        </div>
      </div>
    </div>
  </div>
</div>`;

  // ── Tabella voci ───────────────────────────────────────────────────────────
  let voiciHtml = `<h2>Dettaglio voci di computo</h2>`;

  for (const cat of tree) {
    const sal     = catSalPct(cat.children);
    const totCat  = cat.children.reduce((s, v) => s + (Number(v.importo) || 0), 0);
    const catColor = salBarColor(sal);

    voiciHtml += `
<div class="cat-header">
  ${cat.codice ? `<span class="cat-codice">${esc(cat.codice)}</span>` : ''}
  <span class="cat-desc">${esc(cat.descrizione)}</span>
  <span class="cat-sal">
    <div class="cat-sal-bar-bg">
      <div class="cat-sal-bar-fill" style="width:${sal}%;background:${catColor};"></div>
    </div>
    <span class="cat-sal-pct">${sal}%</span>
  </span>
  <span class="cat-importo">${esc(fmtEuro(totCat))}</span>
</div>`;

    if (cat.children.length > 0) {
      voiciHtml += `
<table class="voci">
  <thead>
    <tr>
      <th class="col-codice">Cod.</th>
      <th class="col-desc">Descrizione</th>
      <th class="col-um">UM</th>
      <th class="col-qty">Qt.</th>
      <th class="col-pu">Prezzo u.</th>
      <th class="col-importo">Importo</th>
      <th class="col-sal">SAL</th>
    </tr>
  </thead>
  <tbody>`;

      for (const v of cat.children) {
        const salPct = Number(v.sal_percentuale) || 0;
        voiciHtml += `
    <tr>
      <td class="col-codice" style="font-size:7pt;color:#94A3B8;font-family:monospace">${esc(v.codice || '')}</td>
      <td class="col-desc">
        ${esc(v.descrizione)}
        ${v.sal_note ? `<div class="voce-note">${esc(v.sal_note)}</div>` : ''}
      </td>
      <td class="col-um center" style="font-size:8pt;color:#64748B">${esc(v.unita_misura || '')}</td>
      <td class="col-qty num" style="font-size:8pt">${fmtNum(v.quantita)}</td>
      <td class="col-pu num" style="font-size:8pt">${v.prezzo_unitario != null ? esc(fmtEuro(v.prezzo_unitario)) : ''}</td>
      <td class="col-importo num" style="font-weight:600">${v.importo != null ? esc(fmtEuro(v.importo)) : ''}</td>
      <td class="col-sal center">${salBarHtml(salPct, 50)}</td>
    </tr>`;
      }

      voiciHtml += `
  </tbody>
</table>`;
    }
  }

  // ── Sommario finale ────────────────────────────────────────────────────────
  const daFatturare = Math.round(maturato * 100) / 100;
  const rimanente   = Math.round((totale - maturato) * 100) / 100;

  const summaryHtml = `
<h2 style="margin-top:8mm">Riepilogo SAL</h2>
<table class="summary-table">
  <tr>
    <td class="s-label">Totale contratto</td>
    <td class="s-value">${esc(fmtEuro(totale))}</td>
  </tr>
  <tr>
    <td class="s-label">Importo maturato al ${today}</td>
    <td class="s-value" style="color:#10b981">${esc(fmtEuro(daFatturare))}</td>
  </tr>
  <tr>
    <td class="s-label">Importo da maturare</td>
    <td class="s-value" style="color:#f59e0b">${esc(fmtEuro(rimanente))}</td>
  </tr>
  <tr class="s-total">
    <td>SAL GLOBALE</td>
    <td style="text-align:right">${salGlobal}%</td>
  </tr>
</table>

<div class="sign-section">
  <div class="sign-box">
    <div class="sign-label">Redatto da</div>
  </div>
  <div class="sign-box">
    <div class="sign-label">Vistato dal committente</div>
  </div>
</div>`;

  // ── Final HTML ─────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>SAL — ${esc(computo.nome)}</title>
  <style>${buildCss()}</style>
</head>
<body>
  <div class="doc">
    ${coverHtml}
    ${voiciHtml}
    ${summaryHtml}
  </div>
</body>
</html>`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function generateComputoPdf({ computo, voci, site, company }) {
  const html = buildHtml({ computo, voci, site, company });
  return rendererPool.render(html, {
    docTitle: `SAL — ${computo.nome}`,
    revision: 1,
  });
}

module.exports = { generateComputoPdf };
