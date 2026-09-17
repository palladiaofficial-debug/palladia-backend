'use strict';
/**
 * services/heatReport.js
 *
 * Data layer + template HTML/Excel per "Relazione Tecnica Caldo Cantiere" —
 * richiesta esplicita del titolare (2026-09-17), base normativa D.L.
 * 107/2026 art. 6 + messaggio INPS 2418/2026.
 *
 * F-210 (AUDIT.md, 2026-09-17): la fonte dei dati non è più una stima
 * interna (ARPAL/WBGT, migrations/218) ma il livello di rischio ufficiale
 * pubblicato da Worklimate (INAIL-CNR), quello che le ordinanze citano per
 * lo stop cantieri — trascritto MANUALMENTE da un utente dopo consultazione
 * di archivio.worklimate.it (nessuna API pubblica). Questo documento lo
 * dichiara esplicitamente: non è un dato certificato da un fetch
 * automatico, è una trascrizione umana tracciata (chi, quando, quale
 * ricerca) di un dato ufficiale.
 */
const ExcelJS = require('exceljs');

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PRIMARY = '22384F', TEXT = '1A1714', MUTED = '7A736A', WARNING = 'A8672A', DESTRUCTIVE = 'A8453B', BORDER = 'E7E2D8';

const LEVEL_LABEL = { verde: 'Verde — nullo', giallo: 'Giallo — basso', arancione: 'Arancione — moderato', rosso: 'Rosso — alto' };

