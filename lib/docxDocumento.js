'use strict';
/**
 * lib/docxDocumento.js — F-490 / F-491 (AUDIT.md del frontend).
 *
 * File Word VERO (.docx) del PSC e del POS, con le stesse pagine del PDF:
 * copertina, indice, sezioni, tabelle, intestazione con l'impresa o lo
 * studio, piè di pagina con «Pagina X di Y». Prima il PSC si scaricava come
 * HTML rinominato .doc (in Word: niente copertina, niente numeri di pagina,
 * testi incollati) e il POS non aveva il Word.
 *
 * Non riscrive i contenuti: legge l'HTML che già genera il PDF
 * (documento.pscBody per il PSC, generatePosHtml per il POS) e lo traduce
 * negli oggetti di Word, classe per classe. Così PDF e Word dicono sempre la
 * stessa cosa. I caratteri della piattaforma (Plus Jakarta Sans, Archivo
 * condensato) sono incorporati nel file: chi lo apre li vede anche se non li
 * ha installati (licenza OFL, incorporamento permesso).
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header, Footer, PageNumber, ImageRun,
  ShadingType, WidthType, BorderStyle, AlignmentType, TabStopType, TableLayoutType, LevelFormat, VerticalAlign,
  CharacterSet,
} = require('docx');

// ── Misure (twip = 1/20 pt) e colori dello standard F-442 ────────────────────
const MM = 56.7;
const PAGE_W = 11906, PAGE_H = 16838;
const MARGIN = { top: Math.round(26 * MM), bottom: Math.round(24 * MM), left: Math.round(16 * MM), right: Math.round(16 * MM), header: Math.round(10 * MM), footer: Math.round(9 * MM) };
const CONTENT_W = PAGE_W - MARGIN.left - MARGIN.right;
const C = { ink: '10171F', ink2: '3A4652', mut: '5B6672', faint: '8A949E', line: 'E3E7EC', line2: 'CBD3DB', az: 'E8F1F9', az2: 'B5D3EE', soft: 'F5F7F9', red: '9F2F25', redBg: 'FBE7E4', ora: '9A520E', oraBg: 'FDF0E1', grn: '2F6A43', grnBg: 'E9F3EC' };
const F_TEXT = 'Plus Jakarta Sans';
const F_DISP = 'Archivo Condensed';
const SZ = { body: 19, small: 17, tiny: 15, label: 15, h3: 22, h2: 40, lav: 24, coverTitle: 84, coverRev: 44, coverOpera: 38, coverDato: 24 };

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let fontCache = null;
function fonts() {
  if (fontCache) return fontCache;
  try {
    fontCache = [
      { name: F_TEXT, data: fs.readFileSync(path.join(FONTS_DIR, 'PlusJakartaSans-Regular.ttf')), bold: fs.readFileSync(path.join(FONTS_DIR, 'PlusJakartaSans-Bold.ttf')), characterSet: CharacterSet.ANSI },
      { name: F_DISP, data: fs.readFileSync(path.join(FONTS_DIR, 'ArchivoCondensed-ExtraBold.ttf')), characterSet: CharacterSet.ANSI },
    ];
  } catch { fontCache = []; }
  return fontCache;
}

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const line = (color = C.line, size = 4) => ({ style: BorderStyle.SINGLE, size, color });

// ── Testo in linea ──────────────────────────────────────────────────────────
const clean = (s) => String(s || '').replace(/\s+/g, ' ');
const cls = (el) => (el && el.classList ? Array.from(el.classList.values()) : []);
const has = (el, c) => cls(el).includes(c);

const LIVELLO = {
  'molto-alto': { color: 'FFFFFF', fill: C.red }, 'badge-very-high': { color: 'FFFFFF', fill: C.red },
  alto: { color: C.red, fill: C.redBg }, 'badge-high': { color: C.red, fill: C.redBg },
  medio: { color: C.ora, fill: C.oraBg }, 'badge-medium': { color: C.ora, fill: C.oraBg },
  basso: { color: C.grn, fill: C.grnBg }, 'badge-low': { color: C.grn, fill: C.grnBg },
};

/** Run di testo da un nodo HTML in linea, con lo stile ereditato. */
function runs(node, st = {}) {
  const out = [];
  const walk = (n, s) => {
    if (n.nodeType === 3) {
      const t = clean(n.text);
      if (t) out.push(new TextRun({ text: t, bold: s.bold, italics: s.italics, color: s.color || C.ink, size: s.size || SZ.body, font: s.font || F_TEXT, allCaps: s.caps, shading: s.fill ? { type: ShadingType.CLEAR, fill: s.fill, color: 'auto' } : undefined }));
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = (n.tagName || '').toLowerCase();
    if (tag === 'br') { out.push(new TextRun({ text: '', break: 1 })); return; }
    if (tag === 'img') return;
    const ns = { ...s };
    if (tag === 'b' || tag === 'strong') ns.bold = true;
    if (tag === 'i' || tag === 'em') ns.italics = !has(n, 'n');
    const c = cls(n);
    if (c.includes('muted') || c.includes('k')) ns.color = C.mut;
    if (c.includes('small')) ns.size = SZ.small;
    if (c.includes('placeholder')) ns.color = C.faint;
    const lv = c.find(x => LIVELLO[x]);
    if (lv && (c.includes('lv') || c.includes('badge'))) { ns.bold = true; ns.color = LIVELLO[lv].color; ns.fill = LIVELLO[lv].fill; ns.size = SZ.tiny; }
    if (c.includes('risk-num')) ns.bold = true;
    if (tag === 'span' && c.includes('r')) { ns.caps = true; ns.size = 13; ns.color = C.mut; ns.bold = true; }
    if (tag === 'span' && c.includes('nodo') && out.length) out.push(new TextRun({ text: '', break: 1 }));
    for (const ch of n.childNodes) walk(ch, ns);
    if (tag === 'span' && c.includes('r')) out.push(new TextRun({ text: '', break: 1 }));
  };
  walk(node, st);
  return out;
}

const para = (children, opts = {}) => new Paragraph({ ...opts, children, spacing: { after: 100, line: 276, ...(opts.spacing || {}) } });
const txt = (text, o = {}) => new TextRun({ text: String(text ?? ''), font: o.font || F_TEXT, size: o.size || SZ.body, color: o.color || C.ink, bold: o.bold, allCaps: o.caps, characterSpacing: o.spacing });

// ── Elementi a blocchi ──────────────────────────────────────────────────────
function titoloSezione(el, ctx) {
  const n = el.querySelector('.n');
  const num = n ? clean(n.text) : '';
  const tutto = clean(el.text).trim();
  const titolo = num && tutto.startsWith(num) ? tutto.slice(num.length).trim() : tutto;
  return new Paragraph({
    children: [...(num ? [txt(`${num}  `, { font: F_DISP, size: SZ.h2, color: C.faint })] : []), txt(titolo, { font: F_DISP, size: SZ.h2 })],
    pageBreakBefore: has(el, 'newpage') || has(el, 'page-break') || ctx.nextPageBreak,
    keepNext: true, keepLines: true,
    spacing: { before: 360, after: 200 },
    border: { bottom: line(C.ink, 12) },
  });
}
const etichetta = (text, extra = {}) => new Paragraph({ children: [txt(clean(text).toUpperCase(), { size: SZ.label, bold: true, color: C.ink2, spacing: 16 })], keepNext: true, spacing: { before: 200, after: 80 }, ...extra });

function lista(el, ordinata, ctx) {
  const out = [];
  const inst = ordinata ? ++ctx.olCount : 0;
  for (const li of el.childNodes.filter(x => x.tagName && x.tagName.toLowerCase() === 'li')) {
    out.push(new Paragraph({ children: runs(li, { size: SZ.body }), numbering: ordinata ? { reference: 'num', level: 0, instance: inst } : { reference: 'punto', level: 0 }, spacing: { after: 40, line: 264 }, keepNext: ctx.keep }));
  }
  return out;
}

/** Larghezze delle colonne (twip) dagli stili width:% / mm delle intestazioni. */
function larghezze(cells, totale) {
  const w = cells.map(c => {
    const st = (c.getAttribute && c.getAttribute('style')) || '';
    const pc = st.match(/width:\s*([\d.]+)%/); if (pc) return { pc: Number(pc[1]) };
    const mm = st.match(/width:\s*([\d.]+)mm/); if (mm) return { tw: Number(mm[1]) * MM };
    return null;
  });
  const fissi = w.reduce((a, x) => a + (x && x.tw ? x.tw : 0), 0);
  const restante = Math.max(totale - fissi, totale * 0.2);
  const pcSum = w.reduce((a, x) => a + (x && x.pc ? x.pc : 0), 0);
  const liberi = w.filter(x => !x).length;
  const pcLiberi = liberi ? Math.max(0, 100 - pcSum) / liberi : 0;
  let out = w.map(x => (x && x.tw ? x.tw : x && x.pc ? restante * x.pc / 100 : restante * (pcLiberi || (100 / cells.length)) / 100));
  const s = out.reduce((a, b) => a + b, 0);
  out = out.map(x => Math.max(400, Math.round(x * totale / s)));
  return out;
}

function cellaBlocchi(td, ctx, opts = {}) {
  const blocchi = [];
  const hasBlock = td.childNodes.some(n => n.tagName && /^(p|ul|ol|div|table|h4)$/i.test(n.tagName));
  if (hasBlock) blocchi.push(...blocks(td, { ...ctx, inCell: true }));
  else {
    const r = runs(td, { size: opts.size || SZ.small, bold: opts.bold, color: opts.color, caps: opts.caps });
    const img = td.querySelector && td.querySelector('img');
    if (img) blocchi.push(...immagine(img));
    blocchi.push(new Paragraph({ children: r, spacing: { after: 0, line: 252 }, alignment: opts.align }));
  }
  return blocchi.length ? blocchi : [new Paragraph({ children: [] })];
}

function tabella(el, ctx, totale = CONTENT_W) {
  const righe = el.querySelectorAll('tr').filter(tr => tr.closest('table') === el);
  if (!righe.length) return [];
  const testa = righe.filter(tr => tr.closest('thead'));
  const corpo = righe.filter(tr => !tr.closest('thead'));
  const primaRiga = (testa[0] || corpo[0]).childNodes.filter(n => n.tagName && /^(td|th)$/i.test(n.tagName));
  const nCol = Math.max(...righe.map(tr => tr.childNodes.filter(n => n.tagName && /^(td|th)$/i.test(n.tagName)).reduce((a, c) => a + Number(c.getAttribute('colspan') || 1), 0)));
  const cols = el.querySelectorAll('col');
  const widths = cols.length === nCol ? larghezze(cols, totale) : primaRiga.length === nCol ? larghezze(primaRiga, totale) : Array(nCol).fill(Math.round(totale / nCol));
  const kv = has(el, 'kv') || has(el, 'kvt') || (!testa.length && nCol === 2);
  const rows = [];
  const fai = (tr, isHead) => {
    const celle = tr.childNodes.filter(n => n.tagName && /^(td|th)$/i.test(n.tagName));
    let col = 0;
    const tot = has(tr, 'tot') || has(tr, 'sign-summary-total');
    const sub = has(tr, 'sub');
    const children = celle.map((td, i) => {
      const span = Number(td.getAttribute('colspan') || 1);
      const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0); col += span;
      const isTh = td.tagName.toLowerCase() === 'th' || isHead;
      const st = td.getAttribute('style') || '';
      const align = /text-align:\s*right/.test(st) || has(td, 'r') ? AlignmentType.RIGHT : /text-align:\s*center/.test(st) ? AlignmentType.CENTER : undefined;
      const bar = td.querySelector && td.querySelector('.bar');
      const barFill = bar && ((bar.getAttribute('style') || '').match(/background:\s*#([0-9a-fA-F]{6})/) || [])[1];
      return new TableCell({
        children: barFill ? [new Paragraph({ children: [], spacing: { after: 0 } })] : cellaBlocchi(td, ctx, isTh ? { size: SZ.tiny, bold: true, color: C.mut, caps: true, align } : { size: SZ.small, bold: tot || sub || undefined, color: kv && i === 0 ? C.mut : undefined, align }),
        columnSpan: span > 1 ? span : undefined,
        width: { size: w, type: WidthType.DXA },
        margins: { top: 70, bottom: 70, left: kv && i === 0 ? 0 : 100, right: 100 },
        verticalAlign: VerticalAlign.TOP,
        shading: barFill ? { type: ShadingType.CLEAR, fill: barFill, color: 'auto' } : sub ? { type: ShadingType.CLEAR, fill: C.soft, color: 'auto' } : undefined,
        borders: { top: tot ? line(C.ink, 10) : NONE, left: NONE, right: NONE, bottom: isTh ? line(C.ink, 10) : tot ? NONE : line(C.line, 4) },
      });
    });
    if (children.length) rows.push(new TableRow({ children, tableHeader: isHead, cantSplit: true }));
  };
  testa.forEach(tr => fai(tr, true));
  corpo.forEach(tr => fai(tr, false));
  if (!rows.length) return [];
  return [new Table({ rows, width: { size: totale, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, borders: NO_BORDERS }), new Paragraph({ children: [], spacing: { after: 120 } })];
}

function immagine(img, maxW = 22 * MM) {
  const src = img.getAttribute('src') || '';
  const m = src.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!m) return [];
  const data = Buffer.from(m[2], 'base64');
  const px = Math.round(maxW / 15); // twip → px a 96 dpi
  return [new Paragraph({ children: [new ImageRun({ type: m[1].toLowerCase().startsWith('jp') ? 'jpg' : 'png', data, transformation: { width: px, height: px } })], alignment: AlignmentType.CENTER, spacing: { after: 60 } })];
}

/** Griglia di schede (cartelli, numeri d'emergenza, firme) → tabella senza bordi. */
function griglia(items, nCol, cella) {
  const w = Math.round(CONTENT_W / nCol);
  const rows = [];
  for (let i = 0; i < items.length; i += nCol) {
    const slice = items.slice(i, i + nCol);
    while (slice.length < nCol) slice.push(null);
    rows.push(new TableRow({ cantSplit: true, children: slice.map(it => new TableCell({ width: { size: w, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 80, right: 80 }, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE }, children: it ? cella(it, w - 160) : [new Paragraph({ children: [] })] })) }));
  }
  return [new Table({ rows, width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: Array(nCol).fill(w), layout: TableLayoutType.FIXED, borders: NO_BORDERS }), new Paragraph({ children: [], spacing: { after: 120 } })];
}

const riquadro = (children, fill, W = CONTENT_W) => new Table({
  rows: [new TableRow({ cantSplit: true, children: [new TableCell({ children, width: { size: W, type: WidthType.DXA }, margins: { top: 140, bottom: 140, left: 200, right: 200 }, shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined, borders: { top: line(C.line2), bottom: line(C.line2), left: fill ? line(C.az2, 36) : line(C.line2), right: line(C.line2) } })] })],
  width: { size: W, type: WidthType.DXA }, columnWidths: [W], layout: TableLayoutType.FIXED,
});

function firmaBox(el) {
  const ruolo = el.querySelector('.sig-role, .eyebrow, .ey');
  const nome = el.querySelector('.sig-name, .n, b');
  return [
    new Paragraph({ children: [txt(clean(ruolo ? ruolo.text : '').toUpperCase(), { size: SZ.tiny, bold: true, color: C.mut, spacing: 16 })], spacing: { after: 40 } }),
    new Paragraph({ children: [txt(clean(nome ? nome.text : ''), { bold: true })], spacing: { after: 280 } }),
    new Paragraph({ children: [txt('Firma', { size: SZ.tiny, color: C.faint })], border: { bottom: line(C.faint, 4) }, spacing: { after: 200 } }),
    new Paragraph({ children: [txt('Data', { size: SZ.tiny, color: C.faint })], border: { bottom: line(C.faint, 4) }, spacing: { after: 60 } }),
  ];
}
const firmaTabella = (boxes, nCol = 2) => griglia(boxes, nCol, (b, w) => [riquadro(firmaBox(b), null, w)]);

function blocks(root, ctx) {
  const out = [];
  const nodes = root.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el.nodeType === 3) {
      const t = clean(el.text).trim();
      if (t) out.push(para([txt(t)]));
      continue;
    }
    if (el.nodeType !== 1) continue;
    const tag = el.tagName.toLowerCase();
    const c = cls(el);
    if (tag === 'style' || tag === 'script' || c.includes('cover') || tag === 'svg') continue;

    if (c.includes('indice')) { out.push(...indice(el, ctx.nextPageBreak)); ctx.nextPageBreak = false; continue; }
    if (tag === 'h2' || c.includes('section-title')) { out.push(titoloSezione(el, ctx)); ctx.nextPageBreak = false; continue; }
    if (tag === 'h1') { out.push(new Paragraph({ children: [txt(clean(el.text), { font: F_DISP, size: SZ.h2 })], keepNext: true, spacing: { after: 200 } })); continue; }
    if (tag === 'h3' || c.includes('sub-title')) { out.push(new Paragraph({ children: [txt(clean(el.text), { size: SZ.h3, bold: true })], keepNext: true, spacing: { before: 240, after: 100 } })); continue; }
    if (tag === 'h4' || c.includes('bold-line') || c.includes('sign-zone-header')) { out.push(etichetta(el.text)); continue; }
    if (c.includes('eyebrow') && tag !== 'span') { out.push(etichetta(el.text, { keepNext: true })); continue; }
    if (tag === 'p') {
      const nota = c.includes('nota') || c.includes('callout') || c.includes('legenda');
      const r = runs(el, { size: c.includes('small') || nota ? SZ.small : SZ.body, color: c.includes('muted') || nota ? C.mut : undefined });
      if (r.length) out.push(para(r, { keepNext: ctx.keep, shading: c.includes('nota') || c.includes('callout') ? { type: ShadingType.CLEAR, fill: C.soft, color: 'auto' } : undefined, alignment: /text-align:\s*center/.test(el.getAttribute('style') || '') ? AlignmentType.CENTER : undefined }));
      continue;
    }
    if (tag === 'ul' || tag === 'ol') { out.push(...lista(el, tag === 'ol', ctx)); continue; }
    if (tag === 'table') { out.push(...tabella(el, ctx, ctx.inCell ? CONTENT_W / 2 : CONTENT_W)); continue; }
    if (tag === 'hr') { out.push(new Paragraph({ children: [], border: { bottom: line(C.line, 4) }, spacing: { before: 120, after: 200 } })); continue; }
    if (tag === 'img') { out.push(...immagine(el)); continue; }

    // Testate di lavorazione: banda azzurra con il periodo a destra
    if (c.includes('lav-head') || c.includes('lav-header')) {
      const b = el.querySelector('b'); const s = el.querySelector('span');
      const nome = clean(b ? b.text : el.text); const periodo = s ? clean(s.text) : '';
      // nome lungo: il periodo va sulla riga sotto invece di andare a capo accanto al titolo
      const lungo = nome.length + periodo.length > 62;
      out.push(new Paragraph({ children: [txt(nome, { size: SZ.lav, bold: true }), ...(periodo ? [new TextRun({ text: lungo ? periodo : `\t${periodo}`, break: lungo ? 1 : undefined, font: F_TEXT, size: SZ.small, color: C.ink2 })] : [])], shading: { type: ShadingType.CLEAR, fill: C.az, color: 'auto' }, tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W - 120 }], keepNext: true, keepLines: true, spacing: { before: 240, after: 100 }, indent: { left: 0 } }));
      continue;
    }
    if (c.includes('lav-meta')) { out.push(para(el.querySelectorAll('span').flatMap((sp, k) => [...(k ? [txt('     ')] : []), ...runs(sp, { size: SZ.small, color: C.mut })]), { keepNext: true })); continue; }
    if (c.includes('signature-grid') || c.includes('sign')) { out.push(...firmaTabella(el.querySelectorAll('.signature-box, .box'))); continue; }
    if (c.includes('signature-box')) { out.push(riquadro(firmaBox(el)), new Paragraph({ children: [], spacing: { after: 120 } })); continue; }
    if (c.includes('signs-grid')) {
      out.push(...griglia(el.querySelectorAll('.sign-card'), 4, card => {
        const img = card.querySelector('img');
        return [...(img ? immagine(img) : []), ...['.sign-name', '.sign-iso', '.sign-location-text'].map((s, k) => { const e = card.querySelector(s); return e ? new Paragraph({ children: [txt(clean(e.text), { size: k === 0 ? SZ.tiny : 13, bold: k < 2, color: k === 2 ? C.mut : C.ink })], alignment: AlignmentType.CENTER, spacing: { after: 20 } }) : null; }).filter(Boolean)];
      }));
      continue;
    }
    if (c.includes('emergency-grid')) {
      out.push(...griglia(el.querySelectorAll('.emergency-card'), 3, (card, w) => [riquadro([
        new Paragraph({ children: [txt(clean((card.querySelector('.emergency-number') || {}).text || ''), { font: F_DISP, size: has(card.querySelector('.emergency-number'), 'small') ? 30 : 44 })], spacing: { after: 20 } }),
        new Paragraph({ children: [txt(clean((card.querySelector('.emergency-label') || {}).text || ''), { size: SZ.tiny, color: C.mut })], spacing: { after: 0 } }),
      ], null, w)]));
      continue;
    }
    if (c.includes('intf')) {
      const t = el.querySelector('.t'); const meta = el.querySelector('.meta');
      const ch = [];
      if (t) ch.push(new Paragraph({ children: runs(t, { bold: true, size: SZ.body + 2 }), spacing: { after: 60 } }));
      if (meta) ch.push(new Paragraph({ children: runs(meta, { size: SZ.small, color: C.mut }), spacing: { after: 100 } }));
      for (const r of el.querySelectorAll('.riga')) { const sp = r.querySelector('span'); const label = sp ? clean(sp.text) : ''; const rest = clean(r.text).replace(label, '').trim(); ch.push(new Paragraph({ children: [txt(`${label}  `, { bold: true, size: SZ.small, color: C.ink2 }), txt(rest, { size: SZ.small })], border: { top: line(C.line) }, spacing: { before: 60, after: 60 } })); }
      out.push(riquadro(ch), new Paragraph({ children: [], spacing: { after: 160 } }));
      continue;
    }
    // Blocchi da tenere insieme (titolo + contenuto)
    if (c.includes('blk') || c.includes('lav-top') || c.includes('keep') || c.includes('no-break') || c.includes('firme')) {
      const inner = blocks(el, { ...ctx, keep: true });
      out.push(...inner);
      continue;
    }
    // Contenitore generico: se ha blocchi dentro scendo, altrimenti è un paragrafo
    const haBlocchi = el.childNodes.some(n => n.nodeType === 1 && /^(p|ul|ol|div|table|h[1-6]|section|img)$/i.test(n.tagName));
    if (haBlocchi) out.push(...blocks(el, ctx));
    else {
      const r = runs(el, { size: c.includes('small') || c.includes('muted') ? SZ.small : SZ.body, color: c.includes('muted') ? C.mut : undefined });
      if (r.length) out.push(para(r, { keepNext: ctx.keep }));
    }
  }
  return out;
}

