'use strict';
/**
 * lib/impreseControllo.js — F-376 (AUDIT.md del frontend): Palladia controlla quello che manda l'impresa.
 *
 * Il titolare non deve aprire ogni foglio: il modello LEGGE (intestatario,
 * partita IVA, date, firma, indirizzo del cantiere, nome dell'operaio) e il
 * CODICE decide se va bene, con regole scritte qui e coi loro test:
 *  - documento sbagliato (ha mandato un DURC al posto della visura);
 *  - di un'altra impresa (partita IVA diversa, o nome che non somiglia);
 *  - scaduto; visura più vecchia di 6 mesi; DURC senza scadenza = emissione + 120 gg;
 *  - dichiarazione senza firma;
 *  - POS che parla di un altro cantiere;
 *  - visita / corso intestati a un'altra persona.
 * Il motivo è un codice con i suoi valori: la pagina dell'impresa lo traduce
 * nella sua lingua, quella del titolare lo dice in italiano (`motivoItaliano`).
 * Se il modello non riesce a leggere, il documento resta «da guardare» (esito
 * null): mai un «non va» inventato.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { flattenToText } = require('./ocrSanitize');
const { logUsage } = require('./ladiaUsageLog');
const { scoreDitta } = require('./documentiLeggi');
const { scoreMatch, normName } = require('./fuzzyMatch');

const MODELLO = 'claude-haiku-4-5-20251001';

const TIPI = ['durc', 'visura', 'dvr', 'dichiarazione', 'assicurazione', 'pos', 'idoneita', 'formazione', 'altro'];
const NOMI = {
  durc: 'DURC', visura: 'visura camerale', dvr: 'DVR', dichiarazione: 'dichiarazione', assicurazione: 'polizza assicurativa',
  pos: 'POS', idoneita: 'visita medica', formazione: 'attestato del corso di sicurezza', altro: 'altro documento',
};

const PROMPT = `Leggi questo documento di un'impresa edile italiana. Restituisci SOLO un oggetto JSON:

{
  "tipo": "durc | visura | dvr | dichiarazione | assicurazione | pos | idoneita | formazione | altro",
  "ragione_sociale": "impresa a cui si riferisce, o null",
  "partita_iva": "11 cifre, o null",
  "sede": "indirizzo della sede legale dell'impresa, o null",
  "persona": "nome e cognome del lavoratore se è una visita medica o un attestato, o null",
  "data_documento": "data di emissione / rilascio / estrazione, YYYY-MM-DD, o null",
  "scadenza": "data di scadenza o validità, YYYY-MM-DD, o null",
  "firmato": "true se c'è una firma (o firma digitale), false se lo spazio per la firma è vuoto, null se non si capisce",
  "cantiere": "indirizzo del cantiere a cui si riferisce (solo per un POS), o null"
}

Regole:
- "visura": visura camerale / certificato della Camera di Commercio. "dvr": documento di valutazione dei rischi o sua autocertificazione.
- "dichiarazione": dichiarazione di non essere oggetto di provvedimenti di sospensione (art. 14 D.Lgs. 81/2008).
- "pos": piano operativo di sicurezza. "idoneita": giudizio di idoneità / visita medica. "formazione": attestato del corso di sicurezza dei lavoratori.
- Non inventare: se un campo non si legge, null.`;

let _ai = null;
const ai = () => (_ai ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

async function chiediAlModello({ buffer, mimetype, companyId }) {
  const isPdf = mimetype === 'application/pdf';
  const msg = await ai().messages.create({
    model: MODELLO, max_tokens: 400,
    messages: [{ role: 'user', content: [
      { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }],
  });
  logUsage({ companyId, userId: null, model: MODELLO, callSite: 'imprese_controllo', usage: msg.usage });
  const m = (msg.content[0]?.text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Risposta non JSON');
  return JSON.parse(m[0]);
}

const dataValida = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
const cifre = (s) => String(s || '').replace(/\D/g, '');
function piuGiorni(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function piuMesi(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

function pulisci(r) {
  const t = flattenToText(r?.tipo).toLowerCase();
  const f = r?.firmato;
  return {
    tipo: TIPI.includes(t) ? t : 'altro',
    ragioneSociale: flattenToText(r?.ragione_sociale) || null,
    piva: cifre(flattenToText(r?.partita_iva)).length === 11 ? cifre(flattenToText(r?.partita_iva)) : null,
    sede: flattenToText(r?.sede) || null,
    persona: flattenToText(r?.persona) || null,
    dataDocumento: dataValida(flattenToText(r?.data_documento)),
    scadenza: dataValida(flattenToText(r?.scadenza)),
    firmato: f === true || f === 'true' ? true : f === false || f === 'false' ? false : null,
    cantiere: flattenToText(r?.cantiere) || null,
  };
}

// Parole che contano in un indirizzo: «Via Riboli 4b, Genova» → riboli, 4b, genova
const VUOTE = new Set(['via', 'viale', 'piazza', 'corso', 'largo', 'vicolo', 'strada', 'localita', 'loc', 'snc', 'civico', 'n', 'nr', 'del', 'della', 'dei', 'di', 'da', 'cap']);
const paroleIndirizzo = (s) => normName(s).split(' ').filter(w => w.length >= 2 && !VUOTE.has(w));

/** Puro: dal foglio letto al giudizio. `atteso` = tipo chiesto; ctx = { impresa:{nome,piva}, cantiere:{nome,indirizzo}, operaio:{nome}, oggi } */
function giudica(atteso, letto, ctx = {}) {
  const oggi = ctx.oggi || oggiRoma();
  let scadenza = letto.scadenza;
  if (atteso === 'durc' && !scadenza && letto.dataDocumento) scadenza = piuGiorni(letto.dataDocumento, 120);
  if (atteso === 'visura' && letto.dataDocumento) scadenza = piuMesi(letto.dataDocumento, 6);
  const no = (codice, valore = null) => ({ esito: 'non_va', motivo: { codice, valore }, scadenza, letto });

  if (letto.tipo !== 'altro' && letto.tipo !== atteso) return no('altro_documento', letto.tipo);
  if (ctx.impresa && !['idoneita', 'formazione'].includes(atteso)) {
    const pivaImpresa = cifre(ctx.impresa.piva);
    if (letto.piva && pivaImpresa.length === 11 && letto.piva !== pivaImpresa) return no('altra_impresa', letto.ragioneSociale || letto.piva);
    const stessaPiva = letto.piva && letto.piva === pivaImpresa;
    if (!stessaPiva && letto.ragioneSociale && ctx.impresa.nome && scoreDitta(letto.ragioneSociale, ctx.impresa.nome) < 60) {
      return no('altra_impresa', letto.ragioneSociale);
    }
  }
  if (ctx.operaio?.nome && letto.persona && scoreMatch(letto.persona, ctx.operaio.nome) < 60) return no('altra_persona', letto.persona);
  if (scadenza && scadenza < oggi) return no(atteso === 'visura' ? 'visura_vecchia' : 'scaduto', atteso === 'visura' ? letto.dataDocumento : scadenza);
  if (atteso === 'dichiarazione' && letto.firmato === false) return no('senza_firma');
  if (atteso === 'pos' && ctx.cantiere && letto.cantiere) {
    const attese = new Set([...paroleIndirizzo(ctx.cantiere.nome), ...paroleIndirizzo(ctx.cantiere.indirizzo)]);
    const lette = paroleIndirizzo(letto.cantiere);
    if (attese.size && lette.length && !lette.some(w => attese.has(w))) return no('altro_cantiere', letto.cantiere);
  }
  return { esito: 'va_bene', motivo: null, scadenza, letto };
}

