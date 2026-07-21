'use strict';
/**
 * services/smartImportAI.js
 * Le due chiamate Claude dell'Importazione Intelligente:
 *  1) classifySegments — classifica il file e rileva se contiene più
 *     documenti scansionati insieme (ognuno con il proprio intervallo pagine).
 *  2) extractFields — per un singolo documento (o frammento), estrae i campi
 *     riusando i prompt per tipo già in produzione (services/documentAI.js:
 *     COMPANY_DOC_PROMPT, WORKER_DOC_PROMPT), con l'aggiunta di un
 *     confidence 0-1 per ogni campo.
 *
 * Nessun nuovo prompt da zero: si estende quello che già gira in produzione.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { extractPdfText } = require('../lib/pdfExtract');
const { logUsage } = require('../lib/ladiaUsageLog');
const {
  COMPANY_DOC_PROMPT, WORKER_DOC_PROMPT, MODEL_TEXT, MODEL_VISION, MAX_TOKENS,
  extractFirstJson, normalizeDate,
} = require('./documentAI');

const DOC_TYPES = 'idoneita_medica|attestato_formazione|durc|visura|assicurazione|dvr|pos|psc|capitolato|contratto|busta_paga|f24|iso|soa|permesso|patente|altro';

const CLASSIFY_PROMPT = `Analizza il documento allegato. Può contenere UN SOLO documento oppure PIÙ documenti scansionati/uniti insieme (es. più attestati di formazione di lavoratori diversi, o DURC di più imprese, uniti in un unico PDF). Individua ogni documento distinto e per ciascuno l'intervallo di pagine che occupa.

Rispondi SOLO con JSON valido (niente markdown):
{
  "segments": [
    {
      "start_page": 1,
      "end_page": 1,
      "doc_type": "${DOC_TYPES}",
      "destination": "site_documents|company_documents|worker_documents|worker_certificates",
      "confidence": 0.0
    }
  ]
}

Regole:
- Se il file è un solo documento, restituisci un array con UN solo elemento che copre tutte le pagine.
- "confidence" indica quanto sei sicuro del tipo rilevato (1.0 = inequivocabile, es. intestazione "DURC" chiara; 0.0 = puro indovinare).
- destination: worker_documents/worker_certificates per documenti di un singolo lavoratore (idoneità medica, attestati, patenti); site_documents per documenti legati a un cantiere specifico; company_documents per documenti aziendali generali (DURC, visura, assicurazione, SOA, ISO, F24).`;

const CONFIDENCE_ADDENDUM = `

Aggiungi anche "field_confidence": un oggetto con un punteggio numerico 0.0-1.0 per ciascuno di questi campi (stessa chiave), che indica quanto sei certo del valore restituito — 1.0 = testo chiaro e univoco, 0.0 = illeggibile o dedotto. Se un campo è null, il suo field_confidence è 0.0.
Per documenti lavoratore: issued_to, fiscal_code, expiry_date, issued_by.
Per documenti aziendali/cantiere: issued_by, expiry_date, doc_type_detected.
Aggiungi anche "site_hint": se il documento riguarda un cantiere/lavoro specifico, il nome o indirizzo del cantiere se menzionato nel testo, altrimenti null.
Output: SOLO JSON grezzo senza markdown.`;

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

function contentBlockFor(buffer, mimeType) {
  const isPdf = mimeType === 'application/pdf';
  return isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
}

/**
 * Classifica il file e rileva eventuali documenti multipli. Sempre Haiku:
 * è una lettura veloce, non serve la precisione di Sonnet.
 */
async function classifySegments({ buffer, mimeType, companyId, userId }) {
  const client = getClient();
  const createOpts = {
    model: MODEL_TEXT,
    max_tokens: 1024,
    system: CLASSIFY_PROMPT,
    messages: [{ role: 'user', content: [contentBlockFor(buffer, mimeType), { type: 'text', text: 'Analizza.' }] }],
  };
  const resp = await client.messages.create(createOpts);
  logUsage({ companyId, userId, model: createOpts.model, callSite: 'smart_import_classify', usage: resp.usage });

  const raw = resp.content.find(b => b.type === 'text')?.text || '{}';
  let parsed = {};
  try { const jsonStr = extractFirstJson(raw); if (jsonStr) parsed = JSON.parse(jsonStr); } catch { /* risposta non-JSON */ }

  const segments = Array.isArray(parsed.segments) && parsed.segments.length
    ? parsed.segments.filter(s => Number.isInteger(s.start_page) && Number.isInteger(s.end_page))
    : [];

  if (segments.length === 0) {
    return { segments: [{ start_page: 1, end_page: null, doc_type: 'altro', destination: 'company_documents', confidence: 0 }] };
  }
  return { segments };
}

