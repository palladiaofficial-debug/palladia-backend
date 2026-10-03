'use strict';
/**
 * lib/psc/files.js — F-270. Lettura dei file che un coordinatore porta:
 *  - .docx (PSC fatti in Word): testo dei paragrafi da word/document.xml;
 *  - .xpwe (computo esportato da Primus): elenco prezzi + voci di computo.
 * Funzioni pure sul buffer: nessun accesso al DB.
 */
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const MAX_DOCX_CHARS = 400_000;

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Testo di un .docx, un paragrafo per riga. Lancia se non è un docx valido. */
function docxText(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { const e = new Error('Il file Word non si apre: salvalo di nuovo come .docx o in PDF'); e.status = 400; throw e; }
  const entry = zip.getEntry('word/document.xml');
  if (!entry) { const e = new Error('Il file Word non contiene testo leggibile'); e.status = 400; throw e; }
  const xml = entry.getData().toString('utf8');
  const paras = xml.split(/<\/w:p>/);
  const out = [];
  for (const p of paras) {
    const parts = [];
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g;
    let m;
    while ((m = re.exec(p))) parts.push(m[1] !== undefined ? decodeXmlEntities(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n');
    const line = parts.join('').replace(/[ \t]+/g, ' ').trim();
    if (line) out.push(line);
  }
  const text = out.join('\n').slice(0, MAX_DOCX_CHARS);
  // Le pagine di un docx non esistono finché non si impagina: ne stimiamo il
  // numero (≈ 3000 caratteri a pagina) solo per dare un'idea.
  return { text, numPages: Math.max(1, Math.round(text.length / 3000)) };
}

function findAll(node, name, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const n of node) findAll(n, name, acc); return acc; }
  for (const [k, v] of Object.entries(node)) {
    if (k === name) { if (Array.isArray(v)) acc.push(...v); else acc.push(v); }
    else if (v && typeof v === 'object') findAll(v, name, acc);
  }
  return acc;
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const txt = (v) => (v === undefined || v === null ? '' : String(typeof v === 'object' ? (v['#text'] ?? '') : v)).replace(/\s+/g, ' ').trim();

/**
 * Computo da file .xpwe (formato di scambio di Primus). Tollerante: cerca gli
 * elementi EPItem (elenco prezzi) e VCItem (voci di computo) ovunque siano.
 * @returns {{nome:string, voci:Array<{codice,descrizione,unita_misura,quantita,prezzo_unitario,importo,categoria}>}}
 */
function parseXpwe(buffer) {
  let xml = buffer.toString('utf8');
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1); // BOM
  if (!/<PweDocumento|<EPItem|<VCItem/i.test(xml)) { const e = new Error('Il file non sembra un computo XPWE'); e.status = 400; throw e; }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
  let doc;
  try { doc = parser.parse(xml); } catch { const e = new Error('Il file XPWE è danneggiato'); e.status = 400; throw e; }

  const ep = new Map();
  for (const it of findAll(doc, 'EPItem')) {
    const id = txt(it['@_ID'] ?? it.ID);
    if (!id) continue;
    ep.set(id, {
      codice: txt(it.Tariffa) || txt(it.Articolo) || null,
      descrizione: txt(it.DesEstesa) || txt(it.DesRidotta) || txt(it.DesBreve),
      um: txt(it.UnMisura) || null,
      prezzo: num(it.Prezzo1),
    });
  }
  // Capitoli/categorie, se presenti: id → descrizione
  const cap = new Map();
  for (const name of ['DGSuperCapitoliItem', 'DGCapitoliItem', 'DGSubCapitoliItem', 'DGSuperCategorieItem', 'DGCategorieItem', 'DGSubCategorieItem']) {
    for (const it of findAll(doc, name)) {
      const id = txt(it['@_ID'] ?? it.ID);
      if (id) cap.set(`${name}:${id}`, txt(it.DesSintetica) || txt(it.DesEstesa));
    }
  }
  const vci = findAll(doc, 'VCItem');
  const voci = [];
  for (const it of vci) {
    const e = ep.get(txt(it.IDEP));
    if (!e || !e.descrizione) continue;
    const q = num(it.Quantita);
    const categoria = cap.get(`DGCategorieItem:${txt(it.IDCat)}`) || cap.get(`DGCapitoliItem:${txt(it.IDSpCap)}`) || cap.get(`DGSuperCapitoliItem:${txt(it.IDSpCap)}`) || null;
    voci.push({
      codice: e.codice, descrizione: e.descrizione.slice(0, 600), unita_misura: e.um,
      quantita: q, prezzo_unitario: e.prezzo, importo: q != null && e.prezzo != null ? Math.round(q * e.prezzo * 100) / 100 : null,
      categoria,
    });
  }
  // Un XPWE con solo l'elenco prezzi (nessuna misura): usiamo l'elenco.
  if (!voci.length) for (const e of ep.values()) if (e.descrizione) voci.push({ codice: e.codice, descrizione: e.descrizione.slice(0, 600), unita_misura: e.um, quantita: null, prezzo_unitario: e.prezzo, importo: null, categoria: null });
  if (!voci.length) { const e = new Error('Nessuna voce trovata nel computo XPWE'); e.status = 422; throw e; }
  const titolo = txt(findAll(doc, 'Oggetto')[0]) || txt(findAll(doc, 'Descrizione')[0]) || 'Computo metrico';
  return { nome: titolo.slice(0, 200), voci };
}

module.exports = { docxText, parseXpwe };
