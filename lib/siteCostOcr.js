'use strict';

/**
 * lib/siteCostOcr.js
 * Estrazione AI (Claude Vision) dei campi di un costo cantiere — fattura, DDT
 * o ricevuta — da un'immagine o PDF. Estratta da routes/v1/siteCosts.js
 * (POST /sites/:siteId/costs/ocr) per essere riusata anche dal caricamento
 * DDT via badge dei trasportatori interni (routes/v1/badgeDdt.js) — stessa
 * lettura, due punti di ingresso diversi (utente autenticato vs badge).
 * A differenza di lib/expenseOcr.js (spese generali aziendali, niente
 * `tipo`), qui il documento è sempre legato a UN cantiere e distingue
 * esplicitamente fattura/ddt/acconto/ritenuta/altro.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { logUsage } = require('./ladiaUsageLog');

let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _ai;
}

const TIPI       = ['fattura', 'ddt', 'acconto', 'ritenuta', 'altro'];
const CATEGORIE  = ['Materiali', 'Subappalto', 'Nolo', 'Manodopera extra', 'Trasporti', 'Forniture', 'Oneri sicurezza', 'Altro'];

const PROMPT = `Sei un assistente per la gestione cantieri edili. Leggi questo documento (fattura, DDT o ricevuta) ed estrai le informazioni in JSON con questi campi:
- descrizione: breve descrizione del bene/servizio (max 100 caratteri, in italiano)
- importo: importo totale del documento come numero decimale (usa il punto come separatore, non la virgola). Se non trovi un importo totale chiaro, usa null.
- fornitore: nome del fornitore/emittente. Null se non presente.
- numero_documento: numero fattura/DDT (es. "2025/0042"). Null se non presente.
- data_documento: data del documento in formato YYYY-MM-DD. Null se non presente.
- tipo: uno tra "fattura", "ddt", "acconto", "ritenuta", "altro"
- categoria: una tra "Materiali", "Subappalto", "Nolo", "Manodopera extra", "Trasporti", "Forniture", "Oneri sicurezza", "Altro"

Rispondi SOLO con JSON valido, nessun testo aggiuntivo.`;

async function extractSiteCostFromDocument(buffer, mimetype, { companyId, userId = null, callSite = 'site_costs_ocr' } = {}) {
  const b64   = buffer.toString('base64');
  const isPdf = mimetype === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mimetype,          data: b64 } };

  const msg = await getAI().messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }],
  });
  logUsage({ companyId, userId, model: 'claude-haiku-4-5-20251001', callSite, usage: msg.usage });

  const raw  = msg.content.find(b => b.type === 'text')?.text?.trim() || '{}';
  const json = raw.startsWith('```') ? raw.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim() : raw;
  const data = JSON.parse(json);

  return {
    descrizione:      typeof data.descrizione      === 'string' ? data.descrizione.slice(0, 100)  : '',
    importo:          typeof data.importo          === 'number' ? String(data.importo)             : '',
    fornitore:        typeof data.fornitore        === 'string' ? data.fornitore.slice(0, 100)     : '',
    numero_documento: typeof data.numero_documento === 'string' ? data.numero_documento.slice(0, 50): '',
    data_documento:   typeof data.data_documento   === 'string' ? data.data_documento               : '',
    tipo:             TIPI.includes(data.tipo) ? data.tipo : 'fattura',
    categoria:        CATEGORIE.includes(data.categoria) ? data.categoria : 'Altro',
  };
}

module.exports = { extractSiteCostFromDocument, TIPI, CATEGORIE };
