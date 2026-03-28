'use strict';
/**
 * services/computoParser.js
 * Parsing AI di computi metrici da PDF o Excel.
 * Usa Claude Sonnet per massima accuratezza su documenti economici/legali.
 */

const Anthropic = require('@anthropic-ai/sdk');
const xlsx      = require('xlsx');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 16000; // max sicuro per Sonnet 4.6 — era 8192, troppo basso per computi grandi

const SYSTEM_PROMPT = `Sei un esperto di computi metrici italiani nel settore delle costruzioni.
Analizza il documento fornito (computo metrico, lista lavorazioni, capitolato, preventivo o contratto) e restituisci SOLO un JSON valido, senza markdown, senza spiegazioni.

Struttura output:
{
  "nome": "nome/titolo del documento o cantiere se rilevabile, altrimenti 'Computo metrico'",
  "voci": [
    {
      "tipo": "categoria",
      "codice": "A",
      "descrizione": "DEMOLIZIONI E SMONTAGGIO",
      "sort_order": 0
    },
    {
      "tipo": "voce",
      "parent_codice": "A",
      "codice": "A.01",
      "descrizione": "Demolizione di muratura portante in laterizi pieni",
      "unita_misura": "m³",
      "quantita": 45.50,
      "prezzo_unitario": 85.00,
      "importo": 3867.50,
      "sort_order": 1
    }
  ]
}

REGOLE CRITICHE (documenti economici/legali — precisione assoluta):
1. Categorie/capitoli (es. "A - DEMOLIZIONI", "CAP. 1 - OPERE CIVILI") → tipo "categoria"
2. Ogni riga lavorazione → tipo "voce" con parent_codice = codice categoria
3. Se importo mancante ma ci sono quantita e prezzo_unitario → calcolalo (quantita * prezzo_unitario)
4. Se prezzo_unitario mancante ma ci sono importo e quantita → calcolalo (importo / quantita)
5. Numeri: usa il punto come decimale (non virgola). Rimuovi separatori migliaia.
6. unita_misura: abbreviazioni standard IT → m², m³, ml, kg, cad., corpo, a corpo, %, mc, mq
7. Mantieni l'ordine originale del documento (sort_order incrementale)
8. Ignora subtotali e totali di categoria (li calcoliamo noi)
9. Se non ci sono categorie esplicite → crea una categoria "Lavori" con sort_order 0
10. codice: usa quello del documento; se assente, genera alfanumerico progressivo (A, A.01, A.02...)
11. Descrizioni: mantienile complete, non troncare
12. Se un valore non è presente → null (non 0)`;

/**
 * Parsa un PDF inviandolo direttamente a Claude come documento nativo.
 * Claude legge il PDF nativo — molto più accurato di pdf-parse su tabelle complesse.
 */
async function parsePdf(buffer) {
  const client  = new Anthropic();
  const base64  = buffer.toString('base64');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          },
          {
            type: 'text',
            text: 'Analizza questo computo metrico ed estrai tutte le voci nel formato JSON richiesto. Sii preciso con ogni valore numerico.',
          },
        ],
      },
    ],
  });

  return extractJson(response.content[0].text);
}

/**
 * Parsa un file Excel convertendolo in testo strutturato per Claude.
 */
async function parseExcel(buffer) {
  const client   = new Anthropic();
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });

  // Usa il primo foglio con più contenuto
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

  // Limita a 50k char per non sforare il context window
  const truncated = csvText.length > 50000 ? csvText.slice(0, 50000) + '\n[troncato...]' : csvText;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Foglio Excel "${bestSheet}" — dati in formato CSV:\n\n${truncated}\n\nEstrai tutte le voci del computo metrico nel formato JSON richiesto.`,
      },
    ],
  });

  return extractJson(response.content[0].text);
}

/**
 * Estrae e valida il JSON dalla risposta Claude.
 * Claude a volte aggiunge testo prima/dopo il JSON — gestiamolo.
 */
function extractJson(text) {
  // Log primissimi 300 chars per debug Railway
  console.log('[computoParser] Claude raw (first 300):', text.slice(0, 300));

  // Prova prima con markdown code fence (```json ... ```)
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
    console.warn('[computoParser] nessun JSON trovato. Full text:', text.slice(0, 800));
    throw new Error('Il documento non contiene dati di computo metrico riconoscibili.');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('[computoParser] JSON.parse fallito:', e.message, '— jsonStr start:', jsonStr.slice(0, 200));
    throw new Error('Formato non parsabile. Verifica che il documento contenga un computo metrico valido.');
  }

  if (!parsed.voci || !Array.isArray(parsed.voci) || parsed.voci.length === 0) {
    console.warn('[computoParser] voci vuote. parsed keys:', Object.keys(parsed));
    throw new Error('Nessuna voce trovata nel documento. Prova con un file diverso o inserisci manualmente.');
  }

  // Normalizza e valida ogni voce
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

  // Calcola importo dove mancante
  parsed.voci.forEach(v => {
    if (v.tipo === 'voce' && v.importo === null && v.quantita !== null && v.prezzo_unitario !== null) {
      v.importo = round2(v.quantita * v.prezzo_unitario);
    }
  });

  // Calcola totale contratto
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