function indice(el, nuovaPagina) {
  const out = [new Paragraph({ children: [txt('Indice', { font: F_DISP, size: SZ.h2 })], pageBreakBefore: !!nuovaPagina, border: { bottom: line(C.ink, 12) }, spacing: { after: 240 } })];
  for (const r of el.querySelectorAll('.idx')) {
    const b = r.querySelector('b');
    const n = b ? clean(b.text) : '';
    const t = clean(r.text).replace(n, '').trim().replace(/\d+$/, '').trim();
    out.push(new Paragraph({ children: [txt(n, { bold: true, color: C.faint }), txt(`\t${t}`, { size: SZ.body + 2 })], tabStops: [{ type: TabStopType.LEFT, position: 600 }], border: { bottom: line(C.line) }, spacing: { before: 80, after: 80 } }));
  }
  out.push(new Paragraph({ children: [], pageBreakBefore: true, spacing: { after: 0 } }));
  return out;
}

// ── Copertina, letta dall'HTML del PDF (PSC: .cover; POS: .cover con .cover-*) ─
function specCopertina(cover) {
  if (!cover) return null;
  const q = (s) => cover.querySelector(s);
  const T = (e) => (e ? clean(e.text).trim() : '');
  const isPos = !!q('.cover-title');
  const ey = isPos ? cover.querySelectorAll('.cover-kind .ey') : [q('.top .eyebrow')];
  const titolo = isPos ? q('.cover-title') : q('h1');
  const rev = isPos ? q('.cover-rev') : q('.rev');
  const opera = isPos ? q('.cover-opera') : q('.opera');
  const dati = (isPos ? cover.querySelectorAll('.cover-dati > div') : cover.querySelectorAll('.opera .dati > div')).map(d => [T(d.querySelector('span')), T(d.querySelector('b'))]);
  const persone = (isPos ? cover.querySelectorAll('.cover-persone tr') : cover.querySelectorAll('.persone tr')).map(tr => { const td = tr.querySelectorAll('td'); return [T(td[0]), T(td[1])]; });
  const firme = (isPos ? cover.querySelectorAll('.cover-firma') : cover.querySelectorAll('.firma')).map(f => [T(f.querySelector('.ey, .eyebrow')), T(f.querySelector('.n'))]);
  return {
    eyLeft: T(ey[0]), eyRight: T(ey[1]),
    titolo: titolo ? titolo.innerHTML.split(/<br\s*\/?>/i).map(s => clean(parse(s).text).trim()).filter(Boolean) : [],
    rev: T(rev && rev.querySelector('b')), revData: T(rev && rev.querySelector('span')),
    operaLabel: T(opera && opera.querySelector('.ey, .eyebrow')), operaTitolo: T(opera && opera.querySelector('.t')), operaInd: T(opera && opera.querySelector('.a')),
    pill: T(opera && opera.querySelector('.cover-pill, .tipo')), desc: T(opera && opera.querySelector('.d, .desc')),
    dati, personeLabel: isPos ? T(q('.cover-persone .ey')) : T(q('.persone .eyebrow')), persone, firme,
  };
}

