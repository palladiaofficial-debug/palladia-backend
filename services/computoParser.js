'use strict';
/**
 * services/computoParser.js
 * Parsing ibrido regex+AI di capitolati speciali d'appalto italiani.
 *
 * Flusso:
 *  1. extractPdfText/xlsx → testo grezzo
 *  2. preFilter → rimuove header ripetuti e font spaziato
 *  3. regexParse → estrae struttura completa (categorie, voci, misure, prezzi)
 *  4. AI Haiku (UNA sola chiamata) → solo voci dove regex non trovò il prezzo
 *
 * Risparmio AI: ~85% vs versione full-chunking precedente.
 */

const Anthropic = require('@anthropic-ai/sdk');
const xlsx      = require('xlsx');
const { extractPdfText } = require('../lib/pdfExtract');

const MODEL      = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4000;

// ─── Pre-filtro ───────────────────────────────────────────────────────────────
function preFilter(rawLines) {
  const out = [];
  for (const raw of rawLines) {
    let line = raw.trim();
    if (!line || line.length < 2)                                    continue;
    if (/^-+\s*pagina\s+\d+\s*-+$/i.test(line))                    continue;
    if (/^\d+\s*[\/\-]\s*\d+$/.test(line))                          continue;
    if (/^pagina\s+\d+$/i.test(line))                               continue;
    // Font spaziato da loghi PDF ("s t u d i o")
    line = line.replace(/(?:[a-zA-ZÀ-ÿ&]\s){4,}[a-zA-ZÀ-ÿ]/g, ' ')
               .replace(/\s{2,}/g, ' ').trim();
    // Footer ripetuto di pagina
    line = line.replace(
      /manutenzione[^.]{5,}capitolato speciale d'appalto lavori\s+pag\.\s*\d+/gi, ''
    ).trim();
    if (line.length < 2) continue;
    out.push(line);
  }
  return out;
}

