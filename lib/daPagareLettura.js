'use strict';
// ── Da pagare: lettura di una fattura caricata (F-338) ──────────────────────
// XML / p7m / zip della fattura elettronica → dati certi (stesso lettore del
// canale email, lib/fatturaPaEnvelopeParser.js), nessuna IA.
// PDF o foto → l'IA legge fornitore, totale da pagare, scadenza e numero.
// La scadenza si prende SOLO se è scritta: mai una data inventata (la pagina
// chiede "Entro quando?"). Il file non si salva qui: lo salva la creazione.
const Anthropic = require('@anthropic-ai/sdk');
const { extractInvoiceCandidates } = require('./fatturaPaEnvelopeParser');
const { withAiLimit } = require('./concurrencyLimit');
const { logUsage } = require('./ladiaUsageLog');

const MODEL = 'claude-opus-5-5';
const IMMAGINI = ['image/jpeg', 'image/png', 'image/webp'];

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const PROMPT = `È una fattura (o un avviso di pagamento) ricevuta da un'impresa edile italiana.
Leggi: il fornitore che l'ha emessa (chi deve essere pagato, non il cliente), il totale da pagare in euro, la data di scadenza del pagamento SOLO se è scritta sul documento, il numero della fattura.
Se un dato non è scritto, lascia stringa vuota. Non calcolare né stimare la scadenza.
Se non è una fattura o un documento da pagare, leggibile=false.`;

const SCHEMA = {
  type: 'object',
  properties: {
    leggibile: { type: 'boolean' },
    fornitore: { type: 'string' },
    totale_da_pagare: { type: 'string', description: 'es. 1840.00' },
    scadenza: { type: 'string', description: 'YYYY-MM-DD oppure vuota' },
    numero_fattura: { type: 'string' },
  },
  required: ['leggibile', 'fornitore', 'totale_da_pagare', 'scadenza', 'numero_fattura'],
  additionalProperties: false,
};

/** "1.840,00" · "1840,00" · "1,840.00" · "1840.00" · "1.840" → 1840. null se non è un importo. */
function leggiImporto(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v || '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const ultimoPunto = t.lastIndexOf('.'), ultimaVirgola = t.lastIndexOf(',');
  if (ultimoPunto >= 0 && ultimaVirgola >= 0) {
    const dec = ultimoPunto > ultimaVirgola ? '.' : ',';
    t = t.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (ultimaVirgola >= 0) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(/,/g, '.');
  } else if (ultimoPunto >= 0 && /^\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, '');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const isData = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const pulisci = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Verifica pura della risposta dell'IA. null = non usabile. */
function controllaLettura(raw) {
  if (!raw || typeof raw !== 'object' || raw.leggibile !== true) return null;
  const fornitore = pulisci(typeof raw.fornitore === 'string' ? raw.fornitore : '', 160);
  const n = leggiImporto(raw.totale_da_pagare);
  if (fornitore.length < 2 || n == null || n <= 0) return null;
  return {
    fornitore,
    importo: Math.round(n * 100) / 100,
    scadenza: isData(raw.scadenza) ? raw.scadenza : null,
    numero: pulisci(typeof raw.numero_fattura === 'string' ? raw.numero_fattura : '', 40) || null,
    certa: false,
  };
}

function daXml(nome, buffer) {
  const cand = extractInvoiceCandidates(nome, buffer).find(c => c.xml && c.parsed);
  if (!cand) return null;
  const p = cand.parsed;
  if (!p.amount || p.amount <= 0 || !p.supplierName) return null;
  return {
    fornitore: pulisci(p.supplierName, 160),
    importo: Math.round(Number(p.amount) * 100) / 100,
    scadenza: isData(p.dueDate) ? p.dueDate : null,
    numero: p.docNumber ? pulisci(p.docNumber, 40) : null,
    certa: true,
    notaDiCredito: !!p.isCreditNote,
  };
}

/**
 * @returns {Promise<{fornitore, importo, scadenza, numero, certa:boolean}|null>}
 */
async function leggiFattura({ buffer, mimetype, originalname, companyId }) {
  const nome = String(originalname || 'file');
  const lower = nome.toLowerCase();
  if (/\.(xml|p7m|zip)$/.test(lower) || mimetype === 'application/xml' || mimetype === 'text/xml') {
    return daXml(nome, buffer);
  }
  const pdf = mimetype === 'application/pdf' || lower.endsWith('.pdf');
  if (!pdf && !IMMAGINI.includes(mimetype)) return null;
  const blocco = pdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } };
  const msg = await withAiLimit(() => client().beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [blocco, { type: 'text', text: PROMPT }] }],
  }));
  if (companyId) logUsage({ companyId, model: msg.model || MODEL, callSite: 'da_pagare_lettura', usage: msg.usage });
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return null;
  const text = (msg.content || []).find(b => b.type === 'text')?.text;
  if (!text) return null;
  try { return controllaLettura(JSON.parse(text)); } catch { return null; }
}

module.exports = { leggiFattura, controllaLettura, daXml, leggiImporto };
