'use strict';
/**
 * services/computoParser.js
 * Parsing AI di computi metrici, capitolati e liste prezzi da PDF o Excel.
 */

const Anthropic      = require('@anthropic-ai/sdk');
const xlsx           = require('xlsx');
const { extractPdfText } = require('../lib/pdfExtract');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;
const MAX_CHARS  = 90_000;
const CHUNK_OVERLAP = 5_000;

const SYSTEM_PROMPT = `Sei un esperto di computi metrici e capitolati d'appalto italiani nel settore delle costruzioni.
Analizza il documento fornito e restituisci SOLO un oggetto JSON valido, senza markdown, senza backtick, senza spiegazioni.

Il documento può essere di diversi tipi:
- Computo metrico estimativo: ha descrizione, quantità, prezzo unitario e importo
- Capitolato / lista lavorazioni / richiesta di offerta (RFQ): ha descrizione e quantità, ma i prezzi unitari sono ASSENTI o in bianco — questo è normale e atteso
- Preventivo o contratto: ha tutti i dati

Struttura output:
{"nome":"titolo del documento o 'Computo metrico'","voci":[{"tipo":"categoria","codice":"A","descrizione":"DEMOLIZIONI","sort_order":0},{"tipo":"voce","parent_codice":"A","codice":"A.01","descrizione":"Demolizione muratura portante","unita_misura":"m³","quantita":45.5,"prezzo_unitario":null,"importo":null,"sort_order":1}]}

REGOLE (documento economico/legale — precisione assoluta):
1. Categorie/capitoli → tipo "categoria". Righe lavorazione → tipo "voce" con parent_codice = codice categoria.
2. Estrai TUTTE le voci che hanno una descrizione e/o una quantità, anche se prezzo_unitario è assente.
3. NON inventare prezzi. Se il prezzo unitario non è scritto nel documento → prezzo_unitario: null, importo: null.
4. Se importo mancante ma ci sono quantita e prezzo_unitario → calcolalo (q × p).
5. Se prezzo_unitario mancante ma ci sono importo e quantita → calcolalo (importo / q).
6. Numeri: punto come decimale. Rimuovi separatori migliaia.
7. unita_misura: abbreviazioni IT standard → mq, mc, ml, kg, t, h, cad, corpo, a corpo, %, lump sum
8. Mantieni ordine originale del documento (sort_order incrementale da 0).
9. Ignora subtotali, totali di categoria e totali generali.
10. Se non ci sono categorie esplicite → crea una categoria generica che rispecchi il contenuto.
11. codice: usa quello del documento; se assente, genera progressivo (A, A.01, A.02…).
12. Descrizioni fedeli al documento, complete ma concise (max 300 caratteri).
13. Valore numerico assente nel documento → null (mai 0).
14. Output: SOLO JSON grezzo, niente altro.`;

// ── PDF: estrai testo con pdfjs-dist → Claude (con chunking) ──────────────────
async function parsePdf(buffer) {
  const { text: pdfText, numPages } = await extractPdfText(buffer, { maxPages: 80 });
  if (!pdfText.trim()) throw new Error('Il PDF non contiene testo estraibile (documento scansionato?).');

  console.log(`[computoParser/parsePdf] ${numPages} pagine, ${pdfText.length} caratteri`);

  const client = new Anthropic();

  if (pdfText.length <= MAX_CHARS) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Testo estratto dal PDF (${numPages} pagine):\n\n${pdfText}\n\nEstrai tutte le voci nel formato JSON richiesto. Se i prezzi unitari sono assenti, usa null — non inventarli.`,
      }],
    });
    return processResponse(response, 'parsePdf');
  }

  // Documento lungo: dividi in chunk con overlap e unifica
  const chunks = [];
  for (let i = 0; i < pdfText.length; i += MAX_CHARS - CHUNK_OVERLAP) {
    chunks.push(pdfText.slice(i, i + MAX_CHARS));
  }
  console.log(`[computoParser/parsePdf] splitting in ${chunks.length} chunk`);

  const allVoci = [];
  let globalNome = '';

  for (let ci = 0; ci < chunks.length; ci++) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Testo estratto dal PDF — parte ${ci + 1}/${chunks.length}:\n\n${chunks[ci]}\n\nEstrai tutte le voci in questa sezione nel formato JSON richiesto.`,
      }],
    });

    const raw = response.content[0]?.text?.trim() || '{}';
    let parsed;
    try {
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn(`[computoParser/parsePdf] chunk ${ci} JSON parse error:`, e.message);
      continue;
    }
    if (!globalNome && parsed.nome) globalNome = parsed.nome;
    if (Array.isArray(parsed.voci)) allVoci.push(...parsed.voci);
  }

  if (allVoci.length === 0) throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');

  return extractJson(JSON.stringify({ nome: globalNome || 'Computo metrico', voci: allVoci }));
}

