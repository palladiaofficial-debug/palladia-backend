'use strict';
/**
 * services/computoParser.js
 * Parsing AI di computi metrici, capitolati e RFQ da PDF o Excel.
 *
 * Strategia:
 *  - Pre-filtro MINIMO: rimuove solo righe vuote e header/footer di pagina.
 *    Nessuna euristica che possa perdere voci di lavorazione.
 *  - Chunk da 18k char con 2k di overlap → Haiku non tronca mai il JSON.
 *  - Deduplicazione: gli item duplicati dall'overlap vengono rimossi.
 */

const Anthropic      = require('@anthropic-ai/sdk');
const xlsx           = require('xlsx');
const { extractPdfText } = require('../lib/pdfExtract');

const MODEL         = 'claude-haiku-4-5-20251001';
const MAX_TOKENS    = 6000;
const MAX_CHARS     = 10000;  // chunk piccoli → JSON output mai > 5000 token
const CHUNK_OVERLAP = 1000;

// ── Prompt ────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Sei un esperto di capitolati speciali d'appalto italiani (edilizia civile e industriale).
Analizza il testo e restituisci SOLO un oggetto JSON valido, senza markdown, senza testo prima o dopo.

TIPO DI DOCUMENTO:
- Computo metrico estimativo: ha quantità, prezzo unitario e importo
- Capitolato / lista lavorazioni / RFQ: ha quantità ma PREZZI ASSENTI — normale e atteso
- Preventivo / contratto: ha tutti i valori

STRUTTURA OUTPUT:
{"nome":"titolo del documento","voci":[
  {"tipo":"categoria","codice":"A","descrizione":"DEMOLIZIONI E RIMOZIONI","sort_order":0},
  {"tipo":"voce","parent_codice":"A","codice":"A.01","descrizione":"Demolizione di muratura portante in mattoni pieni per qualsiasi spessore, compresi ponteggi e trasporto a rifiuto","unita_misura":"mc","quantita":12.50,"prezzo_unitario":null,"importo":null,"sort_order":1}
]}

UNITÀ DI MISURA — standardizza così:
  mq  = metri quadrati (anche m², MQ)
  mc  = metri cubi (anche m³, MC)
  ml  = metri lineari (anche m.l., m/l, ML)
  kg  = chilogrammi
  t   = tonnellate (anche ton, tonn)
  h   = ore (anche ora, ore)
  cad = cadauno (anche n., nr., pz, pezzi, N)
  corpo = compenso a corpo / a corpo / a forfait / a lump sum / corpo (TUTTE queste vanno in "corpo")
  %   = percentuale
  kw  = kilowatt / kwh

NUMERI ITALIANI — converti SEMPRE in decimale con punto:
  1.500    → 1500      (punto = separatore migliaia)
  12,50    → 12.50     (virgola = decimale)
  1.500,00 → 1500.00   (formato misto)
  12.5     → 12.5      (già corretto)

REGOLE TASSATIVE:
1. Estrai TUTTE le voci con descrizione, anche se prezzo è assente → null
2. NON inventare mai prezzi, quantità o importi assenti nel testo → null
3. Categorie/capitoli/titoli di sezione → tipo "categoria". Voci di lavorazione → tipo "voce" con parent_codice = codice della categoria padre.
4. IGNORA completamente: totali di categoria, totale complessivo, sommari, riepiloghi, IVA, spese generali, oneri sicurezza (a meno che non siano voci prezzate).
5. Se non ci sono categorie esplicite → crea categoria "Lavori" con sort_order 0.
6. codice: usa quello del documento; se assente, genera progressivo (A, A.01, A.02…).
7. Descrizione: fedele al documento, completa, max 400 caratteri.
8. sort_order: incrementale da 0, mantieni l'ordine del documento.
9. Output: SOLO JSON grezzo, nessun altro testo.`;

// ── Pre-filtro MINIMO ─────────────────────────────────────────────────────────
// Rimuove solo righe vuote e header/footer di pagina tipici (numero pagina, ecc.)
// NON fa euristiche su UM o numeri: qualunque riga potrebbe contenere una voce.
function preFilter(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.length < 3) continue;
    if (/^-+\s*pagina\s+\d+\s*-+$/i.test(line)) continue;   // "--- Pagina 3 ---"
    if (/^\d+\s*[\/\-]\s*\d+$/.test(line)) continue;         // "3 / 10"
    if (/^pagina\s+\d+$/i.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n');
}

// ── Deduplicazione chunk-overlap ──────────────────────────────────────────────
// Items vicini al bordo dei chunk possono comparire due volte.
// Deduplicazione basata su codice (se presente) oppure sui primi 80 char di descrizione.
function deduplicateVoci(voci) {
  const seen  = new Set();
  const result = [];
  for (const v of voci) {
    const key = v.codice
      ? `c:${String(v.codice).trim().toLowerCase()}`
      : `d:${String(v.descrizione || '').slice(0, 80).toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(v);
  }
  return result;
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function parsePdf(buffer) {
  const { text: raw, numPages } = await extractPdfText(buffer, { maxPages: 80 });
  if (!raw.trim()) throw new Error('Il PDF non contiene testo estraibile (documento scansionato?).');

  const text = preFilter(raw);
  console.log(`[computoParser/parsePdf] ${numPages} pag, ${raw.length} → ${text.length} char`);

  return runAI(text, 'parsePdf');
}

// ── Excel ─────────────────────────────────────────────────────────────────────
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

  const sheet   = workbook.Sheets[bestSheet];
  const csvText = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
  const text    = csvText.split('\n').filter(l => l.replace(/,+/g, '').trim().length > 2).join('\n');

  console.log(`[computoParser/parseExcel] "${bestSheet}", ${csvText.length} → ${text.length} char`);

  return runAI(text, 'parseExcel');
}

