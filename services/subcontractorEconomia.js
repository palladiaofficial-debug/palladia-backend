'use strict';
/**
 * services/subcontractorEconomia.js
 *
 * Data layer + PDF ("estratto conto") per l'economia di un subappaltatore
 * (F-188/F-189, AUDIT.md). Un subappaltatore ha spesso un contratto SEPARATO
 * per ogni cantiere (stesso subappaltatore, importi diversi) — appalto
 * totale e % avanzamento vivono quindi sulla coppia (site, subcontractor),
 * non sul subappaltatore da solo.
 *
 * Estratto da routes/v1/subcontractors.js per essere condiviso tra
 * l'endpoint JSON (schermata Economia) e il nuovo PDF — stessa fonte,
 * mai due calcoli che potrebbero disallinearsi.
 *
 * Export pubblici:
 *   buildSubcontractorEconomia(subcontractorId, companyId) → Promise<EconomiaData>
 *   generateSubcontractorStatementHtml(data)                → string (HTML completo)
 */

const supabase = require('../lib/supabase');

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtEur(n) {
  if (n == null) return '—';
  const rounded = Math.round(n);
  const abs = Math.abs(rounded);
  const sign = rounded < 0 ? '-' : '';
  const formatted = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${formatted} €`;
}

async function buildSubcontractorEconomia(subcontractorId, companyId) {
  const { data: sub, error: subErr } = await supabase
    .from('subcontractors')
    .select('id, company_name, piva')
    .eq('id', subcontractorId).eq('company_id', companyId).maybeSingle();
  if (subErr) throw new Error('DB_ERROR: ' + subErr.message);
  if (!sub) { const e = new Error('NOT_FOUND'); e.status = 404; throw e; }

  const { data: assignments, error: assignErr } = await supabase
    .from('site_subcontractors')
    .select('id, site_id, role, assigned_at, budget_totale, sal_percentuale, site:site_id(id, name, status)')
    .eq('subcontractor_id', subcontractorId)
    .eq('company_id', companyId)
    .order('assigned_at', { ascending: false });
  if (assignErr) throw new Error('DB_ERROR: ' + assignErr.message);

  const siteIds = (assignments || []).map(a => a.site_id);
  let costsBySite = {};
  if (siteIds.length) {
    const { data: costs, error: costsErr } = await supabase
      .from('site_costs')
      .select('site_id, tipo, importo')
      .eq('subcontractor_id', subcontractorId)
      .eq('company_id', companyId)
      .in('site_id', siteIds);
    if (costsErr) throw new Error('DB_ERROR: ' + costsErr.message);
    for (const c of (costs || [])) {
      const bucket = costsBySite[c.site_id] || (costsBySite[c.site_id] = { acconti: 0, fatturato: 0, altro: 0 });
      const importo = Number(c.importo) || 0;
      if (c.tipo === 'acconto') bucket.acconti += importo;
      else if (c.tipo === 'fattura') bucket.fatturato += importo;
      else bucket.altro += importo;
    }
  }

  const sites = (assignments || [])
    .filter(a => a.site && a.site.status !== 'chiuso' && a.site.status !== 'eliminato')
    .map(a => {
      const budgetTotale   = a.budget_totale !== null ? Number(a.budget_totale) : null;
      const salPercentuale = Number(a.sal_percentuale) || 0;
      const c = costsBySite[a.site_id] || { acconti: 0, fatturato: 0, altro: 0 };
      return {
        assignment_id:      a.id,
        site_id:            a.site_id,
        site_name:          a.site?.name || '—',
        role:               a.role,
        assigned_at:        a.assigned_at,
        budget_totale:      budgetTotale,
        sal_percentuale:    salPercentuale,
        importo_maturato:   budgetTotale !== null ? Math.round(budgetTotale * salPercentuale / 100 * 100) / 100 : null,
        acconti_dati:       Math.round(c.acconti * 100) / 100,
        fatturato:          Math.round(c.fatturato * 100) / 100,
        saldo_da_erogare:   budgetTotale !== null ? Math.round((budgetTotale - c.acconti) * 100) / 100 : null,
      };
    });

  const totals = sites.reduce((acc, s) => ({
    totale_appalti:  acc.totale_appalti  + (s.budget_totale ?? 0),
    totale_acconti:  acc.totale_acconti  + s.acconti_dati,
    totale_fatturato: acc.totale_fatturato + s.fatturato,
    totale_maturato: acc.totale_maturato + (s.importo_maturato ?? 0),
    cantieri_con_appalto: acc.cantieri_con_appalto + (s.budget_totale !== null ? 1 : 0),
  }), { totale_appalti: 0, totale_acconti: 0, totale_fatturato: 0, totale_maturato: 0, cantieri_con_appalto: 0 });

  const { data: company } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();

  return {
    subcontractor: { id: sub.id, company_name: sub.company_name, piva: sub.piva },
    company: { name: company?.name || '—' },
    sites,
    totals: {
      totale_appalti:       Math.round(totals.totale_appalti * 100) / 100,
      totale_acconti:       Math.round(totals.totale_acconti * 100) / 100,
      totale_fatturato:     Math.round(totals.totale_fatturato * 100) / 100,
      totale_maturato:      Math.round(totals.totale_maturato * 100) / 100,
      cantieri_attivi:      sites.length,
      cantieri_con_appalto: totals.cantieri_con_appalto,
    },
  };
}

// ── PDF "Estratto Conto Subappaltatore" ────────────────────────────────────────
// Stessa architettura Puppeteer di services/presenceReport.js (F-185, AUDIT.md
// — CSS/font/palette già verificati dal vivo, riusati qui verbatim):
//   @page { margin: 26mm 0 24mm 0 } ↔ Puppeteer top:26mm / bottom:24mm
//   .doc { padding: 0 16mm }        ↔ allineato ai template H/F
//   displayHeaderFooter: true       → Chrome riserva le bande, zero overlay
function generateSubcontractorStatementHtml(data) {
  const { subcontractor, company, sites, totals } = data;
  const generatedAt = new Date();
  const genDateStr = `${generatedAt.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}, ${
    generatedAt.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })}`;
  const docId = require('crypto').randomUUID();

  const rowsHtml = sites.map(s => {
    const saldoClass = s.saldo_da_erogare != null && s.saldo_da_erogare > 0 ? 'td-warn' : '';
    return `
    <tr>
      <td class="td-site">${esc(s.site_name)}</td>
      <td class="td-num">${fmtEur(s.budget_totale)}</td>
      <td class="td-num">${s.sal_percentuale}%</td>
      <td class="td-num">${fmtEur(s.acconti_dati)}</td>
      <td class="td-num">${fmtEur(s.fatturato)}</td>
      <td class="td-num">${fmtEur(s.importo_maturato)}</td>
      <td class="td-num ${saldoClass}">${fmtEur(s.saldo_da_erogare)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --primary: #22384F; --primary-tint: #EEF2F6;
  --text: #1A1714; --muted: #7A736A; --muted-2: #9C948A;
  --border: #E7E2D8; --border-strong: #D8D1C3;
  --success: #4A7358; --success-bg: #EEF3EE;
  --warning: #A8672A; --warning-bg: #FBF3E8;
  --destructive: #A8453B; --destructive-bg: #FBF0EE;
}
*, *::before, *::after {
  box-sizing: border-box; margin: 0; padding: 0;
  word-break: break-word; overflow-wrap: break-word; min-width: 0;
}
html, body {
  margin: 0; padding: 0;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
body {
  font-family: 'Plus Jakarta Sans', Arial, Helvetica, sans-serif;
  font-size: 9.5pt; color: var(--text); line-height: 1.55; background: #FFFFFF;
}
table { color: var(--text); }
.doc { width: 100%; max-width: 100%; box-sizing: border-box; padding: 0 16mm; }

.doc-eyebrow {
  display: inline-flex; align-items: center; gap: 6pt;
  font-size: 7.5pt; font-weight: 700; letter-spacing: 0.9pt; text-transform: uppercase;
  color: var(--primary); background: var(--primary-tint);
  padding: 3pt 7pt 3pt 5pt; border-radius: 2.5pt; margin-bottom: 8pt;
}
.doc-title { font-size: 19pt; font-weight: 700; letter-spacing: -0.3pt; color: var(--text); line-height: 1.2; margin-bottom: 3pt; }
.doc-title-rule { width: 22pt; height: 2.5pt; background: var(--primary); border-radius: 2pt; margin: 8pt 0 12pt; }

.meta-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt 10pt;
  margin-bottom: 14pt; padding-bottom: 12pt; border-bottom: 0.75pt solid var(--border);
}
.meta-k { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.6pt; text-transform: uppercase; color: var(--muted-2); margin-bottom: 1.5pt; }
.meta-v { font-size: 9.5pt; font-weight: 600; color: var(--text); line-height: 1.35; }