// ── Excel: xlsx → CSV → Claude ────────────────────────────────────────────────
async function parseExcel(buffer) {
  const client   = new Anthropic();
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

  console.log(`[computoParser/parseExcel] foglio "${bestSheet}", ${csvText.length} caratteri CSV`);

  if (csvText.length <= MAX_CHARS) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Foglio Excel "${bestSheet}" in formato CSV:\n\n${csvText}\n\nEstrai tutte le voci nel formato JSON richiesto. Se i prezzi unitari sono assenti, usa null — non inventarli.`,
      }],
    });
    return processResponse(response, 'parseExcel');
  }

  // Excel grande: chunking
  const chunks = [];
  for (let i = 0; i < csvText.length; i += MAX_CHARS - CHUNK_OVERLAP) {
    chunks.push(csvText.slice(i, i + MAX_CHARS));
  }
  console.log(`[computoParser/parseExcel] splitting in ${chunks.length} chunk`);

  const allVoci = [];
  let globalNome = '';

  for (let ci = 0; ci < chunks.length; ci++) {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Foglio Excel "${bestSheet}" in formato CSV — parte ${ci + 1}/${chunks.length}:\n\n${chunks[ci]}\n\nEstrai tutte le voci in questa sezione nel formato JSON richiesto.`,
      }],
    });

    const raw = response.content[0]?.text?.trim() || '{}';
    let parsed;
    try {
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn(`[computoParser/parseExcel] chunk ${ci} JSON parse error:`, e.message);
      continue;
    }
    if (!globalNome && parsed.nome) globalNome = parsed.nome;
    if (Array.isArray(parsed.voci)) allVoci.push(...parsed.voci);
  }

  if (allVoci.length === 0) throw new Error('Nessuna voce trovata nel file Excel. Verifica che contenga una lista lavorazioni.');

  return extractJson(JSON.stringify({ nome: globalNome || 'Computo metrico', voci: allVoci }));
}

// ── Processa risposta ─────────────────────────────────────────────────────────
function processResponse(response, ctx) {
  const raw = response.content[0].text;
  console.log(`[computoParser/${ctx}] stop_reason:${response.stop_reason} tokens_out:${response.usage?.output_tokens}`);

  if (response.stop_reason === 'max_tokens') {
    throw new Error('Il documento è troppo grande. Prova a dividere il computo in sezioni o usa il formato Excel.');
  }

  return extractJson(raw);
}

// ── Estrai e valida JSON ───────────────────────────────────────────────────────
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

  if (!jsonStr) {
    throw new Error('Il documento non contiene dati di computo metrico riconoscibili.');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('[computoParser] JSON.parse fallito:', e.message);
    throw new Error('Formato non parsabile. Verifica che il documento contenga un computo metrico valido.');
  }

  if (!parsed.voci || !Array.isArray(parsed.voci) || parsed.voci.length === 0) {
    throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');
  }

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
    if (v.tipo === 'voce' && v.importo === null && v.quantita !== null && v.prezzo_unitario !== null) {
      v.importo = round2(v.quantita * v.prezzo_unitario);
    }
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { parsePdf, parseExcel };