function generateHeatReportHtml({ site, rows, from, to, filter }) {
  const confirmedDays = rows.filter(r => r.suspension_confirmed).length;
  const redDays = rows.filter(r => r.risk_level === 'rosso').length;

  const FILTER_LABELS = { critical: 'solo giorni bollino rosso', confirmed: 'solo giorni con sospensione confermata' };
  const minRowDate = rows.length ? rows[0].log_date : null;
  const maxRowDate = rows.length ? rows[rows.length - 1].log_date : null;
  const period = esc((from || minRowDate || '—') + ' → ' + (to || maxRowDate || '—'))
    + (FILTER_LABELS[filter] ? ` <span style="color:var(--warning);font-weight:700">(${FILTER_LABELS[filter]})</span>` : '');

  const tableRows = rows.map(r => {
    const isConf = r.suspension_confirmed;
    const isPending = r.risk_level === 'rosso' && !r.suspension_confirmed && !r.suspension_dismissed;
    const rowClass = isConf ? 'tr-conf' : isPending ? 'tr-pending' : '';
    let sospensioneHtml = '—';
    if (isConf) sospensioneHtml = '<span class="badge-anom">SOSPESO</span>';
    else if (r.suspension_dismissed) sospensioneHtml = 'Ignorato';
    else if (isPending) sospensioneHtml = '<span class="badge-warn">Da confermare</span>';

    return `<tr class="${rowClass}">
      <td class="td-date">${r.log_date}</td>
      <td class="td-center">${esc(LEVEL_LABEL[r.risk_level] || r.risk_level)}</td>
      <td class="td-center">${esc(r.comune) || '—'}</td>
      <td class="td-center">${sospensioneHtml}</td>
      <td>${esc(r.source_note) || '—'}</td>
    </tr>`;
  }).join('');

  const nowStr = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root { --primary:#${PRIMARY}; --primary-tint:#EEF2F6; --text:#${TEXT}; --muted:#${MUTED}; --muted-2:#9C948A;
  --border:#${BORDER}; --border-strong:#D8D1C3; --warning:#${WARNING}; --warning-bg:#FBF3E8;
  --destructive:#${DESTRUCTIVE}; --destructive-bg:#FBF0EE; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9.5pt; color: var(--text); }
.doc { padding: 0 16mm; }
.doc-eyebrow { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.7pt; text-transform: uppercase; color: var(--muted); margin-top: 8pt; }
.doc-title { font-size: 20pt; font-weight: 800; margin: 4pt 0 8pt; }
.doc-title-rule { height: 2pt; width: 40pt; background: var(--primary); margin-bottom: 14pt; }
.meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10pt; margin-bottom: 14pt; padding-bottom: 12pt; border-bottom: 0.75pt solid var(--border); }
.meta-k { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.6pt; text-transform: uppercase; color: var(--muted-2); margin-bottom: 1.5pt; }
.meta-v { font-size: 9.5pt; font-weight: 600; color: var(--text); line-height: 1.35; }
.summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6pt; margin-bottom: 14pt; }
.summary-card { border: 0.75pt solid var(--border); border-radius: 4pt; padding: 8pt 9pt; }
.sc-num { font-family: 'JetBrains Mono', monospace; font-size: 15pt; font-weight: 700; }
.sc-label { font-size: 7pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4pt; margin-top: 2pt; }
.legal-box { background: var(--primary-tint); border-radius: 6pt; padding: 10pt 12pt; font-size: 8pt; color: var(--muted); line-height: 1.55; margin-bottom: 14pt; }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
thead th { text-align: left; padding: 6pt 8pt; font-size: 7pt; font-weight: 700; letter-spacing: 0.4pt; text-transform: uppercase; color: var(--muted); border-bottom: 1pt solid var(--border-strong); }
td { padding: 5pt 8pt; border-bottom: 0.5pt solid var(--border); }
.td-date { font-family: 'JetBrains Mono', monospace; }
.td-center { text-align: center; }
tr.tr-conf { background: var(--destructive-bg); }
tr.tr-pending { background: var(--warning-bg); }
.badge-anom { background: var(--destructive); color: white; border-radius: 3pt; padding: 1pt 5pt; font-size: 7pt; font-weight: 700; }
.badge-warn { background: var(--warning); color: white; border-radius: 3pt; padding: 1pt 5pt; font-size: 7pt; font-weight: 700; }
.footnote { font-size: 7pt; color: var(--muted-2); margin-top: 10pt; line-height: 1.5; }
</style></head><body>
<div class="doc">
  <div class="doc-eyebrow">Relazione tecnica caldo cantiere</div>
  <div class="doc-title">Relazione Tecnica Caldo Cantiere</div>
  <div class="doc-title-rule"></div>

  <div class="meta-grid">
    <div><div class="meta-k">Cantiere</div><div class="meta-v">${esc(site.name)}</div></div>
    <div><div class="meta-k">Committente</div><div class="meta-v">${esc(site.client) || '—'}</div></div>
    <div><div class="meta-k">Periodo</div><div class="meta-v">${period}</div></div>
    <div><div class="meta-k">Generato il</div><div class="meta-v">${esc(nowStr)}</div></div>
    ${site.address ? `<div style="grid-column:1/-1;"><div class="meta-k">Indirizzo cantiere</div><div class="meta-v">${esc(site.address)}</div></div>` : ''}
  </div>

  <div class="summary-grid">
    <div class="summary-card"><div class="sc-num">${rows.length}</div><div class="sc-label">Giorni registrati</div></div>
    <div class="summary-card ${redDays > 0 ? 'sc-warn' : ''}"><div class="sc-num">${redDays}</div><div class="sc-label">Giorni bollino rosso</div></div>
    <div class="summary-card ${confirmedDays > 0 ? 'sc-warn' : ''}"><div class="sc-num">${confirmedDays}</div><div class="sc-label">Sospensioni confermate</div></div>
    <div class="summary-card"><div class="sc-num">Worklimate</div><div class="sc-label">Fonte ufficiale</div></div>
  </div>

  <table>
    <thead><tr>
      <th>Data</th><th class="td-center">Livello Worklimate</th><th class="td-center">Comune</th>
      <th class="td-center">Sospensione</th><th>Riferimento ricerca</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>

  <div class="legal-box">
    Il livello di rischio riportato è quello <strong>pubblicato da Worklimate</strong> (progetto INAIL-CNR, indice WBGT ISO 7243), la fonte citata dalle ordinanze comunali/regionali per lo stop cantieri nei giorni di "bollino rosso" — verde (nullo), giallo (basso), arancione (moderato), rosso (alto). Worklimate non espone un'API pubblica: il dato è stato <strong>consultato manualmente</strong> sull'archivio storico ufficiale (archivio.worklimate.it) e trascritto in Palladia, con riferimento alla ricerca di provenienza dove indicato. Riferimenti normativi: D.L. 26/06/2026 n. 107 art. 6, messaggio INPS n. 2418 del 20/07/2026 — sospensioni tra il 1° luglio e il 31 dicembre 2026 per imprese edili, settore lapideo, escavazione.
  </div>

  <div class="footnote">Documento generato automaticamente da Palladia a supporto della relazione tecnica richiesta dalla normativa — non sostituisce la valutazione firmata dal datore di lavoro/RSPP, che resta responsabile della decisione finale di sospendere i lavori.</div>
