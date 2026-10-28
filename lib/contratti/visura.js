'use strict';
/**
 * lib/contratti/visura.js — F-398: dalla visura camerale i dati che servono al
 * contratto («per i dati basta caricare la visura dell'impresa in subappalto
 * così prende tutto il necessario», il titolare, 28/10).
 *
 * Il modello LEGGE e basta; il codice pulisce e controlla (partita IVA con la
 * cifra di controllo, date vere). Quello che non si legge resta null: il
 * titolare lo vede vuoto e lo scrive, mai un dato inventato. Stesso schema di
 * lib/impreseControllo.js.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { flattenToText } = require('../ocrSanitize');
const { logUsage } = require('../ladiaUsageLog');
const { pivaValida, pivaPulita } = require('./clausole');

const MODELLO = 'claude-haiku-4-5-20251001';

const PROMPT = `Leggi questa visura camerale (Camera di Commercio, Registro Imprese) di un'impresa italiana. Restituisci SOLO un oggetto JSON:

{
  "e_una_visura": true se è una visura camerale o un certificato del Registro Imprese, altrimenti false,
  "ragione_sociale": "denominazione completa con la forma giuridica (es. «Impianti Rossi S.r.l.»), o null",
  "partita_iva": "11 cifre, o null",
  "codice_fiscale": "codice fiscale dell'impresa, o null",
  "sede": "indirizzo completo della sede legale: via e numero, CAP, comune e provincia, o null",
  "rea": "numero REA con la sigla della provincia (es. «GE-123456»), o null",
  "pec": "indirizzo PEC, o null",
  "legale_rappresentante": "nome e cognome di chi ha la legale rappresentanza (amministratore unico, presidente del CdA, titolare), o null",
  "carica": "la sua carica (es. «amministratore unico»), o null",
  "data_estrazione": "data in cui la visura è stata estratta o rilasciata, YYYY-MM-DD, o null"
}

Non inventare: se un campo non si legge con certezza, null. Nomi di persona con iniziali maiuscole, non tutto maiuscolo.`;

let _ai = null;
const ai = () => (_ai ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

async function chiediAlModello({ buffer, mimetype, companyId }) {
  const isPdf = mimetype === 'application/pdf';
  const msg = await ai().messages.create({
    model: MODELLO, max_tokens: 600,
    messages: [{ role: 'user', content: [
      { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }],
  });
  logUsage({ companyId, userId: null, model: MODELLO, callSite: 'contratto_visura', usage: msg.usage });
  const m = (msg.content[0]?.text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Risposta non JSON');
  return JSON.parse(m[0]);
}

const testo = (v) => { const t = flattenToText(v); return t && t.toLowerCase() !== 'null' ? t.replace(/\s+/g, ' ').trim() : null; };
const dataValida = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);
// «MARIO ROSSI» → «Mario Rossi» (solo se è tutto maiuscolo)
const nomeProprio = (s) => (s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, c => c.toUpperCase()) : s);

/** Puro: la risposta del modello ripulita. */
function pulisci(r) {
  const piva = pivaPulita(testo(r?.partita_iva));
  const cf = testo(r?.codice_fiscale)?.replace(/\s/g, '').toUpperCase() || null;
  const pec = testo(r?.pec)?.toLowerCase() || null;
  return {
    eUnaVisura: r?.e_una_visura === true || r?.e_una_visura === 'true',
    ragioneSociale: testo(r?.ragione_sociale),
    piva: pivaValida(piva) ? piva : null,
    pivaLettaMaSbagliata: !!piva && !pivaValida(piva),
    codiceFiscale: cf && /^([0-9]{11}|[A-Z0-9]{16})$/.test(cf) ? cf : null,
    sede: testo(r?.sede),
    rea: testo(r?.rea)?.toUpperCase() || null,
    pec: pec && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pec) ? pec : null,
    legaleRappresentante: nomeProprio(testo(r?.legale_rappresentante)),
    carica: testo(r?.carica)?.toLowerCase() || null,
    dataEstrazione: dataValida(testo(r?.data_estrazione)),
  };
}

async function leggiVisura({ file, companyId, chiedi = chiediAlModello }) {
  return pulisci(await chiedi({ buffer: file.buffer, mimetype: file.mimetype, companyId }));
}

module.exports = { leggiVisura, pulisci, PROMPT };
