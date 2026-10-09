'use strict';
// ── Foglio mensile per il consulente del lavoro (F-265) ─────────────────────
// PDF (HTML → Puppeteer) ed Excel dallo stesso riepilogo di lib/oreMese.js.

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const DOW = ['do', 'lu', 'ma', 'me', 'gi', 've', 'sa'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const h = (min) => (min > 0 ? `${Math.floor(min / 60)}${min % 60 ? `:${String(min % 60).padStart(2, '0')}` : ''} h` : '—');
const gg = (n) => (n > 0 ? `${n} gg` : '—');

function meseLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MESI[m - 1].charAt(0).toUpperCase()}${MESI[m - 1].slice(1)} ${y}`;
}

/** Codice breve della cella giorno, come nella pagina "Ore e assenze". */
function cellCode(c) {
  const hh = (min) => (min % 60 ? (min / 60).toFixed(1).replace('.', ',') : String(min / 60));
  switch (c.tipo) {
    case 'ferie': return 'F';
    case 'malattia': return 'M';
    case 'altro': return 'A';
    case 'giustificare': return '?';
    case 'festivo': return 'FS';
    case 'weekend': return '';
    case 'permesso': return 'P';
    case 'maltempo': return 'T'; // F-318: giornata di pioggia senza timbrature
    case 'lavoro': {
      let s = hh(c.ore);
      if (c.maltempoMin) s += ' T';
      if (c.permessoMin) s += ' P';
      if (c.malattiaMin) s += ' M';
      if (c.infortunioMin) s += ' I';
      return s;
    }
    default: return '';
  }
}

function totalsRow(l) {
  const t = l.tot;
  return [h(t.ordinarieMin), h(t.straordMin), gg(t.ferieGiorni), h(t.permessoMin), t.malattiaGiorni ? gg(t.malattiaGiorni) : h(t.malattiaMin), h(t.maltempoMin), h(t.infortunioMin || 0), t.daGiustificare ? `${t.daGiustificare} g` : '—'];
}

function generateFoglioHtml(data, companyName) {
  const cols = ['Ordinarie', 'Straord.', 'Ferie', 'Permessi', 'Malattia', 'Maltempo', 'Infortunio', 'Da giust.'];
  const sum = (k) => data.lavoratori.reduce((s, l) => s + (l.tot[k] || 0), 0);
  const grand = [h(sum('ordinarieMin')), h(sum('straordMin')), gg(sum('ferieGiorni')), h(sum('permessoMin')), sum('malattiaGiorni') ? gg(sum('malattiaGiorni')) : h(sum('malattiaMin')), h(sum('maltempoMin')), h(sum('infortunioMin')), sum('daGiustificare') ? `${sum('daGiustificare')} g` : '—'];
  const note = [];
  for (const a of data.assenze) {
    const nome = data.lavoratori.find(l => l.id === a.worker_id)?.nome || '';
    const per = a.date_from === a.date_to ? a.date_from.split('-').reverse().join('/') : `${a.date_from.split('-').reverse().join('/')}–${a.date_to.split('-').reverse().join('/')}`;
    const ore = a.ora_dalle && a.ora_alle ? ` ${a.ora_dalle.slice(0, 5)}–${a.ora_alle.slice(0, 5)}` : '';
    note.push(`${esc(nome)}: ${esc(a.tipo)} ${per}${ore}${a.protocollo ? ` · protocollo certificato ${esc(a.protocollo)}` : ''}${a.note ? ` · ${esc(a.note)}` : ''}`);
  }
  const giust = data.lavoratori.filter(l => l.tot.daGiustificare).map(l => `${esc(l.nome)}: ${l.cells.filter(c => c.tipo === 'giustificare').map(c => c.date.slice(8)).join(', ')}`);

  const dayHead = data.days.map(d => `<th class="d ${d.weekend || d.festivo ? 'we' : ''}">${d.day}<br><span>${DOW[d.dow]}</span></th>`).join('');
  const grid = data.lavoratori.map(l => `<tr><td class="n">${esc(l.nome)}</td>${l.cells.map((c, i) => {
    const d = data.days[i];
    const cls = c.tipo === 'giustificare' ? 'gi' : c.tipo === 'ferie' ? 'fe' : c.tipo === 'malattia' ? 'ma' : c.tipo === 'maltempo' ? 'mt' : (d.weekend || d.festivo) ? 'we' : c.straord ? 'st' : '';
    return `<td class="d ${cls}">${esc(cellCode(c))}</td>`;
  }).join('')}</tr>`).join('');

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 14mm 10mm; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1A1714; font-size: 9pt; }
  h1 { font-size: 16pt; margin: 0 0 2pt; } .sub { color: #6E675E; margin: 0 0 10pt; }
  table { border-collapse: collapse; width: 100%; }
  .tot th, .tot td { padding: 5pt 6pt; border-bottom: 0.5pt solid #D6D0C6; text-align: right; }
  .tot th:first-child, .tot td:first-child { text-align: left; } .tot tr.g td { font-weight: 700; border-bottom: 0; }
  .grid { margin-top: 12pt; font-size: 7pt; } .grid th, .grid td { border: 0.4pt solid #E2DDD4; padding: 2pt 1pt; text-align: center; }
  .grid th.d span { font-weight: 400; color: #6E675E; } .grid td.n { text-align: left; padding-left: 4pt; white-space: nowrap; font-weight: 600; }
  .we { background: #F3F0EB; color: #9A9184; } .st { background: #E3E8EF; font-weight: 700; } .fe { background: #E4EEE7; } .ma { background: #F6E3E0; } .mt { background: #E3EDF6; } .gi { background: #A8453B; color: #fff; font-weight: 700; }
  .leg { margin-top: 6pt; color: #4D4740; font-size: 7.5pt; } .note { margin-top: 10pt; line-height: 1.5; } .note b { display: block; margin-bottom: 2pt; }
  </style></head><body>
  <h1>Riepilogo presenze per le buste paga — ${esc(meseLabel(data.month))}</h1>
  <p class="sub">${esc(companyName)} · ${data.lavoratori.length} lavoratori · ${data.giorniLavorativi} giorni lavorativi · straordinario oltre ${data.regole.oreGiornoMin / 60} ore al giorno</p>
  <table class="tot"><thead><tr><th>Lavoratore</th>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>
  ${data.lavoratori.map(l => `<tr><td>${esc(l.nome)}</td>${totalsRow(l).map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}
  <tr class="g"><td>Totale</td>${grand.map(v => `<td>${v}</td>`).join('')}</tr></tbody></table>
  <table class="grid"><thead><tr><th>Giorno per giorno</th>${dayHead}</tr></thead><tbody>${grid}</tbody></table>
  <div class="leg">Numero = ore lavorate · T maltempo · P permesso · F ferie · M malattia · I infortunio · A altra assenza · FS festivo · ? da giustificare (nessuna timbratura e nessuna assenza) · in evidenza i giorni con straordinario</div>
  ${note.length ? `<div class="note"><b>Assenze registrate</b>${note.join('<br>')}</div>` : ''}
  ${giust.length ? `<div class="note"><b>Giorni da giustificare</b>${giust.join('<br>')}</div>` : ''}
  </body></html>`;
}

async function generateFoglioXlsx(data, companyName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  const s1 = wb.addWorksheet('Riepilogo');
  s1.addRow([`Riepilogo presenze — ${meseLabel(data.month)} — ${companyName}`]).font = { bold: true, size: 13 };
  s1.addRow([]);
  const head = s1.addRow(['Lavoratore', 'Ore ordinarie', 'Ore straordinarie', 'Giorni ferie', 'Ore permesso', 'Giorni malattia', 'Ore malattia (parziale)', 'Ore maltempo', 'Ore infortunio', 'Giorni da giustificare']);
  head.font = { bold: true };
  for (const l of data.lavoratori) {
    const t = l.tot;
    s1.addRow([l.nome, t.ordinarieMin / 60, t.straordMin / 60, t.ferieGiorni, t.permessoMin / 60, t.malattiaGiorni, t.malattiaMin / 60, t.maltempoMin / 60, (t.infortunioMin || 0) / 60, t.daGiustificare]);
  }
  s1.columns.forEach((c, i) => { c.width = i === 0 ? 28 : 16; });

  const s2 = wb.addWorksheet('Giorno per giorno');
  s2.addRow(['Lavoratore', ...data.days.map(d => `${d.day} ${DOW[d.dow]}`)]).font = { bold: true };
  for (const l of data.lavoratori) s2.addRow([l.nome, ...l.cells.map(cellCode)]);
  s2.getColumn(1).width = 28;

  const s3 = wb.addWorksheet('Assenze');
  s3.addRow(['Lavoratore', 'Tipo', 'Dal', 'Al', 'Dalle', 'Alle', 'Protocollo certificato', 'Note']).font = { bold: true };
  for (const a of data.assenze) {
    s3.addRow([data.lavoratori.find(l => l.id === a.worker_id)?.nome || '', a.tipo, a.date_from, a.date_to, a.ora_dalle?.slice(0, 5) || '', a.ora_alle?.slice(0, 5) || '', a.protocollo || '', a.note || '']);
  }
  s3.columns.forEach((c) => { c.width = 18; });
  return wb.xlsx.writeBuffer();
}

module.exports = { generateFoglioHtml, generateFoglioXlsx, cellCode, meseLabel };