.section-title {
  display: flex; align-items: center; gap: 7pt;
  font-size: 7.5pt; font-weight: 700; letter-spacing: 0.7pt; text-transform: uppercase;
  color: var(--muted); margin-top: 16pt; margin-bottom: 8pt;
}
.section-title::after { content: ""; flex: 1; height: 0.75pt; background: var(--border); }
.section-title:first-of-type { margin-top: 0; }

.summary-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 6pt; margin-bottom: 14pt;
}
.summary-card {
  border: 0.75pt solid var(--border); border-radius: 4pt;
  padding: 8pt 9pt;
}
.sc-num   { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 14pt; font-weight: 600; color: var(--text); line-height: 1; margin-bottom: 4pt; }
.sc-label { font-size: 6.5pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5pt; font-weight: 600; }
.sc-primary .sc-num { color: var(--primary); }

/*
  Larghezza contenuto A4 = 210mm − 2×16mm = 178mm — 7 colonne:
  Cantiere 26% · Appalto 12% · Avanz. 9% · Acconti 13% · Fatturato 13% ·
  Maturato 13% · Saldo 14% = 100%
*/
.eco-table {
  width: 100%; table-layout: fixed; border-collapse: collapse;
  font-size: 8.3pt; margin-bottom: 14pt;
}
.eco-table thead th {
  padding: 0 5pt 6pt 0; font-size: 6.8pt; font-weight: 700;
  letter-spacing: 0.4pt; text-transform: uppercase; color: var(--muted);
  text-align: right; border-bottom: 1.5pt solid var(--text);
}
.eco-table thead th:first-child { text-align: left; }
.eco-table tbody td {
  padding: 6pt 5pt 6pt 0; vertical-align: top; line-height: 1.4;
  box-shadow: inset 0 -0.75pt 0 var(--border);
}
.td-site { font-weight: 600; color: var(--text); width: 26%; }
.td-num  { text-align: right; font-variant-numeric: tabular-nums; width: 12.33%; }
.td-warn { color: var(--warning); font-weight: 700; }
.eco-table tfoot td {
  padding: 8pt 5pt 4pt 0; font-weight: 700; border-top: 1.5pt solid var(--text);
  font-variant-numeric: tabular-nums;
}
.eco-table tfoot td:first-child { text-align: left; }
.eco-table tfoot td:not(:first-child) { text-align: right; }