function copertina(s) {
  if (!s) return [];
  const out = [];
  const lab = (t) => txt(t.toUpperCase(), { size: SZ.tiny, bold: true, color: C.mut, spacing: 16 });
  out.push(new Paragraph({ children: [lab(s.eyLeft), ...(s.eyRight ? [new TextRun({ text: `\t${s.eyRight.toUpperCase()}`, font: F_TEXT, size: SZ.tiny, bold: true, color: C.mut, characterSpacing: 16 })] : [])], tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], spacing: { after: 160 } }));
  s.titolo.forEach((t, i) => out.push(new Paragraph({ children: [txt(t, { font: F_DISP, size: SZ.coverTitle }), ...(i === s.titolo.length - 1 && s.rev ? [new TextRun({ text: `\t${s.rev}`, font: F_DISP, size: SZ.coverRev, color: C.ink })] : [])], tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], spacing: { after: 0, line: 900, lineRule: 'exact' } })));
  out.push(new Paragraph({ children: [new TextRun({ text: `\t${s.revData}`, font: F_TEXT, size: SZ.small, color: C.mut })], tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], border: { bottom: line(C.ink, 12) }, spacing: { after: 360 } }));
  const op = [];
  if (s.operaLabel) op.push(new Paragraph({ children: [lab(s.operaLabel)], spacing: { after: 40 } }));
  if (s.operaTitolo) op.push(new Paragraph({ children: [txt(s.operaTitolo, { font: F_DISP, size: SZ.coverOpera })], spacing: { after: 40 } }));
  if (s.operaInd) op.push(new Paragraph({ children: [txt(s.operaInd, { size: SZ.body + 3, color: C.ink2 })], spacing: { after: 100 } }));
  if (s.pill) op.push(new Paragraph({ children: [txt(` ${s.pill} `, { size: SZ.tiny, bold: true })], spacing: { after: 100 } }));
  if (s.desc) op.push(new Paragraph({ children: [txt(s.desc, { size: SZ.small, color: C.ink2 })], spacing: { after: 160 } }));
  if (s.dati.length) {
    const w = Math.round((CONTENT_W - 400) / s.dati.length);
    op.push(new Table({ rows: [new TableRow({ children: s.dati.map(([k, v]) => new TableCell({ width: { size: w, type: WidthType.DXA }, borders: { top: line(C.line2), bottom: NONE, left: NONE, right: NONE }, margins: { top: 100, left: 0, right: 80 }, children: [new Paragraph({ children: [lab(k)], spacing: { after: 20 } }), new Paragraph({ children: [txt(v, { size: SZ.coverDato, bold: true })], spacing: { after: 0 } })] })) })], width: { size: w * s.dati.length, type: WidthType.DXA }, columnWidths: Array(s.dati.length).fill(w), layout: TableLayoutType.FIXED, borders: NO_BORDERS }));
  }
  out.push(riquadro(op, C.soft), new Paragraph({ children: [], spacing: { after: 360 } }));
  if (s.persone.length) {
    out.push(new Paragraph({ children: [lab(s.personeLabel || 'Soggetti')], spacing: { after: 80 } }));
    const w1 = Math.round(62 * MM);
    out.push(new Table({ rows: s.persone.map(([k, v]) => new TableRow({ children: [new TableCell({ width: { size: w1, type: WidthType.DXA }, borders: { top: NONE, left: NONE, right: NONE, bottom: line(C.line) }, margins: { top: 90, bottom: 90, left: 0 }, children: [new Paragraph({ children: [txt(k, { color: C.mut })], spacing: { after: 0 } })] }), new TableCell({ width: { size: CONTENT_W - w1, type: WidthType.DXA }, borders: { top: NONE, left: NONE, right: NONE, bottom: line(C.line) }, margins: { top: 90, bottom: 90 }, children: [new Paragraph({ children: [txt(v, { bold: true })], spacing: { after: 0 } })] })] })), width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [w1, CONTENT_W - w1], layout: TableLayoutType.FIXED, borders: NO_BORDERS }));
    out.push(new Paragraph({ children: [], spacing: { after: 600 } }));
  }
  if (s.firme.length) out.push(...griglia(s.firme, 2, ([r, n], w) => [riquadro([
    new Paragraph({ children: [lab(r)], spacing: { after: 40 } }),
    new Paragraph({ children: [txt(n, { bold: true })], spacing: { after: 600 } }),
    new Paragraph({ children: [txt('Firma', { size: SZ.tiny, color: C.faint })], border: { bottom: line(C.faint) }, spacing: { after: 0 } }),
  ], null, w)]));
  out.push(new Paragraph({ children: [txt('Redatto con Palladia', { size: SZ.tiny, color: C.faint })], alignment: AlignmentType.RIGHT, spacing: { after: 0 } }));
  return out;
}

