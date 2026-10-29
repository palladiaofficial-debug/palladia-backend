'use strict';
/**
 * lib/documentiLeggi.js — F-374 (AUDIT.md del frontend): «+ Carica» in Documenti.
 *
 * Il titolare fa una foto a un foglio qualsiasi (visita medica, attestato,
 * DURC, assicurazione del mezzo…) senza dire di chi è. Qui:
 *  1. il modello legge cos'è, l'intestatario (persona o ditta), codice
 *     fiscale e targa se ci sono, la scadenza (DURC: emissione + 120 giorni);
 *  2. abbina() trova a chi appartiene tra i proprietari veri dell'azienda
 *     (codice fiscale o targa esatti prima, poi il nome, che regge «ROSSI
 *     Mario» contro «Mario Rossi») e a quale requisito corrisponde;
 *  3. il titolare vede la proposta e conferma («È giusto, salva») o cambia:
 *     NIENTE si salva qui. Il salvataggio è POST /documenti/carica, come dalla
 *     scheda.
 * Se il nome letto non somiglia abbastanza a nessuno, «di chi è» resta vuoto
 * e lo sceglie il titolare: meglio una domanda che un documento sulla persona
 * sbagliata.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { matchWorker, matchEquipment } = require('./entityMatch');
const { scoreMatch, normName, levenshtein } = require('./fuzzyMatch');
const { flattenToText } = require('./ocrSanitize');
const { logUsage } = require('./ladiaUsageLog');
const { proprietari, REQUIREMENTS, requirementsFor } = require('./documentiStato');

const MODELLO = 'claude-haiku-4-5-20251001';
const SOGLIA_DITTA = 60;

// tipo letto → requisito, per tipo di proprietario
const REQUISITO = {
  idoneita: { lavoratori: 'idoneita' },
  formazione: { lavoratori: 'formazione' },
  assicurazione: { mezzi: 'assicurazione' },
  revisione: { mezzi: 'revisione' },
  durc: { impresa: 'durc', subappaltatori: 'durc' },
};

const PROMPT = `Sei un sistema che legge documenti di un'impresa edile italiana (foto o PDF).
Restituisci SOLO un oggetto JSON, senza testo prima o dopo:

{
  "tipo": "idoneita | formazione | assicurazione | revisione | durc | altro",
  "titolo": "nome breve del documento in italiano, come lo direbbe un geometra (es. 'Visita medica', 'Attestato corso preposto', 'DURC', 'Polizza RC auto')",
  "intestatario": "nome e cognome della persona o ragione sociale della ditta a cui si riferisce, null se non leggibile",
  "tipo_intestatario": "persona | ditta | veicolo | null",
  "codice_fiscale": "codice fiscale della persona se presente, altrimenti null",
  "targa": "targa o matricola del veicolo/mezzo se presente, altrimenti null",
  "scadenza": "YYYY-MM-DD o null",
  "emissione": "YYYY-MM-DD o null"
}

Regole:
- tipo "idoneita": giudizio di idoneità alla mansione / visita medica del lavoratore.
- tipo "formazione": attestato del corso di formazione sicurezza dei lavoratori (generale e specifica, art. 37 D.Lgs. 81/2008). Altri corsi (preposto, primo soccorso, antincendio, ponteggi, PLE, gru, RSPP…) sono tipo "altro", con il loro titolo.
- tipo "assicurazione": polizza o certificato assicurativo di un veicolo o mezzo. "revisione": revisione del veicolo.
- tipo "durc": Documento Unico di Regolarità Contributiva.
- Per i veicoli l'intestatario è il veicolo: metti marca e modello in "intestatario", tipo_intestatario "veicolo" e la targa in "targa".
- "scadenza": cerca "scade il", "valido fino al", "data di scadenza", "validità", "prossima visita entro". Non inventare date: se non c'è, null.`;

let _ai = null;
const ai = () => (_ai ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

/** Chiede al modello cosa c'è nel foglio. Iniettabile nei test. */
async function chiediAlModello({ buffer, mimetype, companyId, userId }) {
  const isPdf = mimetype === 'application/pdf';
  const msg = await ai().messages.create({
    model: MODELLO, max_tokens: 400,
    messages: [{ role: 'user', content: [
      { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }],
  });
  logUsage({ companyId, userId, model: MODELLO, callSite: 'documenti_leggi', usage: msg.usage });
  const raw = msg.content[0]?.text || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Risposta non JSON');
  return JSON.parse(m[0]);
}

const dataValida = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
function piuGiorni(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** Pulisce quello che arriva dal modello (nessuno schema imposto: F-066). */
function pulisci(r) {
  const tipi = ['idoneita', 'formazione', 'assicurazione', 'revisione', 'durc', 'altro'];
  const t = flattenToText(r?.tipo);
  const letto = {
    tipo: tipi.includes(t) ? t : 'altro',
    titolo: flattenToText(r?.titolo) || null,
    intestatario: flattenToText(r?.intestatario) || null,
    tipoIntestatario: ['persona', 'ditta', 'veicolo'].includes(flattenToText(r?.tipo_intestatario)) ? flattenToText(r.tipo_intestatario) : null,
    codiceFiscale: flattenToText(r?.codice_fiscale) || null,
    targa: flattenToText(r?.targa) || null,
    scadenza: dataValida(flattenToText(r?.scadenza)),
    emissione: dataValida(flattenToText(r?.emissione)),
  };
  if (!letto.scadenza && letto.emissione && letto.tipo === 'durc') letto.scadenza = piuGiorni(letto.emissione, 120);
  // F-400: l'attestato della formazione dei lavoratori porta la data del corso;
  // l'aggiornamento è quinquennale (Accordo Stato-Regioni). La visita medica no:
  // la periodicità la decide il medico competente, se non è scritta resta vuota.
  if (!letto.scadenza && letto.emissione && letto.tipo === 'formazione') {
    const d = new Date(`${letto.emissione}T12:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 5);
    letto.scadenza = d.toISOString().slice(0, 10);
    letto.scadenzaCalcolata = true;
  }
  return letto;
}

// Le ditte si scrivono in tanti modi: «MSC EDILIZIA SRL» = «MSCedilizia S.r.l.».
// Si confrontano anche senza forma societaria e senza spazi.
const FORME = /\b(s ?r ?l ?s?|s ?p ?a|s ?n ?c|s ?a ?s|s ?c ?a ?r ?l|soc|societa|cooperativa|coop|ditta|impresa|di)\b/g;
const compatto = (s) => normName(s).replace(FORME, ' ').replace(/\s+/g, '');
function scoreDitta(a, b) {
  const ca = compatto(a), cb = compatto(b);
  if (!ca || !cb) return scoreMatch(a, b);
  const lev = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
  return Math.max(scoreMatch(a, b), Math.round(lev * 100));
}

/**
 * Puro: dal foglio letto al proprietario e al requisito.
 * owners: [{ kind, id, name, detail, row }] (documentiStato.proprietari)
 */
function abbina(letto, owners) {
  const di = (k) => owners.filter(o => o.kind === k);
  const candidati = [];
  const persona = letto.tipoIntestatario === 'persona' || letto.tipo === 'idoneita' || letto.tipo === 'formazione';
  const veicolo = letto.tipoIntestatario === 'veicolo' || letto.tipo === 'assicurazione' || letto.tipo === 'revisione' || !!letto.targa;
  const ditta = letto.tipoIntestatario === 'ditta' || letto.tipo === 'durc';

  if (letto.intestatario || letto.codiceFiscale) {
    const w = matchWorker({ name: letto.intestatario, fiscal_code: letto.codiceFiscale },
      di('lavoratori').map(o => ({ id: o.id, full_name: o.name, fiscal_code: o.row?.fiscal_code })));
    if (w) candidati.push({ kind: 'lavoratori', id: w.id, score: w.score + (persona ? 10 : 0), esatto: w.matchedBy === 'cf' });
  }
  if (letto.targa || (veicolo && letto.intestatario)) {
    const e = matchEquipment({ name: letto.intestatario, plate: letto.targa },
      di('mezzi').map(o => ({ id: o.id, name: o.name, type: o.row?.type, model: o.row?.model, plate_or_serial: o.row?.plate_or_serial })));
    if (e) candidati.push({ kind: 'mezzi', id: e.id, score: e.score + (veicolo ? 10 : 0), esatto: e.matchedBy === 'plate' });
  }
  if (letto.intestatario && !persona) {
    for (const k of ['impresa', 'subappaltatori']) {
      for (const o of di(k)) {
        const sc = scoreDitta(letto.intestatario, o.name);
        if (sc >= SOGLIA_DITTA) candidati.push({ kind: k, id: o.id, score: sc + (ditta ? 10 : 0), esatto: false });
      }
    }
  }
  candidati.sort((a, b) => (b.esatto - a.esatto) || b.score - a.score);
  const scelto = candidati[0] || null;
  const owner = scelto ? owners.find(o => o.kind === scelto.kind && o.id === scelto.id) : null;

  let requisito = null;
  if (owner) {
    const key = REQUISITO[letto.tipo]?.[owner.kind] || null;
    if (key && requirementsFor(owner.kind, owner.row).concat(REQUIREMENTS[owner.kind] || []).some(r => r.key === key)) requisito = key;
  }
  const label = requisito ? (REQUIREMENTS[owner.kind].find(r => r.key === requisito).label) : (letto.titolo || 'Documento');
  return {
    proposta: {
      kind: owner?.kind || null, id: owner?.id || null, name: owner?.name || null, detail: owner?.detail || null,
      requisito, label, scadenza: letto.scadenza,
    },
    certezza: scelto && (scelto.esatto || scelto.score >= 80) ? 'alta' : scelto ? 'media' : 'nessuna',
  };
}

async function leggi({ companyId, userId, file, chiedi = chiediAlModello }) {
  const [grezzo, owners] = await Promise.all([
    chiedi({ buffer: file.buffer, mimetype: file.mimetype, companyId, userId }),
    proprietari(companyId),
  ]);
  const letto = pulisci(grezzo);
  return { letto, ...abbina(letto, owners) };
}

module.exports = { leggi, abbina, pulisci, scoreDitta, PROMPT };
