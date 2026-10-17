'use strict';
// ── Conti dei sub: PDF del conto approvato ed Excel (F-360) ──────────────────
// Il PDF è quello che il tecnico manda al sub: la cifra da fatturare e, riga per
// riga, cosa è stato corretto e perché. L'Excel è per chi vuole tenere il suo file.
const ExcelJS = require('exceljs');
const supabase = require('./supabase');
const { renderHtmlToPdf } = require('../pdf-renderer');
const { euro } = require('./daPagare');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = (n) => Number(n || 0).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const quando = (iso) => new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const giorno = (g) => new Date(`${g}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Ore per persona: giornate, ore del foglio, ore riconosciute. */
function orePerPersona(d) {
  const per = new Map();
  for (const r of d.ore) {
    const p = per.get(r.persona) || { persona: r.persona, foglio: 0, approvate: 0, giorni: 0 };
    p.foglio += r.oreFoglio; p.approvate += r.oreApprovate ?? 0; if (r.giorno) p.giorni++;
    per.set(r.persona, p);
  }
  return [...per.values()];
}

/** Le correzioni a parole: solo dove il tecnico non ha tenuto il valore del foglio. */
function correzioni(d) {
  const out = [];
  if (d.tariffa.testo && d.tariffa.decisione === 'proposta' && d.tariffa.foglio != null) out.push(`Tariffa oraria: ${euro(d.tariffa.approvata)}/h invece di ${euro(d.tariffa.foglio)}/h`);
  for (const r of d.ore) {
    if (!r.problema || r.decisione !== 'proposta') continue;
    const chi = `${r.giorno ? `${giorno(r.giorno)}, ` : ''}${r.persona}`;
    out.push(r.problema === 'non_entrato'
      ? `${chi}: ${n2(r.oreFoglio)} ore non riconosciute (nessun ingresso registrato in cantiere)`
      : `${chi}: riconosciute ${n2(r.oreApprovate)} ore invece di ${n2(r.oreFoglio)} (ore registrate in cantiere)`);
  }
  for (const r of d.misura) {
    if (!r.problema || r.decisione !== 'proposta' || !r.approvato) continue;
    if (r.problema === 'prezzo_diverso') out.push(`${r.voce}: ${euro(r.approvato.prezzo)}${r.unita ? `/${r.unita}` : ''} come nei mesi precedenti, invece di ${euro(r.prezzo)}`);
    if (r.problema === 'oltre_contratto') out.push(`${r.voce}: riconosciuti ${n2(r.approvato.quantita)} ${r.unita || ''} invece di ${n2(r.quantita)}, fino alla quantità del contratto (${n2(r.contratto)} ${r.unita || ''})`);
  }
  if (d.totali.sommaSbagliata) out.push(`Totale del foglio ${euro(d.totali.totaleScritto)}: la somma delle righe fa ${euro(d.totali.sommaFoglio)}`);
  return out;
}

async function nomeAzienda(companyId) {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  return data?.name || '';
}

function htmlConto(d, azienda) {
  const persone = orePerPersona(d);
  const corr = correzioni(d);
  const t = d.totali;
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
  @page{size:A4;margin:16mm 16mm 18mm}
  *{box-sizing:border-box}
  body{font-family:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif;color:#1A1714;font-size:10.5pt;line-height:1.45;margin:0}
  .testa{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #22384F;padding-bottom:10px;margin-bottom:14px}
  .testa h1{font-size:19pt;margin:0;color:#22384F;letter-spacing:-.01em}
  .testa .az{font-weight:700;font-size:11pt;text-align:right}
  .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
  .meta div{background:#F6F4F0;border-radius:6px;padding:8px 10px}
  .meta span{display:block;font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#7A736A;font-weight:700}
  .meta b{font-size:11pt}
  .totale{display:flex;justify-content:space-between;align-items:center;background:#22384F;color:#fff;border-radius:8px;padding:12px 16px;margin:4px 0 18px}
  .totale span{font-size:10pt;opacity:.85}
  .totale b{font-size:20pt;font-variant-numeric:tabular-nums}
  h2{font-size:10pt;text-transform:uppercase;letter-spacing:.07em;color:#7A736A;margin:16px 0 6px}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th{font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:#7A736A;text-align:left;border-bottom:1px solid #D9D3CA;padding:5px 4px}
  td{padding:6px 4px;border-bottom:1px solid #ECE7DF}
  .r{text-align:right}
  tfoot td{font-weight:800;border-bottom:0;border-top:1.5px solid #1A1714}
  .barrato{text-decoration:line-through;color:#9C948A;font-weight:400;margin-right:6px}
  .corr{background:#FDF3E8;border-radius:6px;padding:10px 12px}
  .corr li{margin:3px 0}
  .firma{margin-top:22px;font-size:9.5pt;color:#7A736A}
  </style></head><body>
  <div class="testa"><div><h1>Conto approvato</h1><div style="color:#7A736A;margin-top:2px">${esc(d.meseTesto)}</div></div><div class="az">${esc(azienda)}</div></div>
  <div class="meta">
    <div><span>Impresa</span><b>${esc(d.impresa.nomeFoglio)}</b></div>
    <div><span>Cantiere</span><b>${esc(d.cantiere?.nome || '')}</b></div>
    <div><span>Mese</span><b>${esc(d.meseTesto)}</b></div>
  </div>
  <div class="totale"><span>Importo approvato da fatturare</span><b>${euro(d.approvato?.totale ?? t.totale)}</b></div>
  ${persone.length ? `<h2>Ore · <span style="text-transform:none">${euro(t.tariffa)}/h</span></h2>
  <table><thead><tr><th>Persona</th><th class="r">Giorni</th><th class="r">Ore nel foglio</th><th class="r">Ore riconosciute</th><th class="r">Importo</th></tr></thead><tbody>
  ${persone.map(p => `<tr><td>${esc(p.persona)}</td><td class="r">${p.giorni || '—'}</td><td class="r">${n2(p.foglio)}</td><td class="r"><b>${n2(p.approvate)}</b></td><td class="r">${euro(p.approvate * (t.tariffa || 0))}</td></tr>`).join('')}
  </tbody><tfoot><tr><td>Totale · ${esc(t.giornateTesto)}</td><td></td><td class="r">${n2(t.oreFoglio)}</td><td class="r">${n2(t.ore)}</td><td class="r">${euro(t.oreImporto)}</td></tr></tfoot></table>` : ''}
  ${d.misura.length ? `<h2>Lavori a misura</h2>
  <table><thead><tr><th>Voce</th><th class="r">Quantità</th><th class="r">Prezzo</th><th class="r">Importo</th></tr></thead><tbody>
  ${d.misura.map(r => {
    const a = r.approvato || { quantita: r.quantita, prezzo: r.prezzo, importo: 0 };
    const qDiv = a.quantita !== r.quantita, pDiv = r.prezzo != null && a.prezzo !== r.prezzo;
    return `<tr><td>${esc(r.voce)}</td><td class="r">${qDiv ? `<span class="barrato">${n2(r.quantita)}</span>` : ''}${n2(a.quantita)} ${esc(r.unita || '')}</td><td class="r">${pDiv ? `<span class="barrato">${euro(r.prezzo)}</span>` : ''}${euro(a.prezzo)}</td><td class="r">${euro(a.importo)}</td></tr>`;
  }).join('')}
  </tbody><tfoot><tr><td colspan="3">Totale lavori a misura</td><td class="r">${euro(t.misuraImporto)}</td></tr></tfoot></table>` : ''}
  ${corr.length ? `<h2>Correzioni rispetto al vostro foglio</h2><div class="corr"><ul style="margin:0;padding-left:16px">${corr.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
  <p class="firma">Approvato${d.approvato?.da ? ` da ${esc(d.approvato.da)}` : ''}${d.approvato?.il ? ` il ${esc(quando(d.approvato.il))}` : ''} per ${esc(azienda)}${/\.$/.test(azienda) ? '' : '.'} Il vostro foglio richiedeva ${euro(t.chiesto)}.</p>
  </body></html>`;
}

async function pdfConto(companyId, d) {
  const html = htmlConto(d, await nomeAzienda(companyId));
  return renderHtmlToPdf(html, { noHeaderFooter: true, margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' } });
}

async function excelConto(companyId, d) {
  const azienda = await nomeAzienda(companyId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  const ws = wb.addWorksheet('Conto');
  ws.columns = [{ width: 34 }, { width: 14 }, { width: 16 }, { width: 16 }, { width: 16 }];
  ws.addRow([`Conto ${d.stato === 'approvato' ? 'approvato' : 'da controllare'} · ${d.meseTesto}`]).font = { bold: true, size: 14 };
  ws.addRow([`${d.impresa.nomeFoglio} · ${d.cantiere?.nome || ''} · per ${azienda}`]);
  ws.addRow([]);
  const fmtE = '#,##0.00 "€"';
  if (d.ore.length) {
    ws.addRow(['Ore', 'Giorno', 'Ore nel foglio', 'Ore in cantiere', 'Ore riconosciute']).font = { bold: true };
    for (const r of d.ore) ws.addRow([r.persona, r.giorno ? new Date(`${r.giorno}T12:00:00Z`) : '', r.oreFoglio, r.oreIngressi, r.oreApprovate]);
    ws.addRow(['Totale ore', '', d.totali.oreFoglio, '', d.totali.ore]).font = { bold: true };
    const tr = ws.addRow(['Tariffa oraria', '', '', '', d.totali.tariffa]); tr.getCell(5).numFmt = fmtE;
    const ti = ws.addRow(['Importo ore', '', '', '', d.totali.oreImporto]); ti.font = { bold: true }; ti.getCell(5).numFmt = fmtE;
    ws.addRow([]);
  }
  if (d.misura.length) {
    ws.addRow(['Lavori a misura', 'Unità', 'Quantità', 'Prezzo', 'Importo']).font = { bold: true };
    for (const r of d.misura) {
      const a = r.approvato || { quantita: r.quantita, prezzo: r.prezzo, importo: null };
      const row = ws.addRow([r.voce, r.unita || '', a.quantita, a.prezzo, a.importo]);
      row.getCell(4).numFmt = fmtE; row.getCell(5).numFmt = fmtE;
    }
    const tm = ws.addRow(['Totale lavori a misura', '', '', '', d.totali.misuraImporto]); tm.font = { bold: true }; tm.getCell(5).numFmt = fmtE;
    ws.addRow([]);
  }
  const tot = ws.addRow([d.stato === 'approvato' ? 'Importo approvato' : 'Totale', '', '', '', d.approvato?.totale ?? d.totali.totale]);
  tot.font = { bold: true, size: 12 }; tot.getCell(5).numFmt = fmtE;
  ws.getColumn(2).numFmt = 'dd/mm/yyyy';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { pdfConto, excelConto, htmlConto, correzioni };