</div>
</body></html>`;
}

function generateHeatReportXlsx({ site, rows, from, to }) {
  const wb = new ExcelJS.Workbook();
  const FONT = 'Calibri';
  function metaRow(ws, label, value) {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { name: FONT, size: 10, bold: true, color: { argb: MUTED } };
    r.getCell(2).font = { name: FONT, size: 10, color: { argb: TEXT } };
    r.height = 16;
    return r;
  }

  const minRowDate = rows.length ? rows[0].log_date : null;
  const maxRowDate = rows.length ? rows[rows.length - 1].log_date : null;
  const period = (from || minRowDate || '—') + ' → ' + (to || maxRowDate || '—');

  const ws1 = wb.addWorksheet('Riepilogo');
  ws1.properties.defaultRowHeight = 18;
  ws1.getColumn(1).width = 42; ws1.getColumn(2).width = 46;
  ws1.mergeCells('A1:B1');
  const title = ws1.getCell('A1');
  title.value = 'PALLADIA — Relazione Tecnica Caldo Cantiere';
  title.font = { name: FONT, size: 16, bold: true, color: { argb: PRIMARY } };
  ws1.getRow(1).height = 28;
  ws1.addRow([]);

  metaRow(ws1, 'Cantiere', site.name || '—');
  if (site.address) metaRow(ws1, 'Indirizzo', site.address);
  if (site.client) metaRow(ws1, 'Committente', site.client);
  metaRow(ws1, 'Periodo', period);
  metaRow(ws1, 'Fonte', 'Worklimate (archivio.worklimate.it) — inserimento manuale, nessuna API pubblica');
  ws1.addRow([]);
  metaRow(ws1, 'Giorni registrati', rows.length);
  metaRow(ws1, 'Giorni bollino rosso', rows.filter(r => r.risk_level === 'rosso').length);
  metaRow(ws1, 'Sospensioni confermate', rows.filter(r => r.suspension_confirmed).length);
  ws1.addRow([]);

  const legalRow = ws1.addRow(['Riferimenti normativi']);
  legalRow.getCell(1).font = { name: FONT, size: 11, bold: true, color: { argb: PRIMARY } };
  const legalNote = ws1.addRow(['D.L. 26/06/2026 n. 107 art. 6, messaggio INPS n. 2418 del 20/07/2026. Livello di rischio: fonte ufficiale Worklimate (INAIL-CNR, WBGT ISO 7243), trascritto manualmente dall\'archivio storico — nessuna API pubblica disponibile.']);
  legalNote.getCell(1).font = { name: FONT, size: 9, color: { argb: MUTED } };
  legalNote.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  ws1.mergeCells(`A${legalNote.number}:B${legalNote.number}`);
  ws1.getRow(legalNote.number).height = 45;

  const ws2 = wb.addWorksheet('Dettaglio');
  ws2.columns = [
    { header: 'Data', key: 'date', width: 14 },
    { header: 'Livello Worklimate', key: 'level', width: 20 },
    { header: 'Comune', key: 'comune', width: 20 },
    { header: 'Sospensione', key: 'susp', width: 16 },
    { header: 'Riferimento ricerca', key: 'note', width: 34 },
  ];
  ws2.getRow(1).eachCell(c => {
    c.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIMARY } };
  });
  for (const r of rows) {
    const isPending = r.risk_level === 'rosso' && !r.suspension_confirmed && !r.suspension_dismissed;
    const susp = r.suspension_confirmed ? 'SOSPESO' : r.suspension_dismissed ? 'Ignorato' : isPending ? 'Da confermare' : '—';
    const row = ws2.addRow({
      date: r.log_date, level: LEVEL_LABEL[r.risk_level] || r.risk_level, comune: r.comune || '—',
      susp, note: r.source_note || '—',
    });
    row.font = { name: FONT, size: 10 };
    if (r.suspension_confirmed) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FBF0EE' } }; });
  }

  return wb;
}

module.exports = { generateHeatReportHtml, generateHeatReportXlsx };
