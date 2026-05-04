'use strict';
/**
 * services/visionParser.js
 * Parser offerte economiche via Claude native PDF support.
 *
 * Percorso principale  → PDF base64 + document block → Claude legge visivamente
 * Percorso fallback    → text extraction + AI chunked (per PDF > 30MB)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { extractPdfText } = require('../lib/pdfExtract');

const MODEL         = 'claude-haiku-4-5-20251001';
const MAX_PDF_BYTES = 30 * 1024 * 1024;

// ─── Normalizzazione ──────────────────────────────────────────────────────────
function toFloat(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

const UM_MAP = {
  'mq':'mq', 'm²':'mq', 'm2':'mq', 'm.q.':'mq',
  'mc':'mc', 'm³':'mc', 'm3':'mc', 'm.c.':'mc',
  'ml':'ml', 'm.l.':'ml', 'm/l':'ml',
  'kg':'kg', 't':'t', 'ton':'t', 'tonn':'t',
  'h':'h', 'ora':'h', 'ore':'h',
  'cad':'cad', 'n':'cad', 'nr':'cad', 'n.':'cad', 'pz':'cad', 'pezzi':'cad',
  'corpo':'corpo', 'a corpo':'corpo', 'corp.':'corpo',
  'l':'l', 'lt':'l', 'litro':'l', 'litri':'l',
  'kw':'kw', 'kwh':'kwh', 'g':'g',
};
function normUM(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().trim().replace(/\.$/, '');
  return UM_MAP[key] || key;
}

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }

function normalizeItem(raw) {
  const tipo = raw.tipo === 'categoria' ? 'categoria' : 'voce';
  const qty  = toFloat(raw.quantita);
  const pu   = toFloat(raw.prezzo_unitario);
  let   imp  = toFloat(raw.importo);
  if (imp == null && qty != null && pu != null) imp = r2(qty * pu);
  return {
    tipo,
    codice:          raw.codice ? String(raw.codice).trim().slice(0, 50) : null,
    parent_codice:   null,
    descrizione:     String(raw.descrizione || '').trim().slice(0, 500),
    unita_misura:    normUM(raw.unita_misura),
    quantita:        qty != null ? r2(qty) : null,
    prezzo_unitario: pu  != null ? r2(pu)  : null,
    importo:         imp,
    sort_order:      0,
  };
}

function resolveParents(items) {
  let lastCat = null;
  for (const item of items) {
    if (item.tipo === 'categoria') {
      lastCat = item.codice;
    } else {
      item.parent_codice = lastCat;
    }
  }
  items.forEach((v, idx) => { v.sort_order = idx; });
  return items;
}

function parseJsonSafe(raw) {
  const clean = (raw || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { return []; }
}

// ─── System prompt — lettura visiva PDF ───────────────────────────────────────
const VISION_SYSTEM = `Sei un esperto di offerte economiche, computi metrici e capitolati d'appalto italiani.
Il tuo unico compito è estrarre TUTTE le voci di lavorazione da questo documento.

Il documento può avere QUALSIASI formato:
- Tabella con colonne (descrizione | UM | quantità | prezzo | importo)
- Testo narrativo con voci numerate o con punti elenco
- Descrizioni lunghe su più righe con prezzo in fondo
- Prezzi all'inizio, nel mezzo o alla fine di ogni voce
- Prezzi raccolti tutti in fondo al documento in un riepilogo
- Formato prezzario (solo descrizione + UM + prezzo unitario, senza quantità)
- Tabelle in colonne non allineate, dati sparsi sulla pagina
- Mix di tabelle e testo libero nello stesso documento

PER OGNI VOCE restituisci un oggetto JSON con questi campi esatti:
{
  "tipo": "categoria" | "voce",
  "codice": string | null,
  "descrizione": string,
  "unita_misura": string | null,
  "quantita": number | null,
  "prezzo_unitario": number | null,
  "importo": number | null
}

REGOLE ASSOLUTE:
1. Includi TUTTE le voci, anche quelle senza prezzo o senza quantità
2. Converti i numeri dal formato italiano: "1.234,56" → 1234.56 | "42,50" → 42.50
3. NON inventare valori numerici — metti null se non è scritto esplicitamente nel documento
4. Mantieni l'ordine esatto del documento
5. Se ci sono categorie o capitoli, inseriscili come tipo:"categoria" prima delle voci relative
6. Per voci con prezzi in fondo al documento, collegali alle descrizioni corrispondenti
7. IGNORA: intestazioni, numeri di pagina, totali generali, note legali, firme, data, bolli

Restituisci SOLO l'array JSON. Zero testo aggiuntivo, zero markdown.`;

// ─── Parse via documento nativo (percorso principale) ────────────────────────
async function parseWithVision(buffer) {
  const client = new Anthropic();
  const base64 = buffer.toString('base64');

  console.log(`[visionParser] PDF ${(buffer.length / 1024).toFixed(0)}KB → Claude document (vision)`);

  const resp = await client.messages.create({
    model:      MODEL,
    max_tokens: 8192,
    system:     VISION_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type:       'base64',
            media_type: 'application/pdf',
            data:       base64,
          },
        },
        {
          type: 'text',
          text: 'Estrai tutte le voci di lavorazione. Restituisci SOLO il JSON array.',
        },
      ],
    }],
  });

  console.log(`[visionParser] token usati: input=${resp.usage?.input_tokens} output=${resp.usage?.output_tokens}`);
  return parseJsonSafe(resp.content[0]?.text?.trim() || '[]');
}

// ─── System prompt — text fallback ───────────────────────────────────────────
const TEXT_SYSTEM = `Sei un esperto di offerte economiche e computi metrici italiani.
Estrai TUTTE le voci di lavorazione dal testo seguente (estratto da PDF, potrebbe essere imperfetto).

PER OGNI VOCE restituisci:
{
  "tipo": "categoria" | "voce",
  "codice": string | null,
  "descrizione": string,
  "unita_misura": string | null,
  "quantita": number | null,
  "prezzo_unitario": number | null,
  "importo": number | null
}

Converti numeri italiani: "1.234,56" → 1234.56
Includi TUTTE le voci anche senza prezzo. NON inventare numeri.
Restituisci SOLO l'array JSON.`;

async function parseTextChunk(text, client, idx, total) {
  console.log(`[visionParser/text] chunk ${idx}/${total} (${text.length} char)`);
  const resp = await client.messages.create({
    model:      MODEL,
    max_tokens: 8192,
    system:     TEXT_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  return parseJsonSafe(resp.content[0]?.text?.trim() || '[]');
}

async function parseWithText(buffer) {
  const { text, numPages } = await extractPdfText(buffer, { maxPages: 80 });
  if (!text.trim())
    throw new Error('Il PDF non contiene testo estraibile (scansionato o protetto da password).');

  const lines   = text.split('\n').filter(l => l.trim().length > 1);
  const CHUNK   = 400;
  const OVERLAP = 30;
  const chunks  = [];
  for (let i = 0; i < lines.length; i += CHUNK - OVERLAP) {
    chunks.push(lines.slice(i, i + CHUNK).join('\n'));
    if (i + CHUNK >= lines.length) break;
  }

  console.log(`[visionParser/text] ${numPages}p, ${lines.length} righe → ${chunks.length} chunk`);

  const client   = new Anthropic();
  const allItems = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    try {
      const items = await parseTextChunk(chunks[ci], client, ci + 1, chunks.length);
      allItems.push(...items);
    } catch (e) {
      console.error(`[visionParser/text] chunk ${ci + 1} errore:`, e.message);
    }
  }
  return allItems;
}

// ─── Deduplicazione ───────────────────────────────────────────────────────────
function score(item) {
  return (item.quantita        != null ? 1 : 0) +
         (item.prezzo_unitario != null ? 1 : 0) +
         (item.importo         != null ? 1 : 0) +
         (item.unita_misura    != null ? 1 : 0);
}

function deduplicateItems(rawItems) {
  const out    = [];
  const byCode = new Map();
  const byDesc = new Map();

  for (const raw of rawItems) {
    if (!raw.descrizione) continue;
    const item = normalizeItem(raw);
    if (!item.descrizione.trim()) continue;

    if (item.codice) {
      const ex = byCode.get(item.codice);
      if (ex !== undefined) {
        if (score(item) > score(out[ex])) out[ex] = item;
        continue;
      }
      byCode.set(item.codice, out.length);
    } else {
      const key = item.descrizione.slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
      const ex  = byDesc.get(key);
      if (ex !== undefined) {
        if (score(item) > score(out[ex])) out[ex] = item;
        continue;
      }
      byDesc.set(key, out.length);
    }
    out.push(item);
  }
  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function parseOfferPdf(buffer) {
  if (buffer.length > 50 * 1024 * 1024)
    throw new Error('Il file è troppo grande (max 50MB). Comprimi il PDF o dividilo in più parti.');

  let rawItems;

  if (buffer.length <= MAX_PDF_BYTES) {
    try {
      rawItems = await parseWithVision(buffer);
      if (rawItems.filter(v => v.tipo !== 'categoria').length < 2) {
        console.warn('[visionParser] vision ha trovato < 2 voci, provo text fallback');
        rawItems = await parseWithText(buffer);
      }
    } catch (e) {
      console.warn('[visionParser] vision fallito, provo text:', e.message);
      rawItems = await parseWithText(buffer);
    }
  } else {
    console.log(`[visionParser] PDF ${(buffer.length / 1024 / 1024).toFixed(1)}MB > 30MB → text fallback`);
    rawItems = await parseWithText(buffer);
  }

  const items    = deduplicateItems(rawItems);
  const resolved = resolveParents(items);
  const nVoci    = resolved.filter(v => v.tipo === 'voce').length;

  console.log(`[visionParser] risultato finale: ${resolved.length} elementi (${nVoci} voci)`);

  if (nVoci === 0)
    throw new Error('Nessuna voce trovata nel documento. Verifica che il file contenga un elenco di lavorazioni.');

  const totale = r2(resolved.filter(v => v.tipo === 'voce').reduce((s, v) => s + (v.importo || 0), 0));

  return { nome: 'Offerta economica', voci: resolved, totale_contratto: totale };
}

module.exports = { parseOfferPdf };
