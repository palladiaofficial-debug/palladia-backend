'use strict';
/**
 * services/offerPdfGenerator.js
 * Genera il PDF "Offerta Economica" stile Palladia.
 * Cover dark sidebar + tabella voci per categoria + riepilogo totale.
 */

const { rendererPool } = require('../pdf-renderer');

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

const STATO_LABEL = { bozza: 'Bozza', inviata: 'Inviata', vinta: 'Vinta', persa: 'Persa' };
const STATO_COLOR = { bozza: '#94A3B8', inviata: '#3B82F6', vinta: '#10B981', persa: '#EF4444' };

function buildTree(items) {
  const cats  = items.filter(i => i.tipo === 'categoria').sort((a, b) => a.sort_order - b.sort_order);
  const voci  = items.filter(i => i.tipo === 'voce').sort((a, b) => a.sort_order - b.sort_order);
  const tree  = cats.map(cat => ({
    ...cat,
    children: voci.filter(v => v.parent_id === cat.id),
  }));
  const orphans = voci.filter(v => !v.parent_id);
  if (orphans.length > 0) tree.push({ id: '__orphans__', codice: null, descrizione: 'Altre lavorazioni', children: orphans });
  return tree;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

function buildCss() {
  return `
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; word-break:break-word; overflow-wrap:break-word; min-width:0; }
html, body { margin:0; padding:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { font-family:Arial,Helvetica,sans-serif; font-size:10pt; color:#1E1E1E; line-height:1.65; background:#FFFFFF; }

@page { size:A4; margin:26mm 0 24mm 0; }
.doc { width:100%; max-width:100%; box-sizing:border-box; padding:0 16mm; }

/* Cover */
.cover { break-after:page; page-break-after:always; display:flex; width:100%; max-width:100%; height:247mm; overflow:hidden; }
.cover-sidebar {
  width:62mm; max-width:62mm; flex-shrink:0;
  background:#1E1E1E; color:#FFFFFF;
  padding:12mm 9mm 10mm 10mm; display:flex; flex-direction:column;
}
.cover-sidebar-brand { font-size:10pt; font-weight:bold; letter-spacing:3.5pt; text-transform:uppercase; color:#AAAAAA; margin-bottom:10mm; padding-bottom:6mm; border-bottom:0.5pt solid #484848; }
.cover-sidebar-item { margin-bottom:7mm; }
.cover-label { font-size:5.5pt; letter-spacing:1.2pt; text-transform:uppercase; color:#888888; margin-bottom:2pt; }
.cover-value { font-size:8.5pt; font-weight:bold; color:#FFFFFF; line-height:1.35; }
.cover-sidebar-footer { margin-top:auto; font-size:6.5pt; color:#666666; padding-top:5mm; border-top:0.5pt solid #444444; line-height:1.5; }
.cover-main { flex:1; min-width:0; max-width:100%; padding:12mm 10mm 10mm 12mm; display:flex; flex-direction:column; background:#FFFFFF; }
.cover-top { flex:1; }
.cover-tag { display:inline-block; font-size:7pt; font-weight:bold; letter-spacing:1pt; text-transform:uppercase; padding:2pt 8pt; border-radius:2pt; margin-bottom:5mm; }
.cover-title { font-size:22pt; font-weight:bold; color:#1E1E1E; text-transform:uppercase; letter-spacing:0.3pt; line-height:1.15; margin-bottom:3mm; }
.cover-subtitle { font-size:9.5pt; color:#555555; margin-bottom:8mm; }
.cover-divider { border:none; border-top:0.75pt solid #E8E8E8; margin:0 0 6mm 0; }
.cover-meta-grid { display:grid; grid-template-columns:1fr 1fr; gap:4mm 6mm; }
.cover-meta-label { font-size:6pt; letter-spacing:1pt; text-transform:uppercase; color:#AAAAAA; margin-bottom:1pt; }
.cover-meta-value { font-size:8.5pt; font-weight:bold; color:#1E1E1E; }
.kpi-row { display:grid; grid-template-columns:repeat(3,1fr); gap:3mm; margin-top:7mm; }
.kpi-box { background:#F8FAFC; border:0.5pt solid #E2E8F0; border-radius:3pt; padding:4mm 5mm; text-align:center; }
.kpi-label { font-size:6pt; letter-spacing:0.8pt; text-transform:uppercase; color:#94A3B8; margin-bottom:2pt; }
.kpi-value { font-size:11pt; font-weight:bold; color:#1E1E1E; line-height:1.2; }
.kpi-value.verde { color:#10b981; }

/* Titoli sezione */
h2 { font-size:11pt; font-weight:bold; color:#1E1E1E; margin:7mm 0 4mm 0; padding-bottom:2mm; border-bottom:1.5pt solid #1E1E1E; break-after:avoid-page; page-break-after:avoid; text-transform:uppercase; letter-spacing:0.3pt; }

/* Categoria */
.cat-header { display:flex; align-items:center; justify-content:space-between; background:#1E1E1E; color:#FFFFFF; padding:3mm 4mm; border-radius:2pt; margin-top:5mm; margin-bottom:1mm; break-inside:avoid; page-break-inside:avoid; break-after:avoid; page-break-after:avoid; }
.cat-codice { font-size:7pt; font-weight:bold; color:#AAAAAA; margin-right:3mm; flex-shrink:0; }
.cat-desc   { font-size:9pt; font-weight:bold; color:#FFFFFF; flex:1; }
.cat-tot    { font-size:9pt; font-weight:bold; color:#FFFFFF; margin-left:4mm; flex-shrink:0; }

/* Tabella voci */
table.voci { width:100%; table-layout:fixed; border-collapse:collapse; font-size:8.5pt; margin-bottom:4mm; }
table.voci th { background:#F1F5F9; color:#475569; font-size:7pt; letter-spacing:0.5pt; text-transform:uppercase; padding:2mm 3mm; text-align:left; border-bottom:0.75pt solid #CBD5E1; }
table.voci td { padding:1.8mm 3mm; border-bottom:0.5pt solid #E2E8F0; vertical-align:middle; color:#1E1E1E; }
table.voci tr:last-child td { border-bottom:none; }
table.voci tr:nth-child(even) td { background:#FAFBFD; }
.col-cod  { width:8%;  }
.col-desc { width:32%; }
.col-um   { width:7%;  text-align:center; }
.col-qty  { width:9%;  text-align:right; }
.col-ref  { width:12%; text-align:right; }
.col-off  { width:14%; text-align:right; }
.col-imp  { width:13%; text-align:right; }
td.num    { text-align:right; font-variant-numeric:tabular-nums; }
td.center { text-align:center; }
.prezzo-offerta { font-weight:bold; color:#1E1E1E; }
.prezzo-vuoto   { color:#CBD5E1; }

/* Sommario */
.summary-table { width:100%; border-collapse:collapse; margin-top:4mm; }
.summary-table td { padding:2.5mm 4mm; font-size:9pt; border:0.5pt solid #E2E8F0; }
.summary-table .s-label { color:#64748B; }
.summary-table .s-value { font-weight:bold; text-align:right; }
.summary-table .s-total td { background:#1E1E1E; color:#FFFFFF; font-weight:bold; font-size:10pt; }

/* Firme */
.sign-section { margin-top:12mm; display:grid; grid-template-columns:1fr 1fr; gap:8mm; }
.sign-box { border-top:0.75pt solid #CBD5E1; padding-top:3mm; }
.sign-label { font-size:7pt; letter-spacing:0.8pt; text-transform:uppercase; color:#94A3B8; }

thead { display:table-header-group; }
tr    { break-inside:avoid; page-break-inside:avoid; }
`;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml({ offer, items, company }) {
  const tree    = buildTree(items);
  const totale  = Number(offer.totale_offerta) || 0;
  const nVoci   = items.filter(i => i.tipo === 'voce').length;
  const nCat    = items.filter(i => i.tipo === 'categoria').length;
  const stato   = offer.stato || 'bozza';
  const statoLbl = STATO_LABEL[stato] || stato;
  const statoClr = STATO_COLOR[stato] || '#94A3B8';
  const today    = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const emissione = fmtDate(offer.created_at) || today;

  // ── Cover ──────────────────────────────────────────────────────────────────
  const coverHtml = `
<div class="cover">
  <div class="cover-sidebar">
    <div class="cover-sidebar-brand">Palladia</div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Impresa</div>
      <div class="cover-value">${esc(company?.name || '—')}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Cliente / Stazione appaltante</div>
      <div class="cover-value">${esc(offer.cliente || '—')}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Oggetto</div>
      <div class="cover-value">${esc(offer.oggetto || '—')}</div>
    </div>

    <div class="cover-sidebar-item">
      <div class="cover-label">Data emissione</div>
      <div class="cover-value">${emissione}</div>
    </div>

    <div class="cover-sidebar-footer">
      Offerta generata con Palladia<br>
      Gestione digitale cantieri
    </div>
  </div>

  <div class="cover-main">
    <div class="cover-top">
      <div class="cover-tag" style="background:${statoClr}20;color:${statoClr};border:0.5pt solid ${statoClr}40;">
        ${esc(statoLbl)}
      </div>
      <div class="cover-title">Offerta Economica</div>
      <div class="cover-subtitle">${esc(offer.nome)}</div>
      <hr class="cover-divider">

      <div class="cover-meta-grid">
        <div>
          <div class="cover-meta-label">Cliente</div>
          <div class="cover-meta-value">${esc(offer.cliente || '—')}</div>
        </div>
        <div>
          <div class="cover-meta-label">Data offerta</div>
          <div class="cover-meta-value">${emissione}</div>
        </div>
        <div style="grid-column:1/-1;">
          <div class="cover-meta-label">Oggetto lavori</div>
          <div class="cover-meta-value">${esc(offer.oggetto || '—')}</div>
        </div>
      </div>

      <div class="kpi-row">
        <div class="kpi-box">
          <div class="kpi-label">Totale offerta</div>
          <div class="kpi-value verde">${esc(fmtEuro(totale))}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">N° lavorazioni</div>
          <div class="kpi-value">${nVoci}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">Categorie</div>
          <div class="kpi-value">${nCat}</div>
        </div>
      </div>
    </div>
  </div>
</div>`;

  // ── Tabella voci ───────────────────────────────────────────────────────────
  let tableHtml = `<h2>Dettaglio lavorazioni</h2>`;

  for (const cat of tree) {
    const subtot = cat.children.reduce((s, v) => s + (Number(v.importo_offerta) || 0), 0);

    tableHtml += `
<div class="cat-header">
  ${cat.codice ? `<span class="cat-codice">${esc(cat.codice)}</span>` : ''}
  <span class="cat-desc">${esc(cat.descrizione)}</span>
  <span class="cat-tot">${subtot > 0 ? esc(fmtEuro(subtot)) : ''}</span>
</div>`;

    if (cat.children.length > 0) {
      tableHtml += `
<table class="voci">
  <thead>
    <tr>
      <th class="col-cod">Cod.</th>
      <th class="col-desc">Descrizione</th>
      <th class="col-um">UM</th>
      <th class="col-qty">Qt.</th>
      <th class="col-ref">P. rif.</th>
      <th class="col-off">P. offerta</th>
      <th class="col-imp">Importo</th>
    </tr>
  </thead>
  <tbody>`;

      for (const v of cat.children) {
        const hasPrice = v.prezzo_offerta != null;
        tableHtml += `
    <tr>
      <td class="col-cod" style="font-size:7pt;color:#94A3B8;font-family:monospace">${esc(v.codice || '')}</td>
      <td class="col-desc">${esc(v.descrizione)}</td>
      <td class="col-um center" style="font-size:8pt;color:#64748B">${esc(v.unita_misura || '')}</td>
      <td class="col-qty num" style="font-size:8pt">${fmtNum(v.quantita)}</td>
      <td class="col-ref num" style="font-size:8pt;color:#94A3B8">${v.prezzo_ref != null ? esc(fmtEuro(v.prezzo_ref)) : ''}</td>
      <td class="col-off num ${hasPrice ? 'prezzo-offerta' : 'prezzo-vuoto'}">${hasPrice ? esc(fmtEuro(v.prezzo_offerta)) : '—'}</td>
      <td class="col-imp num" style="font-weight:600">${v.importo_offerta != null ? esc(fmtEuro(v.importo_offerta)) : ''}</td>
    </tr>`;
      }

      tableHtml += `
  </tbody>
</table>`;
    }
  }

  // ── Sommario ───────────────────────────────────────────────────────────────
  const summaryHtml = `
<h2 style="margin-top:8mm">Riepilogo offerta</h2>
<table class="summary-table">
  <tr>
    <td class="s-label">Data offerta</td>
    <td class="s-value">${emissione}</td>
  </tr>
  <tr>
    <td class="s-label">N° lavorazioni</td>
    <td class="s-value">${nVoci}</td>
  </tr>
  <tr class="s-total">
    <td>TOTALE OFFERTA</td>
    <td style="text-align:right">${esc(fmtEuro(totale))}</td>
  </tr>
</table>

<div class="sign-section">
  <div class="sign-box">
    <div class="sign-label">L'impresa offerente</div>
  </div>
  <div class="sign-box">
    <div class="sign-label">Timbro e firma</div>
  </div>
</div>`;

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>Offerta — ${esc(offer.nome)}</title>
  <style>${buildCss()}</style>
</head>
<body>
  <div class="doc">
    ${coverHtml}
    ${tableHtml}
    ${summaryHtml}
  </div>
</body>
</html>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function generateOfferPdf({ offer, items, company }) {
  const html = buildHtml({ offer, items, company });
  return rendererPool.render(html, {
    docTitle: `Offerta — ${offer.nome}`,
    revision: 1,
  });
}

module.exports = { generateOfferPdf };
