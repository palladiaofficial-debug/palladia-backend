'use strict';
// ── Testo PDF modificabile (F-302, AUDIT.md del frontend) ───────────────────
// Chrome (Skia) scrive il testo nel PDF lettera per lettera, ognuna con le
// sue coordinate, quando la dimensione del carattere non cade su un multiplo
// di mezzo pixel (10pt = 13,33px, 11pt = 14,67px…) o quando c'è crenatura.
// Acrobat e Affinity non ricostruiscono più frasi e paragrafi e il PDF non
// si modifica. Qui: ogni font-size in pt diventa px arrotondato al mezzo
// pixel (differenza ≤ 0,25px, invisibile) e la crenatura si spegne.
// Misurato su un POS vero: lettere separate dal 66% all'11% (restano le
// etichette maiuscole spaziate, che sono grafica).

const PT_TO_PX = 4 / 3;

function snapFontSizes(html) {
  return html.replace(/font-size:(\s*)(\d+(?:\.\d+)?)pt/g, (m, sp, v) => `font-size:${sp}${Math.round(Number(v) * PT_TO_PX * 2) / 2}px`);
}

const NO_KERNING_CSS = '*{font-kerning:none}';

/** HTML pronto per un PDF il cui testo si possa selezionare e modificare. */
function editablePdfHtml(html) {
  const out = snapFontSizes(html);
  return out.includes('</head>') ? out.replace('</head>', `<style>${NO_KERNING_CSS}</style></head>`) : out;
}

module.exports = { editablePdfHtml, snapFontSizes };
