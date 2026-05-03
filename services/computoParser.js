'use strict';
/**
 * services/computoParser.js
 * Parsing AI di computi metrici, capitolati e liste prezzi da PDF o Excel.
 *
 * Strategia:
 *   1. Pre-filtraggio euristico: mantieni solo le righe che assomigliano a
 *      voci di lavorazione (contengono UM, numeri, codici articolo).
 *      Riduce tipicamente un capitolato da 95k → 15-25k caratteri.
 *   2. Una singola chiamata Haiku sul testo ridotto.
 *   3. Chunking solo se il testo filtrato supera ancora MAX_CHARS.
 */

const Anthropic      = require('@anthropic-ai/sdk');
const xlsx           = require('xlsx');
const { extractPdfText } = require('../lib/pdfExtract');

const MODEL      = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4096;
const MAX_CHARS  = 30000;   // soglia per chunk (su testo già pre-filtrato)
const CHUNK_OVERLAP = 2000;

// ── Pattern per identificare righe di lavorazione ────────────────────────────
const UM_RE     = /\b(mq|m²|mc|m³|ml|m\.l\.|kg|tonn?|t\b|h\b|ora[e]?|cad|corpo|a\s+corpo|n\b|nr\b|pz\b|%|lump\s+sum)\b/i;
const NUMBER_RE = /\b\d{1,6}([.,]\d{1,3})?\b/;
const CODICE_RE = /^[A-Z]{0,3}\d+([.\-/]\d+){0,3}\s/;
const CAPS_RE   = /^[A-Z\s\d\-–—:]{6,80}$/;  // intestazioni categoria

/**
 * Riduce il testo del documento tenendo solo i segmenti rilevanti.
 * pdfjs-dist restituisce ogni pagina come un'unica stringa senza newline interni:
 * prima spezziamo le righe lunghe in segmenti da ~250 char, poi filtriamo.
 */
function preFilter(text) {
  // Step 1: segmenta — gestisce sia testo con newline sia pagine-monoblocco
  const segments = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.length <= 300) {
      segments.push(line);
    } else {
      // Riga lunga (tipica di pdfjs): spezza a word-boundary ogni ~250 char
      let i = 0;
      while (i < line.length) {
        let end = Math.min(i + 250, line.length);
        if (end < line.length) {
          const sp = line.lastIndexOf(' ', end);
          if (sp > i + 40) end = sp;
        }
        const chunk = line.slice(i, end).trim();
        if (chunk.length > 2) segments.push(chunk);
        i = end;
      }
    }
  }

  // Step 2: punteggio e selezione
  const keep = new Set();
  segments.forEach((seg, i) => {
    if (seg.length < 4) return;
    let score = 0;
    if (UM_RE.test(seg))     score += 3;
    if (NUMBER_RE.test(seg)) score += 1;
    if (CODICE_RE.test(seg)) score += 2;
    if (CAPS_RE.test(seg) && seg.length >= 6 && seg.length <= 80) score += 2;

    if (score >= 3) {
      if (i > 0) keep.add(i - 1);
      keep.add(i);
      if (i < segments.length - 1) keep.add(i + 1);
    }
  });

  // Tieni sempre header di capitolo/categoria
  segments.forEach((seg, i) => {
    if (/^(capo|capitolo|categoria|sezione|art\.?|voce)\s+\d/i.test(seg)) keep.add(i);
    if (CAPS_RE.test(seg) && seg.length >= 6 && seg.length <= 80) keep.add(i);
  });

  return [...keep].sort((a, b) => a - b).map(i => segments[i]).join('\n');
}

const SYSTEM_PROMPT = `Sei un esperto di capitolati d'appalto italiani (edilizia civile e industriale).
Analizza il testo fornito ed estrai le voci di lavorazione nel formato JSON richiesto.

Il documento può avere prezzi (computo metrico) oppure prezzi assenti (capitolato/RFQ) — entrambi sono validi.

Struttura output:
{"nome":"titolo del documento","voci":[{"tipo":"categoria","codice":"A","descrizione":"DEMOLIZIONI","sort_order":0},{"tipo":"voce","parent_codice":"A","codice":"A.01","descrizione":"Demolizione muratura portante","unita_misura":"mc","quantita":45.5,"prezzo_unitario":null,"importo":null,"sort_order":1}]}

REGOLE:
1. Categorie/capitoli → tipo "categoria". Voci di lavorazione → tipo "voce" con parent_codice = codice categoria.
2. Estrai TUTTE le voci con descrizione e/o quantità, anche se il prezzo è assente.
3. NON inventare prezzi — se non presenti nel testo usa null.
4. Calcola importo solo se hai sia quantita che prezzo_unitario (q × p).
5. Numeri: usa punto come decimale, rimuovi separatori migliaia.
6. unita_misura: abbreviazioni standard → mq, mc, ml, kg, t, h, cad, corpo, %, lump sum
7. Mantieni l'ordine originale (sort_order incrementale da 0).
8. Ignora subtotali e totali.
9. codice: dal documento; se assente genera progressivo (A, A.01…).
10. Descrizioni fedeli al documento, max 300 caratteri.
11. Valore numerico assente → null (non 0).
12. Output: SOLO JSON grezzo, niente altro.`;

