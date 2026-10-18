'use strict';
/**
 * lib/mezziLibretto.js — F-375 (AUDIT.md del frontend): «+ Aggiungi» un mezzo = una foto al libretto.
 *
 * Il modello legge dal libretto (carta di circolazione) targa, marca e modello,
 * genere del veicolo, data di prima immatricolazione (campo B), massa
 * complessiva (F.2) e, se c'è il tagliando adesivo, l'ultima revisione. La
 * prossima revisione NON la chiede al modello: la calcola lib/mezziRevisione.js.
 * Niente si salva qui: il titolare vede «Ho letto il libretto. È giusto?» e
 * conferma (POST /mezzi). Se la targa è già di un mezzo dell'azienda, lo dice
 * (`esistente`) invece di crearne un doppione (com'era successo con lo scooter
 * FX53745, due righe identiche).
 */
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('./supabase');
const { flattenToText } = require('./ocrSanitize');
const { logUsage } = require('./ladiaUsageLog');
const { prossimaRevisione } = require('./mezziRevisione');

const MODELLO = 'claude-haiku-4-5-20251001';

const PROMPT = `Leggi questo documento di un veicolo italiano (di solito il libretto / carta di circolazione).
Restituisci SOLO un oggetto JSON, senza testo prima o dopo:

{
  "targa": "targa (campo A) senza spazi, o null",
  "marca": "marca (campo D.1), o null",
  "modello": "denominazione commerciale (campo D.3), o null",
  "genere": "autovettura | autocarro | motociclo | ciclomotore | rimorchio | macchina operatrice | altro",
  "prima_immatricolazione": "data del campo B in formato YYYY-MM-DD, o null",
  "massa_kg": "massa complessiva a pieno carico (campo F.2) in kg come numero, o null",
  "ultima_revisione": "data dell'ultima revisione dal tagliando adesivo, YYYY-MM-DD, o null",
  "scadenza_assicurazione": "solo se il documento è una polizza: YYYY-MM-DD, altrimenti null"
}

Non inventare: se un campo non si legge, null.`;

let _ai = null;
const ai = () => (_ai ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

async function chiediAlModello({ buffer, mimetype, companyId, userId }) {
  const isPdf = mimetype === 'application/pdf';
  const msg = await ai().messages.create({
    model: MODELLO, max_tokens: 400,
    messages: [{ role: 'user', content: [
      { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }],
  });
  logUsage({ companyId, userId, model: MODELLO, callSite: 'mezzi_libretto', usage: msg.usage });
  const m = (msg.content[0]?.text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Risposta non JSON');
  return JSON.parse(m[0]);
}

const dataValida = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
const titolo = (s) => String(s || '').toLowerCase().replace(/(^|[\s\-/.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).trim();
const pulisciTarga = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;

// genere del libretto → tipo di Palladia (stessi nomi del vecchio modulo)
const TIPO = {
  autovettura: 'Autovettura', autocarro: 'Autocarro', motociclo: 'Motociclo/Scooter', ciclomotore: 'Motociclo/Scooter',
  rimorchio: 'Rimorchio', 'macchina operatrice': 'Macchina operatrice',
};

/** Puro: dalla risposta del modello alla proposta da confermare. */
function proposta(r, oggiIso = null) {
  const genere = flattenToText(r?.genere).toLowerCase();
  const massa = Number(String(flattenToText(r?.massa_kg)).replace(/[^\d]/g, '')) || null;
  const letto = {
    targa: pulisciTarga(flattenToText(r?.targa)),
    marca: titolo(flattenToText(r?.marca)) || null,
    modello: titolo(flattenToText(r?.modello)) || null,
    tipo: TIPO[genere] || (genere ? 'Altro' : null),
    immatricolazione: dataValida(flattenToText(r?.prima_immatricolazione)),
    massaKg: massa && massa < 100000 ? massa : null,
    ultimaRevisione: dataValida(flattenToText(r?.ultima_revisione)),
    assicurazione: dataValida(flattenToText(r?.scadenza_assicurazione)),
  };
  const nome = [letto.marca, letto.modello].filter(Boolean).join(' ') || null;
  const revisione = prossimaRevisione({ immatricolazione: letto.immatricolazione, ultima: letto.ultimaRevisione, massaKg: letto.massaKg }, oggiIso);
  return { letto, nome, revisione };
}

async function leggiLibretto({ companyId, userId, file, chiedi = chiediAlModello }) {
  const r = await chiedi({ buffer: file.buffer, mimetype: file.mimetype, companyId, userId });
  const out = proposta(r);
  let esistente = null;
  if (out.letto.targa) {
    const { data } = await supabase.from('equipment').select('id, name, type, model, plate_or_serial')
      .eq('company_id', companyId).eq('is_active', true);
    const e = (data || []).find(x => pulisciTarga(x.plate_or_serial) === out.letto.targa);
    if (e) esistente = { id: e.id, nome: e.name || [e.type, e.model].filter(Boolean).join(' ') };
  }
  return { ...out, esistente };
}

module.exports = { leggiLibretto, proposta, pulisciTarga, PROMPT };