/**
 * Estrae i campi di un singolo documento (già isolato — 1 solo doc_type/destination),
 * riusando lo stesso prompt per tipo di documentAI.js più il confidence addendum.
 * Stessa logica testo-prima-poi-vision di documentAI.js: PDF con testo estraibile
 * va su Haiku, scansioni/immagini vanno su Sonnet.
 */
async function extractFields({ buffer, mimeType, destination, companyId, userId }) {
  const isWorkerDoc = destination === 'worker_documents' || destination === 'worker_certificates';
  const basePrompt  = isWorkerDoc ? WORKER_DOC_PROMPT : COMPANY_DOC_PROMPT;
  const systemPrompt = basePrompt + CONFIDENCE_ADDENDUM;

  const isPdf   = mimeType === 'application/pdf';
  const isImage = mimeType?.startsWith('image/');
  if (!isPdf && !isImage) return null; // Office/altro — non analizzabile

  let model = MODEL_TEXT;
  let messageContent;
  if (isPdf) {
    const { text: pdfText } = await extractPdfText(buffer, { maxPages: 30, minChars: 10 });
    if (pdfText.trim()) {
      messageContent = `Testo estratto dal PDF:\n\n${pdfText.slice(0, 15000)}\n\nAnalizza questo documento e restituisci il JSON richiesto.`;
    } else {
      model = MODEL_VISION;
      messageContent = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text: 'Analizza questo documento e restituisci il JSON richiesto.' },
      ];
    }
  } else {
    model = MODEL_VISION;
    messageContent = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
      { type: 'text', text: 'Analizza questo documento e restituisci il JSON richiesto.' },
    ];
  }

  const client = getClient();
  const resp = await client.messages.create({
    model, max_tokens: MAX_TOKENS, temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: messageContent }],
  });
  logUsage({ companyId, userId, model, callSite: 'smart_import_extract', usage: resp.usage });

  const raw = resp.content?.[0]?.text || '';
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('Claude non ha restituito un JSON valido in fase di estrazione');
  const data = JSON.parse(jsonStr);

  const fieldConf = (data.field_confidence && typeof data.field_confidence === 'object') ? data.field_confidence : {};
  const conf = (key) => {
    const v = Number(fieldConf[key]);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  };

  const renewalYears = Number.isInteger(data.renewal_years) ? data.renewal_years : null;
  const normalizedExpiry = normalizeDate(data.expiry_date);
  // worker_certificates.issue_date è NOT NULL, ma il prompt non chiede una data
  // di emissione esplicita (solo scadenza) — la deriviamo da scadenza - anni di
  // validità, stessa logica già usata da syncToFormazione in documentAI.js.
  let derivedIssueDate = null;
  if (normalizedExpiry && renewalYears) {
    const d = new Date(normalizedExpiry);
    d.setFullYear(d.getFullYear() - renewalYears);
    derivedIssueDate = d.toISOString().slice(0, 10);
  }

  const extractedFields = isWorkerDoc
    ? {
        issued_to:   { value: (data.issued_to || '').trim().slice(0, 200) || null, confidence: conf('issued_to') },
        fiscal_code: { value: /^[A-Z0-9]{16}$/.test(String(data.fiscal_code || '').toUpperCase().replace(/\s/g, '')) ? String(data.fiscal_code).toUpperCase().replace(/\s/g, '') : null, confidence: conf('fiscal_code') },
        expiry_date: { value: normalizedExpiry, confidence: conf('expiry_date') },
        issue_date:  { value: derivedIssueDate, confidence: derivedIssueDate ? conf('expiry_date') : 0 },
        issued_by:   { value: (data.issued_by || '').trim().slice(0, 200) || null, confidence: conf('issued_by') },
      }
    : {
        doc_type_detected: { value: data.doc_type_detected || null, confidence: conf('doc_type_detected') },
        expiry_date:       { value: normalizedExpiry, confidence: conf('expiry_date') },
        issued_by:         { value: (data.issued_by || '').trim().slice(0, 200) || null, confidence: conf('issued_by') },
      };

  return {
    model,
    usage: resp.usage,
    extractedFields,
    summary: (data.summary || '').slice(0, 2000) || null,
    renewalYears,
    validityOk: typeof data.validity_ok === 'boolean' ? data.validity_ok : null,
    issues: Array.isArray(data.issues) ? data.issues.slice(0, 10).map(s => String(s).slice(0, 300)) : [],
    siteHint: (data.site_hint || '').trim().slice(0, 200) || null,
  };
}

module.exports = { classifySegments, extractFields };