// ── Documento ───────────────────────────────────────────────────────────────
/**
 * @param {string} html   HTML completo del documento (lo stesso del PDF)
 * @param {object} o      { headerLeft, docTitle, footerLeft, revision, title }
 * @returns {Promise<Buffer>} il file .docx
 */
async function htmlToDocx(html, o = {}) {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false } });
  const doc = root.querySelector('.doc') || root.querySelector('body') || root;
  const cover = doc.querySelector('.cover');
  const ctx = { olCount: 0, keep: false, nextPageBreak: !!cover };
  const corpo = blocks(doc.querySelector('.content') || doc, ctx);
  const children = [...copertina(specCopertina(cover)), ...corpo];

  const header = new Header({ children: [new Paragraph({ children: [txt(o.headerLeft || '', { size: SZ.tiny, bold: true }), new TextRun({ text: `\t${o.docTitle || ''}`, font: F_TEXT, size: SZ.tiny, color: C.faint })], tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], border: { bottom: line(C.line) }, spacing: { after: 0 } })] });
  const footer = new Footer({ children: [new Paragraph({ children: [
    txt(o.footerLeft || 'D.Lgs. 81/2008', { size: SZ.tiny, color: C.faint }),
    new TextRun({ children: ['\tPagina ', PageNumber.CURRENT, ' di ', PageNumber.TOTAL_PAGES], font: F_TEXT, size: SZ.tiny, bold: true, color: C.ink }),
    new TextRun({ text: `\tRev. ${o.revision ?? ''}`, font: F_TEXT, size: SZ.tiny, color: C.faint }),
  ], tabStops: [{ type: TabStopType.CENTER, position: Math.round(CONTENT_W / 2) }, { type: TabStopType.RIGHT, position: CONTENT_W }], border: { top: line(C.line) }, spacing: { before: 0, after: 0 } })] });

  const d = new Document({
    creator: o.headerLeft || 'Palladia', title: o.title || o.docTitle || 'Documento', description: 'Redatto con Palladia',
    fonts: fonts(),
    styles: { default: { document: { run: { font: F_TEXT, size: SZ.body, color: C.ink }, paragraph: { spacing: { after: 100, line: 276 } } } } },
    numbering: { config: [
      { reference: 'punto', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } }, run: { color: C.ink2 } } }] },
      { reference: 'num', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 300 } }, run: { color: C.faint, bold: true } } }] },
    ] },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: MARGIN } },
      headers: { default: header }, footers: { default: footer },
      children,
    }],
  });
  return Packer.toBuffer(d);
}

module.exports = { htmlToDocx, specCopertina };
