'use strict';
/**
 * lib/impreseDichiarazione.js — F-376 (AUDIT.md del frontend): la dichiarazione la prepara Palladia.
 *
 * D.Lgs. 81/2008, allegato XVII, punto 1, lettera e): l'impresa esecutrice
 * dichiara di non essere oggetto di provvedimenti di sospensione o interdittivi
 * di cui all'art. 14. Il modulo esce già compilato coi dati dell'impresa,
 * dell'impresa principale e dei cantieri: all'impresa resta solo da firmarlo e
 * ricaricarlo (dal link). PDF semplice con pdf-lib: non tocca la catena dei
 * PDF Puppeteer (intestazioni e piè di pagina di POS e verbali).
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const vuoto = '______________________________';
// Helvetica standard: solo caratteri WinAnsi (gli accenti italiani ci sono)
const PUNTEGGIATURA = [8211, 8212, 8216, 8217, 8220, 8221]; // – — ‘ ’ “ ”
const piano = (s) => [...String(s || '')].filter(ch => { const c = ch.codePointAt(0); return (c >= 32 && c <= 126) || (c >= 161 && c <= 255) || PUNTEGGIATURA.includes(c); }).join('');

function righe(testo, font, size, larghezza) {
  const out = [];
  for (const par of testo.split('\n')) {
    let riga = '';
    for (const parola of par.split(' ')) {
      const prova = riga ? `${riga} ${parola}` : parola;
      if (font.widthOfTextAtSize(prova, size) > larghezza && riga) { out.push(riga); riga = parola; } else riga = prova;
    }
    out.push(riga);
  }
  return out;
}

/** @param {{ impresa:{nome,piva,indirizzo,referente}, azienda:string, cantieri:{nome,indirizzo}[], oggi?:string }} d */
async function dichiarazionePdf(d) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Dichiarazione art. 14 D.Lgs. 81/2008');
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const M = 56, W = 595.28 - 2 * M;
  let y = 841.89 - 64;
  const scrivi = (t, { f = font, size = 11, dopo = 6 } = {}) => {
    for (const r of righe(piano(t), f, size, W)) { page.drawText(r, { x: M, y, size, font: f, color: rgb(0.1, 0.09, 0.08) }); y -= size * 1.45; }
    y -= dopo;
  };
  const cantieri = (d.cantieri || []).map(c => [c.nome, c.indirizzo].filter(Boolean).join(' - ')).join('; ');

  scrivi('DICHIARAZIONE SOSTITUTIVA', { f: bold, size: 15, dopo: 2 });
  scrivi('(art. 47 D.P.R. 445/2000 - D.Lgs. 81/2008, allegato XVII, punto 1, lettera e)', { size: 10, dopo: 18 });
  scrivi(`Il/La sottoscritto/a ${d.impresa.referente || vuoto}, in qualità di legale rappresentante dell'impresa`);
  scrivi(`${d.impresa.nome || vuoto}`, { f: bold, size: 12 });
  scrivi(`con sede in ${d.impresa.indirizzo || vuoto}, partita IVA ${d.impresa.piva || vuoto},`);
  scrivi(`impresa esecutrice per conto di ${d.azienda}${cantieri ? ` nei cantieri: ${cantieri}` : ''},`, { dopo: 12 });
  scrivi('consapevole delle sanzioni penali previste dall\'art. 76 del D.P.R. 445/2000 per le dichiarazioni mendaci,', { dopo: 8 });
  scrivi('DICHIARA', { f: bold, size: 13, dopo: 8 });
  scrivi('che l\'impresa non è oggetto di provvedimenti di sospensione o interdittivi di cui all\'art. 14 del D.Lgs. 81/2008.', { dopo: 28 });
  scrivi(`Luogo e data: ${vuoto}`, { dopo: 30 });
  scrivi(`Firma del legale rappresentante: ${vuoto}`, { dopo: 30 });
  scrivi('Allegare copia di un documento d\'identità di chi firma.', { size: 9.5, dopo: 4 });
  scrivi('Modulo preparato da Palladia: firmalo e ricaricalo dal link che hai ricevuto.', { size: 9.5 });
  return Buffer.from(await pdf.save());
}

module.exports = { dichiarazionePdf };
