'use strict';
/**
 * services/computoParser.js
 * Parsing AI di computi metrici da PDF o Excel.
 * Usa Claude Sonnet 4.6 con native PDF document API.
 */

const Anthropic = require('@anthropic-ai/sdk');
const xlsx      = require('xlsx');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;
const MAX_CHARS  = 50000;

const SYSTEM_PROMPT = `Sei un esperto di computi metrici italiani nel settore delle costruzioni.
Analizza il documento fornito (computo metrico, lista lavorazioni, capitolato, preventivo o contratto) e restituisci SOLO un oggetto JSON valido, senza markdown, senza backtick, senza spiegazioni.

Struttura output:
{"nome":"titolo del documento o 'Computo metrico'","voci":[{"tipo":"categoria","codice":"A","descrizione":"DEMOLIZIONI","sort_order":0},{"tipo":"voce","parent_codice":"A","codice":"A.01","descrizione":"Demolizione muratura portante","unita_misura":"m³","quantita":45.5,"prezzo_unitario":85.0,"importo":3867.5,"sort_order":1}]}

REGOLE (documento economico/legale — precisione assoluta):
1. Categorie/capitoli → tipo "categoria". Righe lavorazione → tipo "voce" con parent_codice = codice categoria.
2. Se importo mancante ma ci sono quantita e prezzo_unitario → calcolalo (q × p).
3. Se prezzo_unitario mancante ma ci sono importo e quantita → calcolalo.
4. Numeri: punto come decimale. Rimuovi separatori migliaia.
5. unita_misura: abbreviazioni IT → m², m³, ml, kg, cad, corpo, a corpo, %, mc, mq
6. Mantieni ordine originale (sort_order incrementale da 0).
7. Ignora subtotali e totali di categoria.
8. Se non ci sono categorie esplicite → crea categoria "Lavori" con sort_order 0.
9. codice: usa quello del documento; se assente, genera progressivo (A, A.01...).
10. Descrizioni complete ma concise (max 200 caratteri).
11. Valore assente → null (non 0).
12. Output: SOLO JSON grezzo, niente altro.`;

// ── PDF: native document API ──────────────────────────────────────────────────
async function parsePdf(buffer) {
  const client = new Anthropic();
  const base64 = buffer.toString('base64');

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        {
          type: 'text',
          text: 'Estrai tutte le voci del computo metrico nel formato JSON richiesto. Sii preciso con ogni valore numerico.',
        },
      ],
    }],
  });

  return processResponse(response, 'parsePdf');
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

  const sheet     = workbook.Sheets[bestSheet];
  const csvText   = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
  const truncated = csvText.length > MAX_CHARS
    ? csvText.slice(0, MAX_CHARS) + '\n[troncato...]'
    : csvText;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     SYSTEM_PROMPT,
    messages: [{
      role:    'user',
      content: `Foglio Excel "${bestSheet}" in formato CSV:\n\n${truncated}\n\nEstrai tutte le voci del computo metrico nel formato JSON richiesto.`,
    }],
  });

  return processResponse(response, 'parseExcel');
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