const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Il motivo in italiano, per il titolare. */
function motivoItaliano(m) {
  if (!m) return null;
  switch (m.codice) {
    case 'altro_documento': return `Sembra un altro documento (${NOMI[m.valore] || m.valore})`;
    case 'altra_impresa': return `È intestato a un'altra impresa${m.valore ? ` («${m.valore}»)` : ''}`;
    case 'altra_persona': return `È intestato a un'altra persona${m.valore ? ` («${m.valore}»)` : ''}`;
    case 'scaduto': return `È scaduto${m.valore ? ` il ${fmt(m.valore)}` : ''}`;
    case 'visura_vecchia': return `È di più di 6 mesi fa${m.valore ? ` (${fmt(m.valore)})` : ''}: serve una visura più recente`;
    case 'senza_firma': return 'Manca la firma';
    case 'altro_cantiere': return `Parla di un altro cantiere${m.valore ? ` («${m.valore}»)` : ''}`;
    case 'non_letto': return 'Non sono riuscito a leggerlo: guardalo tu';
    default: return 'Non va';
  }
}

/** Legge e giudica. Se la lettura non riesce: esito null («da guardare»), mai un «non va» inventato. */
async function controlla({ atteso, file, ctx, companyId, chiedi = chiediAlModello }) {
  try {
    const letto = pulisci(await chiedi({ buffer: file.buffer, mimetype: file.mimetype, companyId }));
    return giudica(atteso, letto, ctx);
  } catch {
    return { esito: null, motivo: { codice: 'non_letto', valore: null }, scadenza: null, letto: null };
  }
}

/** Solo la lettura (per «+ Aggiungi impresa» da una foto alla visura o al DURC). */
async function leggi({ file, companyId, chiedi = chiediAlModello }) {
  return pulisci(await chiedi({ buffer: file.buffer, mimetype: file.mimetype, companyId }));
}

module.exports = { controlla, giudica, pulisci, leggi, motivoItaliano, NOMI, PROMPT };
