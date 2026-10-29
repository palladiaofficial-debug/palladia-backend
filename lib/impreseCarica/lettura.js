'use strict';
/**
 * lib/impreseCarica/lettura.js — F-401: che cos'è un documento di un'impresa
 * in subappalto, letto da un modello e ripulito dal codice.
 *
 * Il modello LEGGE (tipo, impresa, partita IVA, persona e codice fiscale,
 * date, firma, cantiere, corso); il codice pulisce e calcola le scadenze che i
 * fogli spesso non scrivono: DURC = emissione + 120 giorni, e gli attestati
 * con la sola data del corso con la periodicità di legge (formazione 5 anni,
 * preposto 2, primo soccorso 3, antincendio 5, attrezzature 5, ponteggi 4…).
 * Quello che non si legge resta null: mai un dato inventato.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { flattenToText } = require('../ocrSanitize');
const { logUsage } = require('../ladiaUsageLog');

const MODELLO = 'claude-haiku-4-5-20251001';
const TIPI = ['durc', 'visura', 'dvr', 'dichiarazione', 'assicurazione', 'pos', 'idoneita', 'formazione', 'attestato', 'altro'];
const CORSI = ['preposto', 'primo_soccorso', 'antincendio', 'attrezzature', 'ponteggi', 'quota', 'spazi_confinati', 'dirigente', 'rls', 'altro'];
// Aggiornamento in anni quando l'attestato porta solo la data del corso
const PERIODICITA = { formazione: 5, preposto: 2, primo_soccorso: 3, antincendio: 5, attrezzature: 5, ponteggi: 4, quota: 5, spazi_confinati: 5, dirigente: 5 };
const NOME_CORSO = {
  preposto: 'Corso preposto', primo_soccorso: 'Corso primo soccorso', antincendio: 'Corso antincendio', attrezzature: 'Abilitazione attrezzature',
  ponteggi: 'Corso ponteggi (PiMUS)', quota: 'Corso lavori in quota', spazi_confinati: 'Corso spazi confinati', dirigente: 'Corso dirigente', rls: 'Corso RLS',
};

const PROMPT = `Leggi questo documento, mandato da un'impresa edile italiana in subappalto. Restituisci SOLO un oggetto JSON:

{
  "tipo": "durc | visura | dvr | dichiarazione | assicurazione | pos | idoneita | formazione | attestato | altro",
  "titolo": "nome breve in italiano, come lo direbbe un geometra (es. 'DURC', 'Attestato corso preposto', 'Polizza RCT/RCO')",
  "corso": "solo per tipo attestato: preposto | primo_soccorso | antincendio | attrezzature | ponteggi | quota | spazi_confinati | dirigente | rls | altro; altrimenti null",
  "ragione_sociale": "l'impresa a cui si riferisce il documento (per un attestato o una visita: il datore di lavoro, se scritto), o null",
  "partita_iva": "11 cifre, o null",
  "sede": "indirizzo della sede legale dell'impresa, o null",
  "persona": "nome e cognome del lavoratore (visite mediche e attestati), o null",
  "codice_fiscale_persona": "codice fiscale del lavoratore, 16 caratteri, o null",
  "data_documento": "data di emissione / rilascio / svolgimento del corso / estrazione, YYYY-MM-DD, o null",
  "scadenza": "data di scadenza o di validità scritta sul foglio, YYYY-MM-DD, o null",
  "firmato": true se c'è una firma o una firma digitale, false se lo spazio per la firma è vuoto, null se non si capisce,
  "cantiere": "indirizzo del cantiere (solo per un POS), o null"
}

Regole:
- durc: Documento Unico di Regolarità Contributiva. visura: visura camerale / certificato della Camera di Commercio.
- dvr: documento di valutazione dei rischi o sua autocertificazione. pos: piano operativo di sicurezza.
- dichiarazione: dichiarazione di non essere oggetto di provvedimenti di sospensione (art. 14 D.Lgs. 81/2008).
- assicurazione: polizza o quietanza di responsabilità civile (RCT/RCO) dell'impresa.
- idoneita: giudizio di idoneità alla mansione / visita medica del lavoratore.
- formazione: attestato della formazione generale e specifica dei lavoratori (art. 37 D.Lgs. 81/2008).
- attestato: ogni altro corso o abilitazione di un lavoratore (preposto, primo soccorso, antincendio, PLE, gru, carrelli, escavatori = attrezzature, ponteggi, lavori in quota, spazi confinati, dirigente, RLS).
- altro: tutto il resto (fatture, contratti, foto, elenchi…).
- Non inventare: se un campo non si legge con certezza, null.`;

let _ai = null;
const ai = () => (_ai ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

/** Chiede al modello. contenuto = blocchi già pronti (documento, immagine o testo). Iniettabile nei test. */
async function chiediAlModello({ contenuto, companyId, userId }) {
  const msg = await ai().messages.create({
    model: MODELLO, max_tokens: 700, temperature: 0,
    messages: [{ role: 'user', content: [...contenuto, { type: 'text', text: PROMPT }] }],
  });
  logUsage({ companyId, userId: userId || null, model: MODELLO, callSite: 'imprese_carica', usage: msg.usage });
  const m = (msg.content[0]?.text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Risposta non JSON');
  return JSON.parse(m[0]);
}

const testo = (v) => { const t = flattenToText(v); return t && t.toLowerCase() !== 'null' ? t.replace(/\s+/g, ' ').trim() : null; };
const dataValida = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);
const cifre = (s) => String(s || '').replace(/\D/g, '');
function piuGiorni(d, n) { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function piuAnni(d, n) { const x = new Date(`${d}T12:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); }
// «ROSSI MARIO» → «Rossi Mario» (solo se è tutto maiuscolo)
const nomeProprio = (s) => (s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, c => c.toUpperCase()) : s);

/** Puro: la risposta del modello ripulita, con le scadenze calcolate. */
function pulisci(r) {
  const tipo = TIPI.includes(testo(r?.tipo)) ? testo(r.tipo) : 'altro';
  const corso = tipo === 'attestato' ? (CORSI.includes(testo(r?.corso)) ? testo(r.corso) : 'altro') : null;
  const piva = cifre(testo(r?.partita_iva));
  const cf = testo(r?.codice_fiscale_persona)?.replace(/\s/g, '').toUpperCase() || null;
  const f = r?.firmato;
  const out = {
    tipo, corso,
    titolo: testo(r?.titolo) || (corso && NOME_CORSO[corso]) || null,
    ragioneSociale: testo(r?.ragione_sociale),
    piva: piva.length === 11 ? piva : null,
    sede: testo(r?.sede),
    persona: nomeProprio(testo(r?.persona)),
    cfPersona: cf && /^[A-Z0-9]{16}$/.test(cf) ? cf : null,
    dataDocumento: dataValida(testo(r?.data_documento)),
    scadenza: dataValida(testo(r?.scadenza)),
    scadenzaCalcolata: false,
    firmato: f === true || f === 'true' ? true : f === false || f === 'false' ? false : null,
    cantiere: testo(r?.cantiere),
  };
  if (!out.scadenza && out.dataDocumento) {
    const anni = tipo === 'formazione' ? PERIODICITA.formazione : tipo === 'attestato' ? PERIODICITA[corso] : null;
    if (tipo === 'durc') { out.scadenza = piuGiorni(out.dataDocumento, 120); out.scadenzaCalcolata = true; }
    else if (anni) { out.scadenza = piuAnni(out.dataDocumento, anni); out.scadenzaCalcolata = true; }
  }
  return out;
}

/**
 * I blocchi da mandare al modello. Un documento corto va intero (il modello
 * vede firme e timbri); uno lungo (un POS di 80 pagine) va come testo delle
 * prime e delle ultime pagine, dove stanno impresa, cantiere e firme.
 */
function contenutoPer({ buffer, mimetype, pagine, testoPagine }) {
  if (mimetype !== 'application/pdf') return [{ type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } }];
  if (pagine <= 12 || !testoPagine?.length) return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }];
  const scelte = [...testoPagine.slice(0, 6), ...testoPagine.slice(-2)];
  return [{ type: 'text', text: `Documento di ${pagine} pagine. Testo delle prime e delle ultime pagine:\n\n${scelte.join('\n').slice(0, 20000)}` }];
}

async function leggiDocumento({ buffer, mimetype, pagine, testoPagine, companyId, userId, chiedi = chiediAlModello }) {
  return pulisci(await chiedi({ contenuto: contenutoPer({ buffer, mimetype, pagine, testoPagine }), companyId, userId }));
}

module.exports = { leggiDocumento, pulisci, contenutoPer, PERIODICITA, NOME_CORSO, TIPI, PROMPT };
