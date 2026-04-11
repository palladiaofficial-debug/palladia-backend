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

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Massimo testo da inviare a Claude in un singolo chunk (caratteri)
const MAX_CHUNK_CHARS = 90_000;

/**
 * Estrae testo dal PDF usando pdfjs-dist (Node-compatible).
 */
async function extractTextFromPDF(buffer) {
  // pdfjs-dist legacy build per Node.js
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data     = new Uint8Array(buffer);
  const doc      = await pdfjsLib.getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;
  const numPages = Math.min(doc.numPages, 80); // max 80 pagine

  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    const page    = await doc.getPage(i);
    const content = await page.getTextContent();
    const text    = content.items.map(item => item.str).join(' ');
    if (text.trim().length > 20) pages.push(`--- Pagina ${i} ---\n${text}`);
  }
  return { text: pages.join('\n\n'), numPages: doc.numPages };
}

const PARSE_SYSTEM = `Sei un esperto di capitolati speciali d'appalto italiani (edilizia civile e industriale).
Il tuo compito è estrarre le VOCI DI LAVORO dal testo del capitolato fornito.

REGOLE:
- Estrai SOLO voci quantificate con prezzo unitario (ignora articoli normativi, prescrizioni tecniche, norme)
- Identifica la CATEGORIA/FASE a cui appartiene ogni voce (es. "Demolizioni", "Strutture in c.a.", "Impermeabilizzazioni", "Finiture", ecc.)
- Normalizza le unità di misura: mq, mc, ml, kg, t, h, corpo, cad, €
- Se l'importo non è esplicitamente scritto, calcolalo: quantita × prezzo_unitario
- Le categorie devono essere RAGGRUPPAMENTI LOGICI di fasi di lavoro (5-15 categorie per un capitolato medio)
- Il campo "codice" può essere vuoto se non presente nel documento

OUTPUT: Rispondi ESCLUSIVAMENTE con un oggetto JSON valido, senza markdown, senza testo prima o dopo:
{
  "voci": [
    {
      "codice": "A.1.1",
      "categoria": "Demolizioni e rimozioni",
      "descrizione": "Demolizione di muratura...",
      "unita_misura": "mc",
      "quantita": 12.5,
      "prezzo_unitario": 45.00,
      "importo_contratto": 562.50
    }
  ],
  "summary": "Capitolato per [tipo lavori] a [luogo]. Comprende [N] categorie principali: [elenco]. Importo totale contrattuale: €[X]. Fasi principali: [elenco].",
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

  return { voci: allVoci, summary: finalSummary };
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

  const { voci, summary } = await extractVociFromText(text, onProgress);

  // Normalizzazione
  const voceNorm = voci.map(v => ({
    codice:            String(v.codice || '').trim() || null,
    categoria:         String(v.categoria || 'Lavorazioni generali').trim(),
    descrizione:       String(v.descrizione || '').trim(),
    unita_misura:      String(v.unita_misura || '').trim() || null,
    quantita:          parseFloat(v.quantita) || null,
    prezzo_unitario:   parseFloat(v.prezzo_unitario) || null,
    importo_contratto: v.importo_contratto
      ? parseFloat(v.importo_contratto)
      : (v.quantita && v.prezzo_unitario ? parseFloat(v.quantita) * parseFloat(v.prezzo_unitario) : null),
  })).filter(v => v.descrizione.length > 3);

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