.declaration p { font-size: 7.5pt; color: var(--muted); line-height: 1.65; margin-bottom: 6pt; }
.declaration .doc-meta {
  font-size: 6.3pt; color: var(--muted-2); font-family: 'JetBrains Mono', 'Courier New', monospace;
  line-height: 1.7; margin-top: 8pt;
}

h1, h2, h3 { break-after: avoid-page; page-break-after: avoid; }
tr    { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }

@page { size: A4; margin: 26mm 0 24mm 0; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0 !important; padding: 0 !important;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.doc  { width: 100% !important; max-width: 100% !important;
  padding: 0 16mm !important; box-sizing: border-box !important; }
table { width: 100% !important; max-width: 100% !important;
  table-layout: fixed !important; border-collapse: collapse !important; }
th, td { max-width: 100% !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
thead { display: table-header-group; }
tr    { break-inside: avoid; page-break-inside: avoid; }
h1, h2, h3, .section-title { break-after: avoid-page !important; page-break-after: avoid !important; }
.summary-card, .declaration { break-inside: avoid !important; page-break-inside: avoid !important; }
</style>
</head>
<body>
<div class="doc">

  <div class="doc-eyebrow">Estratto conto subappaltatore</div>
  <div class="doc-title">${esc(subcontractor.company_name)}</div>
  <div class="doc-title-rule"></div>

  <div class="meta-grid">
    <div><div class="meta-k">Impresa</div><div class="meta-v">${esc(company.name)}</div></div>
    <div><div class="meta-k">Subappaltatore</div><div class="meta-v">${esc(subcontractor.company_name)}</div></div>
    <div><div class="meta-k">P.IVA</div><div class="meta-v">${esc(subcontractor.piva || '—')}</div></div>
    <div><div class="meta-k">Generato il</div><div class="meta-v">${genDateStr}</div></div>
  </div>

  <div class="summary-grid">
    <div class="summary-card sc-primary">
      <div class="sc-num">${fmtEur(totals.totale_appalti)}</div>
      <div class="sc-label">Appalti totali</div>
    </div>
    <div class="summary-card">
      <div class="sc-num">${fmtEur(totals.totale_acconti)}</div>
      <div class="sc-label">Acconti dati</div>
    </div>
    <div class="summary-card">
      <div class="sc-num">${fmtEur(totals.totale_fatturato)}</div>
      <div class="sc-label">Fatturato</div>
    </div>
    <div class="summary-card">
      <div class="sc-num">${totals.cantieri_attivi}</div>
      <div class="sc-label">Cantieri attivi</div>
    </div>
  </div>

  <div class="section-title">Dettaglio per cantiere</div>
  <table class="eco-table">
    <colgroup>
      <col style="width:26%"><col style="width:12%"><col style="width:9%">
      <col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:14%">
    </colgroup>
    <thead>
      <tr>
        <th>Cantiere</th><th>Appalto</th><th>Avanz.</th>
        <th>Acconti</th><th>Fatturato</th><th>Maturato</th><th>Saldo da erogare</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td>Totali</td><td>${fmtEur(totals.totale_appalti)}</td><td></td>
        <td>${fmtEur(totals.totale_acconti)}</td><td>${fmtEur(totals.totale_fatturato)}</td>
        <td>${fmtEur(totals.totale_maturato)}</td>
        <td>${fmtEur(Math.round((totals.totale_appalti - totals.totale_acconti) * 100) / 100)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="section-title">Note</div>
  <div class="declaration">
    <p>
      Questo estratto conto riepiloga gli importi tracciati su Palladia per il subappaltatore
      indicato — appalto totale e % di avanzamento inseriti manualmente per ciascun cantiere,
      acconti e fatturato sommati dai pagamenti registrati e collegati a questo subappaltatore.
      Non sostituisce la contabilità ufficiale dell'impresa.
    </p>
    <div class="doc-meta">
      ID documento : ${docId}<br>
      Timestamp    : ${generatedAt.toISOString()}<br>
      Subappaltatore : ${esc(subcontractor.company_name)} / ${subcontractor.id}<br>
      Impresa      : ${esc(company.name)}<br>
      Sistema      : Palladia — Estratto Conto Subappaltatore v1.0
    </div>
  </div>

</div>
</body>
</html>`;
}

module.exports = { buildSubcontractorEconomia, generateSubcontractorStatementHtml };
