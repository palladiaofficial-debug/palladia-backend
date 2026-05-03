'use strict';
/**
 * services/computoParser.js
 * Parsing ibrido regex+AI di capitolati speciali d'appalto italiani.
 *
 * Flusso:
 *  1. extractPdfText/xlsx → righe reali (coordinate Y pdfjs)
 *  2. preFilter → rimuove header/footer ripetuti e font spaziato
 *  3. regexParse → struttura completa; gestisce:
 *     – formula embedded nella riga voce (c.ca / n. x / corpo / comp.unitario)
 *     – prezzo galleggiante sulla riga PRECEDENTE ("85 42,50 €")
 *     – pu dopo l'unità: "€/mq 50"
 *     – riepilogo sezione (um=null) → skip + backfill importo verso voce reale
 *     – deduplicazione: prima occorrenza di ogni codice vince
 *     – filtro E.1-E.18 template se esistono E-A/E-B/… sub-categorie
 *  4. AI Haiku (UNA sola chiamata) → solo voci con um ma prezzo ancora null
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
    line = line.replace(/(?:[a-zA-ZÀ-ÿ&]\s){4,}[a-zA-ZÀ-ÿ]/g, ' ')
               .replace(/\s{2,}/g, ' ').trim();
    line = line.replace(
      /manutenzione[^.]{5,}capitolato speciale d'appalto lavori\s+pag\.\s*\d+/gi, ''
    ).trim();
    if (line.length < 2) continue;
    out.push(line);
  }
  return out;
}

// ─── Pattern ──────────────────────────────────────────────────────────────────
const RE_CAT       = /^([A-G])\s{1,6}([A-ZÀÈÉÌÒÙ][A-ZÀÈÉÌÒÙ\s\d,'àèéìòùì°.()\-]+)$/;
const RE_VOCE      = /^([A-G])\.(\d+[a-z]?)\s{1,5}(.{4,})/;
const RE_CCA       = /c\.?\s*ca\s+([\d,.]+)\s*(mq|mc|ml|kg|t\b|h\b|cad|n\b|nr\b)\s*x/i;
const RE_N_X       = /n\.\s*([\d,]+)\s*x/i;
const RE_PU_INLINE = /([\d.]+,\d{1,2})\s*€\s*\/\s*(mq|mc|ml|kg|t|h|cad|n|nr)/i;
const RE_PU_AFTER  = /€\s*\/\s*(?:mq|mc|ml|kg|t|h|cad|n|nr)\s+(\d+(?:,\d{1,2})?)/i;
const RE_IMP_INLINE= /=\s*€\s*([\d.]+(?:,\d{1,2})?)\s*€?\s*$/;
const RE_IMP_END   = /([\d]{1,3}(?:\.\d{3})*,\d{2})\s*€\s*$/;
const RE_CORPO     = /compenso\s+a\s+corpo\s*=\s*€\s*([\d.]+(?:,\d{1,2})?)?/i;
const RE_COMP_UNIT = /compenso\s+unitario\s*=\s*€\s*\/\s*(mq|mc|ml|kg|t|h|cad|n|nr)\s*([\d.]+(?:,\d{1,2})?)?/i;
const RE_TOTALE    = /^TOTALE\s*=\s*€\s*([\d.]+(?:,\d{1,2})?)/i;
const RE_FLOAT     = /^([\d]{1,3}(?:\.\d{3})*,\d{1,2})\s*€?\s*$/;
const RE_INT_PX    = /^(\d{1,4}(?:,00)?)\s*€?\s*$/;
// Riga "pu imp€" prima della voce: "85 42,50 €"
const RE_PU_IMP_PREV = /^(\d{1,4}(?:,\d{2})?)\s+([\d]{1,3}(?:\.\d{3})*,\d{2})\s*€?\s*$/;
// Pattern riepilogo: "= € ........" (stringa breve con punti/spazi)
const RE_RIEPILOGO_DESC = /=\s*€\s*[.\s…]{4,}/;

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

// ─── Formula dalla riga voce stessa ──────────────────────────────────────────
function extractFormulaFromText(text) {
  let m;
  if ((m = RE_CORPO.exec(text)))
    return { qty: null, um: 'corpo', pu: m[1] ? toIT(m[1]) : null, imp: m[1] ? toIT(m[1]) : null };
  if ((m = RE_COMP_UNIT.exec(text)))
    return { qty: null, um: normUM(m[1]), pu: m[2] ? toIT(m[2]) : null, imp: null };
  if ((m = RE_CCA.exec(text))) {
    const qty = toIT(m[1]), um = normUM(m[2]);
    const pm = RE_PU_INLINE.exec(text);
    let pu = pm ? toIT(pm[1]) : null;
    if (!pu) { const am = RE_PU_AFTER.exec(text); if (am) pu = toIT(am[1]); }
    const im = RE_IMP_INLINE.exec(text), em = RE_IMP_END.exec(text);
    return { qty, um, pu, imp: im ? toIT(im[1]) : (em ? toIT(em[1]) : null) };
  }
  if ((m = RE_N_X.exec(text))) {
    const qty = toIT(m[1]);
    const pm = RE_PU_INLINE.exec(text);
    let pu = pm ? toIT(pm[1]) : null;
    if (!pu) { const am = RE_PU_AFTER.exec(text); if (am) pu = toIT(am[1]); }
    const im = RE_IMP_INLINE.exec(text), em = RE_IMP_END.exec(text);
    return { qty, um: 'cad', pu, imp: im ? toIT(im[1]) : (em ? toIT(em[1]) : null) };
  }
  return null;
}

// ─── Prezzo galleggiante nelle righe vicine ───────────────────────────────────
function nearbyPrice(lines, baseIdx, fwd = 10, bwd = 2) {
  for (let d = 1; d <= fwd; d++) {
    const j = baseIdx + d;
    if (j >= lines.length) break;
    const l = lines[j];
    if (RE_VOCE.test(l) || RE_CAT.test(l)) break;
    if (RE_CORPO.test(l) || RE_COMP_UNIT.test(l) || RE_CCA.test(l)) break;
    if (l.split(/\s+/).length > 7 && !RE_FLOAT.test(l) && !RE_INT_PX.test(l) && !RE_PU_IMP_PREV.test(l)) continue;
    let m;
    if ((m = RE_FLOAT.exec(l)))      return toIT(m[1]);
    if ((m = RE_INT_PX.exec(l)))     { const n = toIT(m[1]); if (n >= 3 && n <= 9999) return n; }
    if ((m = RE_PU_IMP_PREV.exec(l))) return toIT(m[1]);  // "85 42,50 €" → ritorna il pu
  }
  for (let d = 1; d <= bwd; d++) {
    const j = baseIdx - d;
    if (j < 0) break;
    const l = lines[j];
    if (RE_VOCE.test(l) || RE_CAT.test(l)) break;
    let m;
    if ((m = RE_FLOAT.exec(l))) return toIT(m[1]);
  }
  return null;
}

// ─── Formula su righe successive ─────────────────────────────────────────────
function findFormula(lines, startI) {
  const MAX_SCAN = 55;
  for (let j = startI; j < Math.min(startI + MAX_SCAN, lines.length); j++) {
    const line = lines[j];
    if (RE_VOCE.test(line) || RE_CAT.test(line))
      return { qty: null, um: null, pu: null, imp: null, nextI: j };
    let m;
    if ((m = RE_TOTALE.exec(line)))
      return { qty: null, um: 'corpo', pu: null, imp: toIT(m[1]), nextI: j + 1 };
    if ((m = RE_CORPO.exec(line))) {
      const pu = m[1] ? toIT(m[1]) : nearbyPrice(lines, j);
      return { qty: null, um: 'corpo', pu, imp: pu, nextI: j + 1 };
    }
    if ((m = RE_COMP_UNIT.exec(line))) {
      const um = normUM(m[1]), pu = m[2] ? toIT(m[2]) : nearbyPrice(lines, j);
      return { qty: null, um, pu, imp: null, nextI: j + 1 };
    }
    if ((m = RE_CCA.exec(line))) {
      const qty = toIT(m[1]), um = normUM(m[2]);
      const pm = RE_PU_INLINE.exec(line);
      let pu = pm ? toIT(pm[1]) : null;
      if (!pu) { const am = RE_PU_AFTER.exec(line); if (am) pu = toIT(am[1]); }
      if (!pu) pu = nearbyPrice(lines, j);
      const im = RE_IMP_INLINE.exec(line), em = RE_IMP_END.exec(line);
      return { qty, um, pu, imp: im ? toIT(im[1]) : (em ? toIT(em[1]) : null), nextI: j + 1 };
    }
    if ((m = RE_N_X.exec(line))) {
      const qty = toIT(m[1]);
      const pm = RE_PU_INLINE.exec(line);
      let pu = pm ? toIT(pm[1]) : null;
      if (!pu) { const am = RE_PU_AFTER.exec(line); if (am) pu = toIT(am[1]); }
      if (!pu) pu = nearbyPrice(lines, j);
      const im = RE_IMP_INLINE.exec(line), em = RE_IMP_END.exec(line);
      return { qty, um: 'cad', pu, imp: im ? toIT(im[1]) : (em ? toIT(em[1]) : null), nextI: j + 1 };
    }
  }
  return { qty: null, um: null, pu: null, imp: null, nextI: startI + MAX_SCAN };
}

// ─── Parser regex principale ──────────────────────────────────────────────────
function regexParse(lines) {
  const result         = [];
  const importoBackfill = new Map();   // codice → importo da riga riepilogo
  let sortOrder        = 0;
  let i                = 0;
  let inRiepilogo      = false;
  let currentCatCodice = null;

  while (i < lines.length) {
    const line = lines[i];

    if (/riepilogo\s+dei\s+prezzi/i.test(line) || /^G\s+OPERE\s+IN\s+ECONOMIA/i.test(line))
      inRiepilogo = true;
    if (inRiepilogo) { i++; continue; }

    if (/^importo\s+tot/i.test(line))               { i++; continue; }
    if (/^TOTALE\s*=\s*€/i.test(line))              { i++; continue; }
    if (/^individuazione\b/i.test(line))             { i++; continue; }
    if (/^vista\s+(esemplificativa|zenitale)/i.test(line)) { i++; continue; }
    if (/^legenda$/i.test(line))                     { i++; continue; }
    if (/^N\.B\./i.test(line))                       { i++; continue; }

    let m;

    // ── Categoria ──
    if ((m = RE_CAT.exec(line))) {
      let codice = m[1];
      const desc = m[2].trim();
      const tipoM = /TIPO\s+([A-G])\s*$/i.exec(desc);
      if (tipoM) codice = `${m[1]}-${tipoM[1].toUpperCase()}`;
      currentCatCodice = codice;
      result.push({
        tipo: 'categoria', codice, parent_codice: null,
        descrizione: desc, unita_misura: null, quantita: null,
        prezzo_unitario: null, importo: null, sort_order: sortOrder++,
      });
      i++; continue;
    }

    // ── Voce ──
    if ((m = RE_VOCE.exec(line))) {
      const isSubcat = currentCatCodice?.includes('-');
      const parent   = isSubcat ? currentCatCodice : m[1];
      const codice   = isSubcat ? `${currentCatCodice}.${m[2]}` : `${m[1]}.${m[2]}`;
      const descHdr  = m[3].trim().slice(0, 400);

      let qty = null, um = null, pu = null, imp = null, nextI;

      // 1. Formula embedded nella riga voce stessa
      const fromLine = extractFormulaFromText(line);
      if (fromLine) {
        qty = fromLine.qty; um = fromLine.um; pu = fromLine.pu; imp = fromLine.imp;
        const ff = findFormula(lines, i + 1);
        nextI = ff.nextI;
        if (ff.imp != null) imp = ff.imp;
      } else {
        // 2. Formula su righe successive
        const ff = findFormula(lines, i + 1);
        qty = ff.qty; um = ff.um; pu = ff.pu; imp = ff.imp; nextI = ff.nextI;
      }

      // ── Se um è ancora null → riga riepilogo/sommario: estrai importo per backfill, salta ──
      if (um === null) {
        // RE_IMP_END cerca "N.NNN,NN €" a fine riga
        const em = RE_IMP_END.exec(line);
        if (em && !importoBackfill.has(codice)) {
          importoBackfill.set(codice, toIT(em[1]));
        }
        // Anche pattern "= € ..... N,NN €" nella descrizione
        if (!importoBackfill.has(codice)) {
          const rm = RE_RIEPILOGO_DESC.exec(descHdr);
          if (rm) {
            const iem = RE_IMP_END.exec(descHdr);
            if (iem) importoBackfill.set(codice, toIT(iem[1]));
          }
        }
        i++; continue;  // Salta: non è una voce reale
      }

      // 3. Prezzo sulla riga precedente: "85 42,50 €" (pdfjs floating elements)
      if (pu == null && imp == null && qty != null && i > 0) {
        const prev = lines[i - 1];
        const pm = RE_PU_IMP_PREV.exec(prev);
        if (pm) {
          pu  = toIT(pm[1]);
          imp = toIT(pm[2]);
        } else {
          const fm = RE_FLOAT.exec(prev);
          if (fm) { const n = toIT(fm[1]); if (n >= 3) pu = n; }
          else {
            const im2 = RE_INT_PX.exec(prev);
            if (im2) { const n = toIT(im2[1]); if (n >= 3 && n <= 9999) pu = n; }
          }
        }
      }

      // 4. NearbyPrice forward (fallback per voci con CCA ma senza prezzo)
      if (pu == null && imp == null && um !== 'corpo') {
        const npu = nearbyPrice(lines, i, 8, 0);
        if (npu) pu = npu;
      }

      result.push({
        tipo: 'voce', codice, parent_codice: parent,
        descrizione: descHdr, unita_misura: um, quantita: qty,
        prezzo_unitario: pu  != null ? r2(pu)  : null,
        importo: imp != null ? r2(imp)
               : (qty != null && pu != null ? r2(qty * pu) : null),
        sort_order: sortOrder++,
      });

      i = nextI; continue;
    }

    i++;
  }

  // ── Backfill importo da righe riepilogo ──────────────────────────────────────
  for (const v of result) {
    if (v.tipo !== 'voce' || v.importo != null) continue;
    const bf = importoBackfill.get(v.codice);
    if (bf == null) continue;
    v.importo = r2(bf);
    if (v.quantita != null && v.prezzo_unitario == null && v.quantita > 0)
      v.prezzo_unitario = r2(bf / v.quantita);
  }

  // ── Deduplicazione: prima occorrenza di ogni codice voce vince ───────────────
  const seen = new Set();
  const dedup = [];
  for (const v of result) {
    if (v.tipo === 'categoria') { dedup.push(v); continue; }
    if (!seen.has(v.codice)) { seen.add(v.codice); dedup.push(v); }
  }

  // ── Filtro E.X template se esistono E-A/E-B/… sub-categorie ─────────────────
  const hasESubcat = dedup.some(v => v.tipo === 'categoria' && /^E-[A-G]$/.test(v.codice));
  const final = hasESubcat
    ? dedup.filter(v => !(v.tipo === 'voce' && /^E\.\d+[a-z]?$/.test(v.codice)))
    : dedup;

  // Ricalcola sort_order
  final.forEach((v, idx) => { v.sort_order = idx; });
  return final;
}

// ─── AI fallback — UNA sola chiamata con tutte le voci irrisolte ─────────────
const AI_SYSTEM = `Sei un esperto di capitolati italiani. Ti vengono date voci di lavorazione.
Per ognuna restituisci un oggetto JSON con: codice, prezzo_unitario (numero o null), importo (numero o null).
Usa SOLO i dati presenti nel testo — non inventare prezzi. Numeri italiani: 1.500,00 → 1500.00.
Risposta: array JSON grezzo, nessun markdown.`;

async function aiResolve(vociDaRisolvere) {
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
  let parsed; try { parsed = JSON.parse(clean); } catch { parsed = []; }
  const map = new Map();
  for (const v of parsed) if (v.codice) map.set(v.codice, v);
  return map;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function runParse(rawLines, ctx) {
  const lines = preFilter(rawLines);
  console.log(`[computoParser/${ctx}] ${rawLines.length} righe raw → ${lines.length} dopo preFilter`);

  const voci  = regexParse(lines);
  const nVoci = voci.filter(v => v.tipo === 'voce').length;
  console.log(`[computoParser/${ctx}] regex → ${voci.length} elementi (${nVoci} voci)`);

  if (nVoci === 0)
    throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');

  const irrisolte = voci.filter(v =>
    v.tipo === 'voce' && v.prezzo_unitario == null && v.unita_misura != null
  );
  if (irrisolte.length > 0) {
    const aiMap = await aiResolve(irrisolte);
    for (const v of irrisolte) {
      const ai = aiMap.get(v.codice);
      if (!ai) continue;
      if (ai.prezzo_unitario != null) v.prezzo_unitario = r2(ai.prezzo_unitario);
      if (ai.importo         != null) v.importo         = r2(ai.importo);
      if (v.importo == null && v.quantita != null && v.prezzo_unitario != null)
        v.importo = r2(v.quantita * v.prezzo_unitario);
    }
  }

  voci.forEach((v, idx) => { v.sort_order = idx; });
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
  let bestSheet = workbook.SheetNames[0], maxCells = 0;
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
