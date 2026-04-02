'use strict';
/**
 * services/ladiaDocumentProcessor.js
 * Processa PDF ricevuti da Ladia via Telegram.
 *
 * Flusso:
 *   1. Riceve il buffer PDF da Telegram
 *   2. Invia a Claude con native PDF document API (base64)
 *   3. Claude estrae: tipo documento, riassunto, sezioni chiave, testo principale
 *   4. Salva il file in Supabase Storage (site-documents bucket)
 *   5. Salva il record in ladia_document_templates
 *   6. Restituisce il record salvato per la risposta all'utente
 *
 * Limite: PDF fino a 20MB (limite Telegram), testo estratto max 20k caratteri.
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../lib/supabase');
const crypto    = require('crypto');

const MODEL        = 'claude-sonnet-4-6';
const MAX_TOKENS   = 4096;
const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20 MB

const VALID_TYPES = [
  'contratto', 'capitolato', 'POS', 'PSC',
  'computo', 'fattura', 'verbale', 'preventivo',
  'lettera', 'relazione', 'altro',
];

const EXTRACTION_PROMPT = `Sei un esperto di documentazione edile e contrattualistica italiana.
Analizza questo documento PDF e restituisci SOLO un oggetto JSON valido con questa struttura esatta:

{
  "document_type": "<tipo>",
  "summary": "<riassunto>",
  "key_sections": [
    { "titolo": "<nome sezione>", "contenuto": "<testo rilevante>" }
  ],
  "extracted_text": "<testo principale>"
}

REGOLE:
- document_type: scegli tra contratto|capitolato|POS|PSC|computo|fattura|verbale|preventivo|lettera|relazione|altro
- summary: 2-4 frasi in italiano che descrivono esattamente il documento, le parti coinvolte, l'oggetto e i punti chiave
- key_sections: le 5-10 sezioni più importanti (articoli contrattuali, clausole, obblighi, prezzi, scadenze, penali, garanzie). Max 600 caratteri per sezione.
- extracted_text: il testo principale pulito, max 15000 caratteri, ometti intestazioni ripetute e numeri di pagina
- Output: SOLO JSON grezzo senza markdown, senza backtick, senza commenti`;

/**
 * Analizza un PDF con Claude e restituisce la struttura estratta.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{document_type, summary, key_sections, extracted_text}>}
 */
async function analyzePdf(pdfBuffer) {
  const client = new Anthropic();
  const base64 = pdfBuffer.toString('base64');

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        {
          type:   'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        {
          type: 'text',
          text: 'Analizza questo documento e restituisci il JSON richiesto.',
        },
      ],
    }],
    system: EXTRACTION_PROMPT,
  });

  const raw = response.content?.[0]?.text || '';

  // Estrai JSON dalla risposta (Claude a volte aggiunge testo prima/dopo)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude non ha restituito un JSON valido');

  const parsed = JSON.parse(jsonMatch[0]);

  // Valida e normalizza
  return {
    document_type:  VALID_TYPES.includes(parsed.document_type) ? parsed.document_type : 'altro',
    summary:        (parsed.summary || '').slice(0, 2000),
    key_sections:   Array.isArray(parsed.key_sections) ? parsed.key_sections.slice(0, 15) : [],
    extracted_text: (parsed.extracted_text || '').slice(0, 20000),
  };
}

/**
 * Carica il PDF in Supabase Storage.
 * @param {Buffer} buffer
 * @param {string} companyId
 * @param {string} filename
 * @returns {Promise<string>} storagePath
 */
async function uploadToStorage(buffer, companyId, filename) {
  const uuid      = crypto.randomUUID();
  const safeName  = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const path      = `${companyId}/ladia-templates/${uuid}_${safeName}`;

  const { error } = await supabase.storage
    .from('site-documents')
    .upload(path, buffer, {
      contentType:  'application/pdf',
      cacheControl: '3600',
      upsert:       false,
    });

  if (error) throw new Error(`Storage upload error: ${error.message}`);
  return path;
}

/**
 * Entry point: processa un PDF ricevuto da Ladia.
 *
 * @param {Buffer}  pdfBuffer
 * @param {string}  companyId
 * @param {string}  chatId
 * @param {string}  filename
 * @returns {Promise<object>} record salvato in ladia_document_templates
 */
async function processLadiaPdf(pdfBuffer, companyId, chatId, filename) {
  if (pdfBuffer.length > MAX_PDF_SIZE) {
    throw new Error(`PDF troppo grande (${Math.round(pdfBuffer.length / 1_000_000)}MB). Limite: 20MB.`);
  }

  // Analisi Claude + upload storage in parallelo
  const [analysis, storagePath] = await Promise.all([
    analyzePdf(pdfBuffer),
    uploadToStorage(pdfBuffer, companyId, filename).catch(err => {
      console.warn('[ladiaDocumentProcessor] storage upload failed (non bloccante):', err.message);
      return null;
    }),
  ]);

  // Salva in DB
  const { data, error } = await supabase
    .from('ladia_document_templates')
    .insert({
      company_id:          companyId,
      uploaded_by_chat_id: String(chatId),
      document_type:       analysis.document_type,
      original_filename:   filename,
      summary:             analysis.summary,
      key_sections:        analysis.key_sections,
      extracted_text:      analysis.extracted_text,
      storage_path:        storagePath,
      file_size_bytes:     pdfBuffer.length,
    })
    .select('id, document_type, summary, key_sections, original_filename')
    .single();

  if (error) throw new Error(`DB insert error: ${error.message}`);
  return data;
}

/**
 * Recupera i template di una company, con filtro opzionale per tipo.
 * Restituisce una lista breve (per il context di Ladia).
 */
async function getTemplateIndex(companyId, limit = 20) {
  const { data } = await supabase
    .from('ladia_document_templates')
    .select('id, document_type, original_filename, summary, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return data || [];
}

/**
 * Recupera il testo completo e le sezioni di un template per ID.
 */
async function getTemplateContent(companyId, templateId) {
  const { data } = await supabase
    .from('ladia_document_templates')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', templateId)
    .maybeSingle();

  return data || null;
}

/**
 * Cerca template per tipo o parola chiave nel summary/extracted_text.
 */
async function searchTemplates(companyId, tipo, query) {
  let q = supabase
    .from('ladia_document_templates')
    .select('id, document_type, original_filename, summary, key_sections, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (tipo && tipo !== 'tutti') q = q.eq('document_type', tipo);

  const { data: results } = await q;
  if (!results?.length) return [];

  // Filtra per query testuale se fornita
  if (query) {
    const q_lower = query.toLowerCase();
    return results.filter(t =>
      (t.summary || '').toLowerCase().includes(q_lower) ||
      (t.original_filename || '').toLowerCase().includes(q_lower)
    );
  }

  return results;
}

module.exports = {
  processLadiaPdf,
  getTemplateIndex,
  getTemplateContent,
  searchTemplates,
};
