'use strict';
/**
 * lib/estrattoConto/leggi.js — F-513 (AUDIT.md del frontend, 18/11/2026).
 *
 * Legge l'estratto conto che il titolare scarica dalla sua banca (Excel o CSV)
 * e ne tira fuori i movimenti: { data, importo, descrizione } (importo negativo
 * = uscita). Ogni banca scrive i movimenti a modo suo: qui si cerca da soli la
 * riga delle intestazioni e si riconoscono le colonne per nome (Data contabile,
 * Importo, Dare/Avere, Entrate/Uscite, Addebiti/Accrediti, Descrizione, Causale…).
 *
 * Niente IA: i movimenti della banca non escono dal server. Il PDF non si legge:
 * si chiede di scaricare l'Excel (quasi tutte le banche lo permettono).
 */
const ExcelJS = require('exceljs');

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Nomi delle colonne, dal più preciso al più generico
const COLONNE = {
  dataContabile: [/^data (contabile|registrazione|operazione|contabilizzazione)$/, /^contabilizzazione$/, /^data$/],
  dataValuta: [/^data valuta$/, /^valuta$/],
  importo: [/^importo( \(?euro?\)?| in euro)?$/, /^importo operazione$/, /^ammontare$/],
  uscita: [/^(dare|uscite?|addebiti?|importo dare|addebito)( \(?euro?\)?)?$/],
  entrata: [/^(avere|entrate?|accrediti?|importo avere|accredito)( \(?euro?\)?)?$/],
  descrizione: [/^descrizione( operazione| operazioni| movimento)?$/, /^causale( descrizione)?$/, /^dettagli$/, /^operazione$/, /^note$/, /^beneficiario$/, /^ordinante$/],
};

function trovaColonna(intestazioni, chiave) {
  for (const re of COLONNE[chiave]) {
    const i = intestazioni.findIndex(h => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

/** Riga delle intestazioni: la prima (entro 40) con una data e un importo riconoscibili. */
function trovaIntestazioni(righe) {
  for (let r = 0; r < Math.min(righe.length, 40); r++) {
    const h = righe[r].map(norm);
    const data = trovaColonna(h, 'dataContabile') >= 0 || trovaColonna(h, 'dataValuta') >= 0;
    const soldi = trovaColonna(h, 'importo') >= 0 || (trovaColonna(h, 'uscita') >= 0 && trovaColonna(h, 'entrata') >= 0);
    if (data && soldi) return r;
  }
  return -1;
}

/** «1.234,56» «-1.234,56» «1234.56» «€ 12,00» «12,00-» → numero (puro). */
function importoItaliano(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[€\s]|EUR/gi, '').trim();
  if (!s) return null;
  let segno = 1;
  if (/^\(.*\)$/.test(s)) { segno = -1; s = s.slice(1, -1); }
  if (s.endsWith('-')) { segno = -1; s = s.slice(0, -1); }
  if (s.startsWith('-')) { segno *= -1; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(s) || /^\d+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? segno * n : null;
}

/** «18/11/2026» «18-11-26» «2026-11-18» Date → «2026-11-18» (puro). */
function dataIso(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const a = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** Dalle righe (array di celle) ai movimenti (puro). */
function movimentiDaRighe(righe) {
  const r0 = trovaIntestazioni(righe);
  if (r0 < 0) return { errore: 'COLONNE', movimenti: [] };
  const h = righe[r0].map(norm);
  // La data: fra le colonne col nome giusto, la prima che contiene davvero date
  // (in Intesa «Contabilizzazione» dice «CONTABILIZZATO», non è una data)
  const candidate = [...COLONNE.dataContabile, ...COLONNE.dataValuta]
    .flatMap(re => h.map((x, i) => (re.test(x) ? i : -1)).filter(i => i >= 0));
  const corpo = righe.slice(r0 + 1, r0 + 11);
  const colData = candidate.find(i => corpo.some(r => dataIso(r[i]))) ?? -1;
  const c = {
    data: colData,
    importo: trovaColonna(h, 'importo'), uscita: trovaColonna(h, 'uscita'), entrata: trovaColonna(h, 'entrata'),
  };
  // Tutte le colonne di testo che descrivono il movimento (Operazione + Dettagli in Intesa, ecc.)
  const testi = h.map((x, i) => COLONNE.descrizione.some(re => re.test(x)) ? i : -1).filter(i => i >= 0);
  const movimenti = [];
  for (const riga of righe.slice(r0 + 1)) {
    const data = dataIso(riga[c.data]);
    if (!data) continue; // righe di totale, saldo, vuote
    let importo = null;
    if (c.importo >= 0) importo = importoItaliano(riga[c.importo]);
    if (importo == null && (c.uscita >= 0 || c.entrata >= 0)) {
      const u = c.uscita >= 0 ? importoItaliano(riga[c.uscita]) : null;
      const e = c.entrata >= 0 ? importoItaliano(riga[c.entrata]) : null;
      if (u) importo = -Math.abs(u); else if (e) importo = Math.abs(e);
    }
    if (importo == null || importo === 0) continue;
    const descrizione = testi.map(i => String(riga[i] ?? '').trim()).filter(Boolean).join(' · ').slice(0, 500);
    movimenti.push({ data, importo: Math.round(importo * 100) / 100, descrizione });
  }
  return { movimenti };
}

/** CSV con «;» o «,», virgolette comprese (puro). */
function righeCsv(testo) {
  let t = String(testo);
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // il segno invisibile che Excel mette all'inizio dei CSV
  const linee = t.split(/\r?\n/).filter(l => l.trim());
  const prova = linee.slice(0, 40).join('\n');
  const sep = (prova.match(/;/g) || []).length >= (prova.match(/,/g) || []).length / 2 ? ';' : (prova.includes('\t') ? '\t' : ',');
  return linee.map(l => {
    const celle = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { celle.push(cur); cur = ''; }
      else cur += ch;
    }
    celle.push(cur);
    return celle.map(x => x.trim());
  });
}

async function righeExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const righe = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const celle = [];
    row.eachCell({ includeEmpty: true }, (cell, n) => {
      let v = cell.value;
      if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : '');
      celle[n - 1] = v;
    });
    righe.push(celle);
  });
  return righe;
}

/** Il file caricato → { movimenti, errore? }. */
async function leggiEstratto(buffer, nomeFile = '', mime = '') {
  const n = norm(nomeFile);
  if (/\.pdf$/.test(n) || mime === 'application/pdf') return { errore: 'PDF', movimenti: [] };
  if (/\.xls$/.test(n)) return { errore: 'XLS_VECCHIO', movimenti: [] };
  let righe;
  if (/\.xlsx$/.test(n) || /spreadsheetml/.test(mime)) righe = await righeExcel(buffer);
  else {
    // Molte banche salvano i CSV in Windows-1252: se l'UTF-8 dà caratteri rotti (U+FFFD) si rilegge in latin1
    const utf8 = buffer.toString('utf8');
    righe = righeCsv(utf8.includes(String.fromCharCode(0xFFFD)) ? buffer.toString('latin1') : utf8);
  }
  return movimentiDaRighe(righe);
}

module.exports = { leggiEstratto, movimentiDaRighe, righeCsv, importoItaliano, dataIso, trovaIntestazioni };