// ── PDF ───────────────────────────────────────────────────────────────────────
async function parsePdf(buffer) {
  const { text: raw, numPages } = await extractPdfText(buffer, { maxPages: 80 });
  if (!raw.trim()) throw new Error('Il PDF non contiene testo estraibile (documento scansionato?).');

  const filtered = preFilter(raw);
  console.log(`[computoParser/parsePdf] ${numPages} pag, ${raw.length} → ${filtered.length} char dopo pre-filtro`);

  if (!filtered.trim()) throw new Error('Il documento non contiene voci di lavorazione riconoscibili.');

  return runAI(filtered, 'parsePdf');
}

// ── Excel ─────────────────────────────────────────────────────────────────────
async function parseExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });

  // Scegli il foglio con più celle
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

  // Per Excel il testo è già strutturato — pre-filtro leggero (solo righe con contenuto)
  const filtered = csvText.split('\n')
    .filter(l => l.replace(/,+/g, '').trim().length > 2)
    .join('\n');

  console.log(`[computoParser/parseExcel] foglio "${bestSheet}", ${csvText.length} → ${filtered.length} char`);

  return runAI(filtered, 'parseExcel');
}

// ── Chiama Haiku (con chunking se necessario) ─────────────────────────────────
async function runAI(text, ctx) {
  const client = new Anthropic();

  if (text.length <= MAX_CHARS) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Testo da analizzare:\n\n${text}` }],
    });
    return processResponse(response, ctx);
  }

  // Chunking per documenti ancora grandi dopo il pre-filtro
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_CHARS - CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + MAX_CHARS));
  }
  console.log(`[computoParser/${ctx}] splitting in ${chunks.length} chunk da ~${MAX_CHARS} char`);

  const allVoci = [];
  let globalNome = '';

  for (let ci = 0; ci < chunks.length; ci++) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Parte ${ci + 1}/${chunks.length}:\n\n${chunks[ci]}` }],
    });

    const raw     = response.content[0]?.text?.trim() || '{}';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn(`[computoParser/${ctx}] chunk ${ci} JSON troncato, recupero parziale:`, e.message);
      const recovered = recoverVociFromTruncated(cleaned);
      console.log(`[computoParser/${ctx}] recuperate ${recovered.length} voci`);
      allVoci.push(...recovered);
      continue;
    }
    if (!globalNome && parsed.nome) globalNome = parsed.nome;
    if (Array.isArray(parsed.voci)) allVoci.push(...parsed.voci);
  }

  if (allVoci.length === 0)
    throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');

  return extractJson(JSON.stringify({ nome: globalNome || 'Computo metrico', voci: allVoci }));
}

// ── Processa risposta singola ─────────────────────────────────────────────────
function processResponse(response, ctx) {
  const raw = response.content[0].text;
  console.log(`[computoParser/${ctx}] stop_reason:${response.stop_reason} tokens_out:${response.usage?.output_tokens}`);

  if (response.stop_reason === 'max_tokens') {
    const recovered = recoverVociFromTruncated(raw);
    if (recovered.length > 0) {
      console.warn(`[computoParser/${ctx}] max_tokens raggiunto — recuperate ${recovered.length} voci parziali`);
      return extractJson(JSON.stringify({ nome: 'Computo metrico', voci: recovered }));
    }
    throw new Error('Il documento è troppo grande anche dopo il pre-filtro. Prova a dividerlo in sezioni.');
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
    if (text[i] === '{') { if (depth === 0) objStart = i; depth++; }
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
        const start = text.indexOf('{');
        const end   = text.lastIndexOf('}');
        if (start === -1 || end === -1) return null;
        return text.slice(start, end + 1);
      })();

  if (!jsonStr) throw new Error('Il documento non contiene dati di computo metrico riconoscibili.');

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('[computoParser] JSON.parse fallito:', e.message);
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

  parsed.voci.forEach(v => {
    if (v.tipo === 'voce' && v.importo === null && v.quantita !== null && v.prezzo_unitario !== null)
      v.importo = round2(v.quantita * v.prezzo_unitario);
  });

  parsed.totale_contratto = round2(
    parsed.voci.filter(v => v.tipo === 'voce').reduce((s, v) => s + (v.importo || 0), 0)
  );

  return parsed;
}

function toNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = typeof val === 'string'
    ? parseFloat(val.replace(/\./g, '').replace(',', '.'))
    : Number(val);
  return isNaN(n) ? null : n;
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { parsePdf, parseExcel };
