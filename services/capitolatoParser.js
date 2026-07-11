'use strict';
/**
 * services/capitolatoParser.js
 * Estrae voci strutturate da un capitolato speciale d'appalto (PDF).
 *
 * Flow:
 *   1. pdfjs-dist estrae il testo pagina per pagina
 *   2. Claude Sonnet analizza il testo e restituisce JSON strutturato
 *   3. Return: { voci[], summary, totalCategorie, importoTotale }
 */

const Anthropic          = require('@anthropic-ai/sdk');
const { extractPdfText } = require('../lib/pdfExtract');
const { logUsage }       = require('../lib/ladiaUsageLog');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Massimo testo da inviare a Claude in un singolo chunk (caratteri)
const MAX_CHUNK_CHARS = 90_000;

async function extractTextFromPDF(buffer) {
  return extractPdfText(buffer, { maxPages: 80 });
}

const PARSE_SYSTEM = `Sei un esperto di capitolati speciali d'appalto e computi metrici italiani (edilizia civile, industriale, infrastrutture, impiantistica).
Il tuo compito è estrarre con la massima precisione TUTTE le VOCI DI LAVORO quantificate dal testo fornito.

REGOLE:
- Estrai OGNI voce che ha almeno UN valore numerico (prezzo, quantità o importo) — anche se mancano altri dati
- Includi anche voci con prezzo unitario ma senza quantità (formato prezzario/listino)
- Identifica la CATEGORIA/CAPITOLO di appartenenza (es. "Demolizioni", "Strutture c.a.", "Impermeabilizzazioni")
- Normalizza UM: mq, mc, ml, kg, t, h, corpo, cad — e lascia null se assente
- CONVERSIONE NUMERI ITALIANI (critica): "1.234,56" → 1234.56 | "42,50" → 42.50 | "€ 85" → 85
- Se importo_contratto manca ma hai quantita × prezzo_unitario, calcolalo
- NON inventare valori numerici — usa null se non scritto esplicitamente
- Ignora: intestazioni capitolato, articoli normativi/prescrizioni senza prezzo, note legali, firme

OUTPUT: Rispondi ESCLUSIVAMENTE con un oggetto JSON valido, senza markdown, senza testo prima o dopo:
{
  "voci": [
    {
      "codice": "A.1.1",
      "categoria": "Demolizioni e rimozioni",
      "descrizione": "Demolizione di muratura in mattoni piena, con mezzo meccanico",
      "unita_misura": "mc",
      "quantita": 12.5,
      "prezzo_unitario": 45.00,
      "importo_contratto": 562.50
    }
  ],
  "summary": "Capitolato per [tipo lavori] a [luogo]. Comprende [N] categorie: [elenco]. Importo totale: €[X].",
  "note": "eventuali note sul documento"
}`;

/**
 * Chiama Claude per estrarre voci da un chunk di testo.
 * Se il capitolato è lungo, viene diviso in più chunk e i risultati unificati.
 */
async function extractVociFromText(text, onProgress) {
  const chunks = [];
  if (text.length <= MAX_CHUNK_CHARS) {
    chunks.push(text);
  } else {
    // Dividi in finestre con overlap
    for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS - 5000) {
      chunks.push(text.slice(i, i + MAX_CHUNK_CHARS));
    }
  }

  const allVoci = [];
  let finalSummary = '';
  const usageTotal = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (let ci = 0; ci < chunks.length; ci++) {
    const pct = 20 + Math.floor((ci / chunks.length) * 55);
    if (onProgress) onProgress(
      chunks.length > 1
        ? `Analisi parte ${ci + 1}/${chunks.length}…`
        : 'Analisi AI del capitolato in corso…',
      pct
    );

    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 8000,
      system:     PARSE_SYSTEM,
      messages:   [{ role: 'user', content: `TESTO CAPITOLATO (parte ${ci + 1}/${chunks.length}):\n\n${chunks[ci]}` }],
    });

    if (msg.usage) {
      usageTotal.input_tokens                += msg.usage.input_tokens || 0;
      usageTotal.output_tokens               += msg.usage.output_tokens || 0;
      usageTotal.cache_creation_input_tokens += msg.usage.cache_creation_input_tokens || 0;
      usageTotal.cache_read_input_tokens     += msg.usage.cache_read_input_tokens || 0;
    }

    const raw = msg.content[0]?.text?.trim() || '{}';

    let parsed;
    try {
      // Rimuovi eventuali backtick markdown se Claude li aggiunge per sbaglio
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn('[capitolatoParser] JSON parse error chunk', ci, e.message);
      continue;
    }

    if (Array.isArray(parsed.voci)) {
      allVoci.push(...parsed.voci);
    }
    if (!finalSummary && parsed.summary) {
      finalSummary = parsed.summary;
    }
  }

  return { voci: allVoci, summary: finalSummary, usage: usageTotal };
}

/**
 * Entry point pubblico.
 * @param {Buffer} buffer — buffer del PDF
 * @param {string} siteId
 * @param {string} companyId
 * @param {Function} onProgress — callback(message, percent)
 * @returns {{ voci, summary, totalCategorie, importoTotale }}
 */
async function parseCapitolatoPDF(buffer, siteId, companyId, onProgress) {
  if (onProgress) onProgress('Lettura pagine PDF…', 10);

  const { text, numPages } = await extractTextFromPDF(buffer);

  if (!text.trim()) throw new Error('Il PDF non contiene testo estraibile. Assicurati che non sia scansionato (immagine).');

  if (onProgress) onProgress(`${numPages} pagine lette. Avvio analisi AI…`, 18);

  const { voci, summary, usage } = await extractVociFromText(text, onProgress);
  logUsage({ companyId, model: 'claude-sonnet-4-6', callSite: 'capitolato_parse', usage });

  // Normalizzazione
  const safeFloat = (raw) => {
    if (raw === null || raw === undefined || raw === '') return null;
    // Converti formato italiano se stringa (1.234,56 → 1234.56)
    const s = typeof raw === 'string'
      ? raw.trim().replace(/[€\s]/g, '').replace(/\.(?=\d{3}[,.])/g, '').replace(',', '.')
      : String(raw);
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  };

  const voceNorm = voci.map(v => {
    const qty = safeFloat(v.quantita);
    const pu  = safeFloat(v.prezzo_unitario);
    const imp = safeFloat(v.importo_contratto) ?? (qty != null && pu != null ? Math.round(qty * pu * 100) / 100 : null);
    return {
      codice:            String(v.codice || '').trim() || null,
      categoria:         String(v.categoria || 'Lavorazioni generali').trim(),
      descrizione:       String(v.descrizione || '').trim(),
      unita_misura:      String(v.unita_misura || '').trim() || null,
      quantita:          qty,
      prezzo_unitario:   pu,
      importo_contratto: imp,
    };
  }).filter(v => v.descrizione.length > 3);

  const categorie    = [...new Set(voceNorm.map(v => v.categoria))];
  const importoTot   = voceNorm.reduce((s, v) => s + (v.importo_contratto || 0), 0);

  return {
    voci:            voceNorm,
    summary:         summary || `Capitolato con ${voceNorm.length} voci in ${categorie.length} categorie. Importo totale: €${importoTot.toLocaleString('it-IT', { minimumFractionDigits: 2 })}.`,
    totalCategorie:  categorie.length,
    importoTotale:   importoTot,
  };
}

module.exports = { parseCapitolatoPDF };
