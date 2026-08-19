'use strict';

/**
 * lib/expenseOcr.js
 * Estrazione AI (Claude) dei campi di una spesa da un documento immagine/PDF.
 * Estratta da routes/v1/expenses.js (POST /expenses/scan) per essere riusata anche
 * dal canale fatture via email (services/emailIngestWebhook.js) quando arriva un
 * PDF di cortesia SENZA XML/p7m companion — nessun dato strutturato disponibile,
 * stessa estrazione già in uso per lo scan manuale di scontrini/ricevute.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { withAiLimit } = require('./concurrencyLimit');
const { logUsage } = require('./ladiaUsageLog');

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const EXTRACTION_PROMPT = `Analizza questa ricevuta/scontrino/fattura ed estrai i dati. Restituisci SOLO JSON valido con questi campi:
{"amount":null,"description":null,"supplier":null,"invoice_number":null,"expense_date":null,"category":null,"payment_method":null}

Regole:
- amount: numero decimale (es. 125.50), senza simbolo €
- expense_date: formato YYYY-MM-DD
- category: una tra [materiali, carburante, utenze, assicurazioni, tasse_contributi, stipendi, affitto, attrezzature, subappalto, consulenze, manutenzione, trasporti, cancelleria, vitto_alloggio, altro] — scegli la più appropriata
- payment_method: una tra [contanti, assegno, bonifico, carta, pos, altro] — deduci dal documento se possibile, altrimenti null
- description: breve descrizione della spesa (max 100 caratteri)
- null per campi non presenti nel documento`;

async function extractExpenseFromDocument(buffer, mimetype, { companyId, userId = null, callSite = 'expense_scan' } = {}) {
  const base64 = buffer.toString('base64');
  const sourceType = mimetype === 'application/pdf' ? 'document' : 'image';

  const content = [
    { type: sourceType, source: { type: 'base64', media_type: mimetype, data: base64 } },
    { type: 'text', text: EXTRACTION_PROMPT },
  ];

  const msg = await withAiLimit(() =>
    getClient().messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content }] }),
  );
  logUsage({ companyId, userId, model: 'claude-haiku-4-5-20251001', callSite, usage: msg.usage });

  const text = msg.content[0]?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : {};
}

module.exports = { extractExpenseFromDocument };
