'use strict';
/**
 * lib/contratti/documento.js — F-398: l'HTML del contratto di subappalto, per
 * il PDF (pdf-renderer.js, header e footer di sempre).
 *
 * Stessa veste del contratto di luglio (Georgia, articoli numerati, tabella
 * prezzi, firme affiancate), più la doppia firma degli artt. 1341-1342 c.c.
 * per le clausole che la richiedono. I testi vengono da ./clausole.js.
 */
const { articoli, euro } = require('./clausole');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oggiLungo = () => new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' });

// Le clausole da approvare specificamente (artt. 1341-1342 c.c.)
const DA_APPROVARE = ['Pagamenti', 'Tempi', 'Regolarità contributiva e retributiva', 'Risoluzione e recesso', 'Foro competente'];

function parte(p, ruolo) {
  const dati = [
    `con sede legale in ${esc(p.sede)}`,
    `P.IVA ${esc(p.piva)}`,
    p.codiceFiscale && p.codiceFiscale !== p.piva ? `C.F. ${esc(p.codiceFiscale)}` : null,
    p.rea ? `REA ${esc(p.rea)}` : null,
  ].filter(Boolean).join(', ');
  return `<div class="party-name">${esc(p.ragioneSociale)}</div>
    <div>${dati}, in persona del legale rappresentante ${esc(p.legaleRappresentante)} (di seguito «${ruolo}»)</div>`;
}

function tabella(t) {
  if (t.vuota) {
    const righe = Array.from({ length: t.vuota }, () => '<tr><td>&nbsp;</td><td></td><td></td><td></td></tr>').join('');
    return `<table class="voci"><thead><tr><th>Lavorazione</th><th class="num">U.M.</th><th class="num">Quantità</th><th class="num">Prezzo unitario</th></tr></thead><tbody>${righe}</tbody></table>`;
  }
  const righe = t.voci.map(v => `<tr><td>${esc(v.descrizione)}</td><td class="num">${esc(v.um || '')}</td><td class="num">${Number(v.quantita).toLocaleString('it-IT')}</td><td class="num">${euro(v.prezzo)}</td><td class="num">${euro(v.importo)}</td></tr>`).join('');
  return `<table class="voci"><thead><tr><th>Lavorazione</th><th class="num">U.M.</th><th class="num">Quantità</th><th class="num">Prezzo unitario</th><th class="num">Importo</th></tr></thead>
    <tbody>${righe}<tr class="tot"><td colspan="4">Totale presunto</td><td class="num">${euro(t.totale)}</td></tr></tbody></table>`;
}

function contrattoHtml(d, scelte) {
  const arts = articoli(d, scelte);
  const pubblico = scelte?.pubblico === 'si';
  const approvare = arts.filter(a => DA_APPROVARE.includes(a.titolo)).map(a => `art. ${a.n} (${a.titolo})`).join(', ');
  const corpo = arts.map(a => `
    <div class="article">
      <div class="article-title"><span class="article-num">Art. ${a.n}</span> — ${esc(a.titolo)}</div>
      ${a.testo.map(p => `<p class="article-body">${esc(p)}</p>`).join('')}
      ${a.tabella ? tabella(a.tabella) : ''}
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 26mm 0 24mm 0; }
  body { font-family: Georgia, 'Times New Roman', 'Liberation Serif', serif; font-size: 11px; color: #1a1a1a; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc { padding: 0 18mm; }
  .note { margin-bottom: 18px; font-family: Arial, Helvetica, sans-serif; font-size: 8px; font-style: italic; line-height: 1.5; color: #8a8a8a; }
  .title { text-align: center; font-size: 16px; font-weight: 700; letter-spacing: 0.4px; margin-bottom: 4px; }
  .subtitle { text-align: center; font-size: 9.5px; font-style: italic; color: #555; margin-bottom: 4px; }
  .place { text-align: center; font-size: 10px; color: #333; margin-bottom: 22px; }
  .parties { line-height: 1.65; }
  .parties .between { margin: 10px 0 4px; }
  .party-name { font-weight: 700; margin-bottom: 2px; }
  .convene { font-weight: 700; text-align: center; margin: 18px 0 22px; letter-spacing: 0.2px; }
  .article { margin-bottom: 13px; page-break-inside: avoid; }
  .article-title { font-weight: 700; font-size: 11px; margin-bottom: 4px; }
  .article-num { display: inline-block; min-width: 44px; }
  .article-body { font-size: 10.5px; line-height: 1.65; color: #222; margin-bottom: 4px; }
  table.voci { width: 100%; border-collapse: collapse; font-size: 9.5px; margin-top: 8px; font-family: Arial, Helvetica, sans-serif; }
  table.voci th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.2px; color: #777; padding: 4px 6px; border-bottom: 1px solid #999; }
  table.voci th.num, table.voci td.num { text-align: right; }
  table.voci td { padding: 6px; border-bottom: 1px solid #e6e6e6; color: #222; height: 22px; }
  table.voci tr.tot td { font-weight: 700; border-top: 1.5px solid #000; border-bottom: none; color: #000; }
  .signatures { margin-top: 34px; page-break-inside: avoid; }
  .signatures-label { font-weight: 700; text-align: center; margin-bottom: 26px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
  .role { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px; color: #777; font-family: Arial, Helvetica, sans-serif; margin-bottom: 3px; }
  .who { font-weight: 700; margin-bottom: 34px; }
  .line { border-top: 1px solid #333; padding-top: 4px; font-size: 8.5px; color: #777; font-family: Arial, Helvetica, sans-serif; }
  .approval { margin-top: 30px; page-break-inside: avoid; font-size: 10.5px; line-height: 1.65; }
  .approval .line { width: 50%; margin: 34px 0 0 auto; }
</style>
</head>
<body>
<div class="doc">
  <div class="note">Bozza preparata con Palladia sulla base dei dati inseriti dalle Parti. Prima della firma fatela verificare dal vostro consulente o legale di fiducia.</div>
  <div class="title">CONTRATTO DI SUBAPPALTO</div>
  <div class="subtitle">${pubblico ? 'ai sensi dell\'art. 119 del D.Lgs. 36/2023' : 'per lavori privati, ai sensi degli artt. 1655 e seguenti del Codice Civile'}</div>
  <div class="place">${esc(d.luogo || d.affidataria.citta || '')}${d.luogo || d.affidataria.citta ? ', ' : ''}${oggiLungo()}</div>

  <div class="parties">
    <div>TRA</div>
    ${parte(d.affidataria, 'Impresa Affidataria')}
    <div class="between">E</div>
    ${parte(d.subappaltatrice, 'Subappaltatrice')}
    <div class="convene">SI CONVIENE E STIPULA QUANTO SEGUE</div>
  </div>

  ${corpo}

  <div class="signatures">
    <div class="signatures-label">Letto, confermato e sottoscritto</div>
    <div class="grid">
      <div><div class="role">Impresa Affidataria</div><div class="who">${esc(d.affidataria.ragioneSociale)}</div><div class="line">Data, timbro e firma</div></div>
      <div><div class="role">Subappaltatrice</div><div class="who">${esc(d.subappaltatrice.ragioneSociale)}</div><div class="line">Data, timbro e firma</div></div>
    </div>
  </div>

  <div class="approval">
    Ai sensi e per gli effetti degli artt. 1341 e 1342 c.c., la Subappaltatrice dichiara di approvare specificamente i seguenti articoli: ${esc(approvare)}.
    <div class="line">La Subappaltatrice — firma</div>
  </div>
</div>
</body>
</html>`;
}

module.exports = { contrattoHtml, DA_APPROVARE };