// ─── Pattern ──────────────────────────────────────────────────────────────────
// Categoria: "A OPERE PROVVISIONALI", "E TERRAZZO A TASCA TIPO A"
const RE_CAT = /^([A-G])\s{1,6}([A-ZÀÈÉÌÒÙ][A-ZÀÈÉÌÒÙ\s\d,'àèéìòùì°.()\-]+)$/;

// Voce: "A.1 Formazione cantiere", "E.1 Calcestruzzo armato…"
const RE_VOCE = /^([A-G])\.(\d+[a-z]?)\s{1,5}(.{4,})/;

// c.ca / c.a X UM x
const RE_CCA = /c\.?\s*ca\s+([\d,.]+)\s*(mq|mc|ml|kg|t\b|h\b|cad|n\b|nr\b)\s*x/i;

// n. X x (cadauno)
const RE_N_X = /n\.\s*([\d,]+)\s*x/i;

// Prezzo unitario inline: "45,00 €/mq" — con o senza spazi
const RE_PU_INLINE = /([\d.]+,\d{1,2})\s*€\s*\/\s*(mq|mc|ml|kg|t|h|cad|n|nr)/i;

// Importo totale inline: "= € 13.950,00" a fine riga
const RE_IMP_INLINE = /=\s*€\s*([\d.]+(?:,\d{1,2})?)\s*€?\s*$/;

// compenso a corpo = € [prezzo opzionale]
const RE_CORPO = /compenso\s+a\s+corpo\s*=\s*€\s*([\d.]+(?:,\d{1,2})?)?/i;

// compenso unitario = €/UM [prezzo opzionale sulla stessa riga]
const RE_COMP_UNIT = /compenso\s+unitario\s*=\s*€\s*\/\s*(mq|mc|ml|kg|t|h|cad|n|nr)\s*([\d.]+(?:,\d{1,2})?)?/i;

// TOTALE = € N (per voci composte tipo A.5, A.6)
const RE_TOTALE = /^TOTALE\s*=\s*€\s*([\d.]+(?:,\d{1,2})?)/i;

// Numero galleggiante con decimali: "3.200,00", "45,00", "3.200,00 €"
const RE_FLOAT = /^([\d]{1,3}(?:\.\d{3})*,\d{1,2})\s*€?\s*$/;

// Numero intero plausibile come prezzo unitario: "85", "42"
const RE_INT_PX = /^(\d{1,4}(?:,00)?)\s*€?\s*$/;

// ─── Utilities ────────────────────────────────────────────────────────────────
function toIT(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

const UM_MAP = {
  'mq':'mq','m²':'mq','m2':'mq',
  'mc':'mc','m³':'mc','m3':'mc',
  'ml':'ml','m.l.':'ml','m/l':'ml',
  'kg':'kg','t':'t',
  'h':'h','ora':'h','ore':'h',
  'cad':'cad','n':'cad','nr':'cad','n.':'cad','pz':'cad',
  'corpo':'corpo',
};
function normUM(raw) {
  if (!raw) return null;
  return UM_MAP[raw.toLowerCase().trim().replace(/\.$/, '')] || raw.toLowerCase().trim();
}

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }

// ─── Ricerca prezzo "galleggiante" nelle righe vicine ─────────────────────────
// Cerca nelle righe SUCCESSIVE alla formula (poi nelle precedenti).
// Si ferma se incontra un'altra voce/categoria o testo descrittivo lungo.
function nearbyPrice(lines, formulaIdx, fwd = 10, bwd = 2) {
  for (let d = 1; d <= fwd; d++) {
    const j = formulaIdx + d;
    if (j >= lines.length) break;
    const l = lines[j];
    if (RE_VOCE.test(l) || RE_CAT.test(l)) break;
    if (RE_CORPO.test(l) || RE_COMP_UNIT.test(l) || RE_CCA.test(l)) break;
    // Salta righe descrittive (più di 7 parole che non siano un numero)
    if (l.split(/\s+/).length > 7 && !RE_FLOAT.test(l) && !RE_INT_PX.test(l)) continue;
    let m;
    if ((m = RE_FLOAT.exec(l)))    return toIT(m[1]);
    if ((m = RE_INT_PX.exec(l)))   { const n = toIT(m[1]); if (n >= 3 && n <= 9999) return n; }
  }
  for (let d = 1; d <= bwd; d++) {
    const j = formulaIdx - d;
    if (j < 0) break;
    const l = lines[j];
    if (RE_VOCE.test(l) || RE_CAT.test(l)) break;
    let m;
    if ((m = RE_FLOAT.exec(l))) return toIT(m[1]);
  }
  return null;
}

// ─── Cerca formula misura/prezzo nel blocco di una voce ──────────────────────
function findFormula(lines, startI) {
  const MAX_SCAN = 55;

  for (let j = startI; j < Math.min(startI + MAX_SCAN, lines.length); j++) {
    const line = lines[j];

    // Nuova voce o categoria → stop
    if (RE_VOCE.test(line) || RE_CAT.test(line)) {
      return { qty: null, um: null, pu: null, imp: null, nextI: j };
    }

    let m;

    // ── TOTALE di voce composta (es. A.5 con sub-voci) ──
    if ((m = RE_TOTALE.exec(line))) {
      return { qty: null, um: 'corpo', pu: null, imp: toIT(m[1]), nextI: j + 1 };
    }

    // ── compenso a corpo ──
    if ((m = RE_CORPO.exec(line))) {
      const pu = m[1] ? toIT(m[1]) : nearbyPrice(lines, j);
      return { qty: null, um: 'corpo', pu, imp: pu, nextI: j + 1 };
    }

    // ── compenso unitario = €/UM ──
    if ((m = RE_COMP_UNIT.exec(line))) {
      const um = normUM(m[1]);
      const pu = m[2] ? toIT(m[2]) : nearbyPrice(lines, j);
      return { qty: null, um, pu, imp: null, nextI: j + 1 };
    }

    // ── c.ca X UM x ──
    if ((m = RE_CCA.exec(line))) {
      const qty = toIT(m[1]);
      const um  = normUM(m[2]);
      const pm  = RE_PU_INLINE.exec(line);
      const pu  = pm ? toIT(pm[1]) : nearbyPrice(lines, j);
      const im  = RE_IMP_INLINE.exec(line);
      const imp = im ? toIT(im[1]) : null;
      return { qty, um, pu, imp, nextI: j + 1 };
    }

    // ── n. X x (cadauno) ──
    if ((m = RE_N_X.exec(line))) {
      const qty = toIT(m[1]);
      const pm  = RE_PU_INLINE.exec(line);
      const pu  = pm ? toIT(pm[1]) : nearbyPrice(lines, j);
      const im  = RE_IMP_INLINE.exec(line);
      const imp = im ? toIT(im[1]) : null;
      return { qty, um: 'cad', pu, imp, nextI: j + 1 };
    }
  }

  return { qty: null, um: null, pu: null, imp: null, nextI: startI + MAX_SCAN };
}

// ─── Parser regex principale ──────────────────────────────────────────────────
function regexParse(lines) {
  const result = [];
  let sortOrder = 0;
  let i = 0;
  let inRiepilogo = false;
  let currentCatCodice = null;  // traccia categoria corrente (es. "A", "E-A")

  while (i < lines.length) {
    const line = lines[i];

    // ── Stop al riepilogo finale o alle opere in economia ──
    if (/riepilogo\s+dei\s+prezzi/i.test(line) || /^G\s+OPERE\s+IN\s+ECONOMIA/i.test(line)) {
      inRiepilogo = true;
    }
    if (inRiepilogo) { i++; continue; }

    // ── Salta righe di totale sezione, note, didascalie ──
    if (/^importo\s+tot/i.test(line))                continue && i++;
    if (/^TOTALE\s*=\s*€/i.test(line) && !/^([A-G])\./i.test(line)) { i++; continue; }
    if (/^individuazione\b/i.test(line))             { i++; continue; }
    if (/^vista\s+(esemplificativa|zenitale)/i.test(line)) { i++; continue; }
    if (/^legenda$/i.test(line))                     { i++; continue; }
    if (/^N\.B\./i.test(line))                       { i++; continue; }

    let m;

    // ── Categoria ──
    if ((m = RE_CAT.exec(line))) {
      let codice = m[1];
      const desc  = m[2].trim();

      // Sottocategoria "TIPO A/B/C..." per sezione E
      const tipoM = /TIPO\s+([A-G])\s*$/i.exec(desc);
      if (tipoM) codice = `${m[1]}-${tipoM[1].toUpperCase()}`;

      currentCatCodice = codice;

      result.push({
        tipo: 'categoria',
        codice,
        parent_codice: null,
        descrizione: desc,
        unita_misura: null, quantita: null,
        prezzo_unitario: null, importo: null,
        sort_order: sortOrder++,
      });
      i++; continue;
    }

    // ── Voce ──
    if ((m = RE_VOCE.exec(line))) {
      // Se siamo in una sub-categoria "E-A", il parent è "E-A" e il codice "E-A.1"
      const isSubcat = currentCatCodice && currentCatCodice.includes('-');
      const parent  = isSubcat ? currentCatCodice : m[1];
      const codice  = isSubcat ? `${currentCatCodice}.${m[2]}` : `${m[1]}.${m[2]}`;
      const descHdr = m[3].trim().slice(0, 400);

      const { qty, um, pu, imp, nextI } = findFormula(lines, i + 1);

      result.push({
        tipo: 'voce',
        codice,
        parent_codice: parent,
        descrizione: descHdr,
        unita_misura: um,
        quantita: qty,
        prezzo_unitario: pu != null ? r2(pu) : null,
        importo: imp != null ? r2(imp)
               : (qty != null && pu != null ? r2(qty * pu) : null),
        sort_order: sortOrder++,
      });

      i = nextI; continue;
    }

    i++;
  }

  return result;
}

// ─── AI fallback — UNA sola chiamata con tutte le voci irrisolte ─────────────
const AI_SYSTEM = `Sei un esperto di capitolati italiani. Ti vengono date voci di lavorazione.
Per ognuna restituisci un oggetto JSON con: codice, prezzo_unitario (numero o null), importo (numero o null).
Usa SOLO i dati presenti nel testo — non inventare prezzi. Numeri italiani: 1.500,00 → 1500.00.
Risposta: array JSON grezzo, nessun markdown.`;

async function aiResolve(vociDaRisolvere, linesCtx) {
  if (vociDaRisolvere.length === 0) return new Map();
  const client = new Anthropic();

  const payload = vociDaRisolvere.map(v =>
    `${v.codice}: ${v.descrizione}` +
    (v.unita_misura ? ` [${v.unita_misura}]` : '') +
    (v.quantita     ? ` qty=${v.quantita}`    : '')
  ).join('\n');

  console.log(`[computoParser/AI] risolvo ${vociDaRisolvere.length} voci senza prezzo`);

  const resp = await client.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    system: AI_SYSTEM,
    messages: [{ role: 'user', content: `Voci da analizzare:\n${payload}` }],
  });

  const raw   = resp.content[0]?.text?.trim() || '[]';
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  let parsed;
  try { parsed = JSON.parse(clean); } catch { parsed = []; }

  const map = new Map();
  for (const v of parsed) {
    if (v.codice) map.set(v.codice, v);
  }
  return map;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function runParse(rawLines, ctx) {
  const lines = preFilter(rawLines);
  console.log(`[computoParser/${ctx}] ${rawLines.length} righe raw → ${lines.length} dopo preFilter`);

  // Fase 1: regex
  const voci = regexParse(lines);
  const nVoci = voci.filter(v => v.tipo === 'voce').length;
  console.log(`[computoParser/${ctx}] regex → ${voci.length} elementi (${nVoci} voci)`);

  if (nVoci === 0) {
    throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');
  }

  // Fase 2: AI solo per le voci con UM ma prezzo null
  const irrisolte = voci.filter(v =>
    v.tipo === 'voce' && v.prezzo_unitario == null && v.unita_misura != null
  );

  if (irrisolte.length > 0) {
    const aiMap = await aiResolve(irrisolte, ctx);
    for (const v of irrisolte) {
      const ai = aiMap.get(v.codice);
      if (!ai) continue;
      if (ai.prezzo_unitario != null) v.prezzo_unitario = r2(ai.prezzo_unitario);
      if (ai.importo         != null) v.importo         = r2(ai.importo);
      if (v.importo == null && v.quantita != null && v.prezzo_unitario != null)
        v.importo = r2(v.quantita * v.prezzo_unitario);
    }
  }

  // Normalizza sort_order e calcola totale
  voci.forEach((v, i) => { v.sort_order = i; });
  const totale = r2(voci.filter(v => v.tipo === 'voce').reduce((s, v) => s + (v.importo || 0), 0));

  console.log(`[computoParser/${ctx}] totale contratto stimato: ${totale}`);
  return { nome: 'Capitolato speciale d\'appalto', voci, totale_contratto: totale };
}

// ─── PDF ──────────────────────────────────────────────────────────────────────
async function parsePdf(buffer) {
  const { text: raw, numPages } = await extractPdfText(buffer, { maxPages: 80 });
  if (!raw.trim()) throw new Error('Il PDF non contiene testo estraibile (documento scansionato?).');
  console.log(`[computoParser/parsePdf] ${numPages} pagine, ${raw.length} char`);
  return runParse(raw.split('\n'), 'parsePdf');
}

// ─── Excel ────────────────────────────────────────────────────────────────────
async function parseExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  let bestSheet = workbook.SheetNames[0];
  let maxCells  = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const range = xlsx.utils.decode_range(sheet['!ref'] || 'A1:A1');
    const cells = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    if (cells > maxCells) { maxCells = cells; bestSheet = name; }
  }
  const csv   = xlsx.utils.sheet_to_csv(workbook.Sheets[bestSheet], { blankrows: false });
  const lines = csv.split('\n').filter(l => l.replace(/,+/g, '').trim().length > 2);
  console.log(`[computoParser/parseExcel] "${bestSheet}", ${lines.length} righe`);
  return runParse(lines, 'parseExcel');
}

module.exports = { parsePdf, parseExcel };