// ── Core AI (chunk + dedup) ───────────────────────────────────────────────────
async function runAI(text, ctx) {
  const client = new Anthropic();

  // Documento piccolo: singola chiamata
  if (text.length <= MAX_CHARS) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: `Testo da analizzare:\n\n${text}` }],
    });
    return processResponse(response, ctx);
  }

  // Documento grande: chunking con overlap
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_CHARS - CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + MAX_CHARS));
  }
  console.log(`[computoParser/${ctx}] ${chunks.length} chunk da ~${MAX_CHARS} char`);

  const allVoci  = [];
  let globalNome = '';

  for (let ci = 0; ci < chunks.length; ci++) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{
        role:    'user',
        content: `Parte ${ci + 1} di ${chunks.length} — estrai SOLO le voci presenti in questo testo:\n\n${chunks[ci]}`,
      }],
    });

    const raw     = response.content[0]?.text?.trim() || '{}';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    const stopReason = response.stop_reason;
    const tokensOut  = response.usage?.output_tokens;

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn(`[computoParser/${ctx}] chunk ${ci} TRONCATO (stop:${stopReason} tok:${tokensOut}):`, e.message);
      const recovered = recoverVociFromTruncated(cleaned);
      console.log(`[computoParser/${ctx}] chunk ${ci} recuperate ${recovered.length} voci parziali`);
      allVoci.push(...recovered);
      continue;
    }

    const n = Array.isArray(parsed.voci) ? parsed.voci.length : 0;
    console.log(`[computoParser/${ctx}] chunk ${ci} OK — ${n} voci (stop:${stopReason} tok:${tokensOut})`);
    if (!globalNome && parsed.nome) globalNome = parsed.nome;
    if (Array.isArray(parsed.voci)) allVoci.push(...parsed.voci);
  }

  if (allVoci.length === 0)
    throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');

  const deduped = deduplicateVoci(allVoci);
  console.log(`[computoParser/${ctx}] ${allVoci.length} voci raw → ${deduped.length} dopo dedup`);

  return extractJson(JSON.stringify({ nome: globalNome || 'Computo metrico', voci: deduped }));
}

// ── Processa risposta singola ─────────────────────────────────────────────────
function processResponse(response, ctx) {
  const raw = response.content[0].text;
  console.log(`[computoParser/${ctx}] stop_reason:${response.stop_reason} tokens_out:${response.usage?.output_tokens}`);

  if (response.stop_reason === 'max_tokens') {
    const recovered = recoverVociFromTruncated(raw);
    if (recovered.length > 0) {
      console.warn(`[computoParser/${ctx}] max_tokens — recuperate ${recovered.length} voci parziali`);
      return extractJson(JSON.stringify({ nome: 'Computo metrico', voci: recovered }));
    }
    throw new Error('Documento troppo grande anche dopo pre-filtro. Dividi il file in sezioni.');
  }

  return extractJson(raw);
}

// ── Recupera voci da JSON troncato ────────────────────────────────────────────
function recoverVociFromTruncated(text) {
  const start = text.indexOf('"voci"');
  if (start === -1) return [];
  const arrStart = text.indexOf('[', start);
  if (arrStart === -1) return [];

  const voci = [];
  let depth = 0, objStart = -1;
  for (let i = arrStart; i < text.length; i++) {
    if (text[i] === '{')      { if (depth === 0) objStart = i; depth++; }
    else if (text[i] === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { voci.push(JSON.parse(text.slice(objStart, i + 1))); } catch (_) {}
        objStart = -1;
      }
    }
  }
  return voci;
}

// ── Estrai e normalizza JSON ──────────────────────────────────────────────────
function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch
    ? fenceMatch[1].trim()
    : (() => {
        const s = text.indexOf('{'), e = text.lastIndexOf('}');
        return (s !== -1 && e !== -1) ? text.slice(s, e + 1) : null;
      })();

  if (!jsonStr) throw new Error('Il documento non contiene dati di computo metrico riconoscibili.');

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('Formato non parsabile. Verifica che il documento contenga un computo metrico valido.');
  }

  if (!parsed.voci || !Array.isArray(parsed.voci) || parsed.voci.length === 0)
    throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');

  parsed.voci = parsed.voci.map((v, i) => ({
    tipo:            ['categoria', 'voce'].includes(v.tipo) ? v.tipo : 'voce',
    parent_codice:   v.parent_codice || null,
    codice:          v.codice || null,
    descrizione:     String(v.descrizione || '').trim().slice(0, 500) || 'Voce senza descrizione',
    unita_misura:    v.unita_misura ? String(v.unita_misura).slice(0, 20) : null,
    quantita:        toNumber(v.quantita),
    prezzo_unitario: toNumber(v.prezzo_unitario),
    importo:         toNumber(v.importo),
    sort_order:      typeof v.sort_order === 'number' ? v.sort_order : i,
  }));

  // Calcola importo se mancante
  parsed.voci.forEach(v => {
    if (v.tipo === 'voce' && v.importo === null && v.quantita !== null && v.prezzo_unitario !== null)
      v.importo = round2(v.quantita * v.prezzo_unitario);
  });

  parsed.totale_contratto = round2(
    parsed.voci.filter(v => v.tipo === 'voce').reduce((s, v) => s + (v.importo || 0), 0)
  );

  return parsed;
}

// ── Utility ───────────────────────────────────────────────────────────────────
function toNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = typeof val === 'string'
    ? parseFloat(val.replace(/\./g, '').replace(',', '.'))
    : Number(val);
  return isNaN(n) ? null : n;
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { parsePdf, parseExcel };
