'use strict';
// ── Lettura della tessera sanitaria da una foto (F-337) ──────────────────────
// L'operaio di un subappaltatore fotografa la tessera all'ingresso: non scrive
// niente. Restituisce cognome, nome e codice fiscale, controllati qui (carattere
// di controllo, corrispondenza col nome). La foto non viene salvata da nessuna
// parte: resta in memoria il tempo della chiamata.
const Anthropic = require('@anthropic-ai/sdk');
const { withAiLimit } = require('./concurrencyLimit');
const { logUsage } = require('./ladiaUsageLog');
const { codiceFiscaleValido, corrispondeAlNome, normalizza } = require('./codiceFiscale');

const MODEL = 'claude-opus-5-5';
const TIPI_IMMAGINE = ['image/jpeg', 'image/png', 'image/webp'];

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const PROMPT = `Questa è la foto di una tessera sanitaria italiana (o di un tesserino con codice fiscale).
Leggi COGNOME, NOME e CODICE FISCALE esattamente come stampati.
Se non è un documento con codice fiscale, o non si legge, metti leggibile=false e stringhe vuote.`;

const SCHEMA = {
  type: 'object',
  properties: {
    leggibile: { type: 'boolean' },
    cognome: { type: 'string' },
    nome: { type: 'string' },
    codice_fiscale: { type: 'string' },
  },
  required: ['leggibile', 'cognome', 'nome', 'codice_fiscale'],
  additionalProperties: false,
};

const titolo = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
  .replace(/(^|[\s'-])(\p{L})/gu, (m, p, l) => p + l.toUpperCase()).slice(0, 80);

/** Verifica pura del risultato dell'IA: null se non utilizzabile. */
function controllaLettura(raw) {
  if (!raw || typeof raw !== 'object' || raw.leggibile !== true) return null;
  const cf = normalizza(typeof raw.codice_fiscale === 'string' ? raw.codice_fiscale : '');
  const cognome = typeof raw.cognome === 'string' ? raw.cognome : '';
  const nome = typeof raw.nome === 'string' ? raw.nome : '';
  if (!codiceFiscaleValido(cf) || cognome.trim().length < 2 || nome.trim().length < 2) return null;
  return {
    fullName: `${titolo(nome)} ${titolo(cognome)}`,
    fiscalCode: cf,
    nomeCorrisponde: corrispondeAlNome(cf, cognome, nome),
  };
}

/**
 * @returns {Promise<{fullName:string, fiscalCode:string, nomeCorrisponde:boolean}|null>}
 *          null = non si legge (l'operaio riprova o lo segna il caposquadra)
 */
async function leggiTessera(buffer, mimeType, { companyId }) {
  if (!TIPI_IMMAGINE.includes(mimeType)) return null;
  const msg = await withAiLimit(() => client().beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  }));
  logUsage({ companyId, model: msg.model || MODEL, callSite: 'sub_tessera', usage: msg.usage });
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return null;
  const text = (msg.content || []).find(b => b.type === 'text')?.text;
  if (!text) return null;
  try { return controllaLettura(JSON.parse(text)); } catch { return null; }
}

module.exports = { leggiTessera, controllaLettura, TIPI_IMMAGINE };
