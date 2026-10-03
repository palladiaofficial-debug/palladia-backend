'use strict';
/**
 * lib/psc/posVerify.js — F-270. Verifica di idoneità del POS di un'impresa
 * (art. 92 c.1 b): il modello legge il POS e dice, per ogni contenuto minimo
 * dell'Allegato XV punto 3.2.1, se c'è e a che pagina; elenca lavoratori con
 * formazione, attrezzature con verifiche, lavorazioni. Poi i controlli
 * incrociati con il PSC li fa il codice (non il modello): lavorazioni affidate,
 * prescrizioni sulle interferenze recepite, abilitazioni richieste dalle
 * attrezzature e dalle lavorazioni.
 *
 * Il coordinatore decide l'esito: Palladia propone i controlli e il messaggio.
 */
const { callTool, contentFromFile } = require('./ai');
const { POS_CONTENUTI } = require('./catalog');
const { getScheda, FORMAZIONE } = require('../lavorazioniSchede');

const TOOL = {
  name: 'verifica_pos',
  description: 'Restituisce cosa contiene il POS rispetto ai contenuti minimi e ai riferimenti indicati.',
  input_schema: {
    type: 'object',
    properties: {
      e_un_pos: { type: 'boolean', description: 'false se il documento chiaramente NON è un Piano Operativo di Sicurezza' },
      impresa: { type: 'string', description: 'Ragione sociale dell\'impresa che presenta il POS' },
      cantiere: { type: 'string', description: 'Cantiere/opera a cui si riferisce il POS' },
      contenuti: {
        type: 'array', description: 'Uno per ogni contenuto minimo richiesto (chiave indicata nel messaggio)',
        items: { type: 'object', properties: {
          key: { type: 'string' }, presente: { type: 'boolean' }, pagina: { type: 'integer' }, nota: { type: 'string', description: 'Cosa c\'è o cosa manca, in una frase' },
        }, required: ['key', 'presente'] },
      },
      lavoratori: {
        type: 'array', description: 'Lavoratori elencati nel POS',
        items: { type: 'object', properties: {
          nome: { type: 'string' }, mansione: { type: 'string' },
          formazione: { type: 'array', items: { type: 'string' }, description: 'Corsi/abilitazioni indicati per questa persona' },
          pagina: { type: 'integer' },
        }, required: ['nome'] },
      },
      attrezzature: {
        type: 'array', description: 'Macchine, attrezzature e opere provvisionali elencate',
        items: { type: 'object', properties: {
          nome: { type: 'string' }, verifiche_indicate: { type: 'boolean', description: 'true se il POS indica verifiche periodiche/libretto/date di verifica' },
          dettaglio_verifica: { type: 'string' }, pagina: { type: 'integer' },
        }, required: ['nome'] },
      },
      lavorazioni: { type: 'array', items: { type: 'string' }, description: 'Lavorazioni che l\'impresa dichiara di svolgere' },
      prescrizioni: {
        type: 'array', description: 'Per ogni prescrizione del PSC indicata nel messaggio (id), se il POS la recepisce',
        items: { type: 'object', properties: { id: { type: 'string' }, recepita: { type: 'boolean' }, pagina: { type: 'integer' } }, required: ['id', 'recepita'] },
      },
    },
    required: ['e_un_pos', 'contenuti'],
  },
};

function systemPrompt(impresa, prescrizioni) {
  const contenuti = POS_CONTENUTI.map(c => `- ${c.key}: ${c.titolo}${c.dettaglio ? ` (${c.dettaglio})` : ''}`).join('\n');
  const presc = prescrizioni.length
    ? prescrizioni.map(p => `- ${p.id}: ${p.testo}`).join('\n')
    : '(nessuna)';
  return `Sei un coordinatore per la sicurezza in fase di esecuzione. Verifica il POS dell'impresa "${impresa}" e compila lo strumento verifica_pos.
Contenuti minimi del POS (D.Lgs. 81/2008, Allegato XV, punto 3.2.1), uno per chiave:
${contenuti}
Prescrizioni del PSC che questo POS deve recepire (id: testo):
${presc}
Regole:
- Riporta solo ciò che c'è nel documento: "presente" è true solo se il contenuto c'è davvero, non se è solo citato come titolo vuoto.
- "pagina" è il numero di pagina del PDF ("--- Pagina N ---") dove si trova.
- Per ogni attrezzatura indica se il POS riporta verifiche periodiche o date di verifica.
- Per i lavoratori riporta i corsi e le abilitazioni scritti accanto al nome (es. "PLE", "ponteggi", "preposto", "primo soccorso").`;
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const pg = (v, n) => (Number.isInteger(v) && v >= 1 && (!n || v <= n) ? v : null);

function sanitize(raw, numPages, prescrizioni) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const keys = new Set(POS_CONTENUTI.map(c => c.key));
  const contenuti = new Map();
  for (const c of Array.isArray(r.contenuti) ? r.contenuti : []) {
    if (!c || !keys.has(c.key) || contenuti.has(c.key)) continue;
    contenuti.set(c.key, { presente: c.presente === true, pagina: pg(c.pagina, numPages), nota: str(c.nota, 240) });
  }
  const prescIds = new Set(prescrizioni.map(p => p.id));
  return {
    isPos: r.e_un_pos !== false,
    impresa: str(r.impresa, 160),
    cantiere: str(r.cantiere, 200),
    contenuti,
    lavoratori: (Array.isArray(r.lavoratori) ? r.lavoratori : []).slice(0, 80).map(l => ({
      nome: str(l && l.nome, 100), mansione: str(l && l.mansione, 100),
      formazione: (Array.isArray(l && l.formazione) ? l.formazione : []).slice(0, 15).map(x => str(x, 120)).filter(Boolean),
      pagina: pg(l && l.pagina, numPages),
    })).filter(l => l.nome),
    attrezzature: (Array.isArray(r.attrezzature) ? r.attrezzature : []).slice(0, 80).map(a => ({
      nome: str(a && a.nome, 140), verifiche: a && a.verifiche_indicate === true, dettaglio: str(a && a.dettaglio_verifica, 160), pagina: pg(a && a.pagina, numPages),
    })).filter(a => a.nome),
    lavorazioni: (Array.isArray(r.lavorazioni) ? r.lavorazioni : []).slice(0, 40).map(x => str(x, 160)).filter(Boolean),
    prescrizioni: new Map((Array.isArray(r.prescrizioni) ? r.prescrizioni : [])
      .filter(p => p && prescIds.has(p.id)).map(p => [p.id, { recepita: p.recepita === true, pagina: pg(p.pagina, numPages) }])),
  };
}

// Attrezzature e lavorazioni che richiedono un'abilitazione/formazione specifica.
const ABILITAZIONI = [
  { re: /piattaform|\bple\b|cestello/i, form: 'ple', corso: /\bple\b|piattaform/i, nome: 'PLE' },
  { re: /gru a torre/i, form: 'gru_torre', corso: /gru a torre/i, nome: 'gru a torre' },
  { re: /autogru|gru mobil|gru su autocarro/i, form: 'autogru', corso: /autogru|gru mobil|gru su autocarro/i, nome: 'gru mobile' },
  { re: /escavator|terna|pala|miniescav/i, form: 'mmt', corso: /escavator|terna|pala|movimento terra|\bmmt\b/i, nome: 'macchine movimento terra' },
  { re: /carrell|sollevatore telescop|muletto/i, form: 'sollevatore', corso: /carrell|sollevator|muletto/i, nome: 'carrelli/sollevatori' },
  { re: /pompa.*calcestruz/i, form: 'pompa_cls', corso: /pompa/i, nome: 'pompa per calcestruzzo' },
];

/**
 * Controlli finali, in linguaggio chiaro, con la pagina.
 * @param {object} res sanitize()
 * @param {object} ctx { lavorazioniImpresa: [{nome, scheda_id}], prescrizioni: [{id, testo, titolo}] }
 */
function controlli(res, ctx) {
  const out = [];
  // 1) contenuti minimi
  const mancanti = POS_CONTENUTI.filter(c => !(res.contenuti.get(c.key) || {}).presente);
  if (!mancanti.length) out.push({ key: 'contenuti', esito: 'ok', titolo: 'Contenuti minimi dell\'Allegato XV (3.2.1) presenti', dettaglio: `${POS_CONTENUTI.length} su ${POS_CONTENUTI.length}` });
  else for (const c of mancanti) {
    const info = res.contenuti.get(c.key);
    out.push({ key: `contenuto_${c.key}`, esito: 'manca', titolo: `Manca: ${c.titolo.toLowerCase()}`, dettaglio: info && info.nota ? info.nota : 'Non trovato nel documento', pagina: info ? info.pagina : null });
  }

  // 2) lavorazioni affidate nel PSC
  const testoLav = res.lavorazioni.join(' | ').toLowerCase();
  for (const l of ctx.lavorazioniImpresa || []) {
    const parole = l.nome.toLowerCase().split(/[^a-zàèéìòù]+/).filter(w => w.length > 4).slice(0, 3);
    const trovata = parole.some(w => testoLav.includes(w.slice(0, 6)));
    out.push(trovata
      ? { key: `lav_${l.nome}`, esito: 'ok', titolo: `Lavorazione del PSC descritta: ${l.nome}` }
      : { key: `lav_${l.nome}`, esito: 'da_verificare', titolo: `Lavorazione affidata nel PSC non trovata: ${l.nome}`, dettaglio: 'Il POS deve descrivere le lavorazioni che l\'impresa svolge in questo cantiere' });
  }

  // 3) prescrizioni del PSC (interferenze, uso comune)
  for (const p of ctx.prescrizioni || []) {
    const r = res.prescrizioni.get(p.id);
    out.push(r && r.recepita
      ? { key: `presc_${p.id}`, esito: 'ok', titolo: `Recepita: ${p.titolo}`, pagina: r.pagina }
      : { key: `presc_${p.id}`, esito: 'manca', titolo: `Non recepita: ${p.titolo}`, dettaglio: p.testo });
  }

  // 4) abilitazioni per le attrezzature dichiarate
  const corsiDi = (l) => l.formazione.join(' | ');
  for (const ab of ABILITAZIONI) {
    const att = res.attrezzature.find(a => ab.re.test(a.nome));
    if (!att) continue;
    const abilitati = res.lavoratori.filter(l => ab.corso.test(corsiDi(l)));
    if (!abilitati.length) {
      out.push({ key: `abil_${ab.form}`, esito: 'manca', titolo: `Nessun lavoratore abilitato ${ab.nome}`, dettaglio: `Il POS indica "${att.nome}" ma nessun lavoratore ha l'abilitazione (${FORMAZIONE[ab.form] || ab.nome})`, pagina: att.pagina });
    } else {
      out.push({ key: `abil_${ab.form}`, esito: 'ok', titolo: `Abilitazione ${ab.nome}: ${abilitati.map(l => l.nome).slice(0, 3).join(', ')}`, pagina: abilitati[0].pagina });
    }
  }
  // 5) formazione richiesta dalle lavorazioni del PSC (ponteggi, anticaduta, preposto)
  const formRichiesta = new Set();
  for (const l of ctx.lavorazioniImpresa || []) {
    const s = l.scheda_id ? getScheda(l.scheda_id) : null;
    if (s) for (const f of s.formazione) if (['ponteggi', 'anticaduta', 'preposto', 'spazi_confinati', 'amianto', 'pes_pav'].includes(f)) formRichiesta.add(f);
  }
  const CORSO = { ponteggi: /ponteg/i, anticaduta: /quota|anticaduta|dpi.*iii|terza categoria/i, preposto: /prepost/i, spazi_confinati: /confinat/i, amianto: /amianto/i, pes_pav: /\bpes\b|\bpav\b|cei 11-27/i };
  for (const f of formRichiesta) {
    const ok = res.lavoratori.some(l => CORSO[f].test(corsiDi(l)));
    out.push(ok
      ? { key: `form_${f}`, esito: 'ok', titolo: `Formazione richiesta presente: ${FORMAZIONE[f]}` }
      : { key: `form_${f}`, esito: 'manca', titolo: `Formazione richiesta non indicata: ${FORMAZIONE[f]}`, dettaglio: 'Richiesta dalle lavorazioni affidate nel PSC' });
  }
  // 6) verifiche delle attrezzature
  for (const a of res.attrezzature) {
    if (!/piattaform|\bple\b|gru|ponteggi|argano|montacarich|sollevator|carrell|escavator/i.test(a.nome)) continue;
    if (!a.verifiche) out.push({ key: `verif_${a.nome}`, esito: 'da_verificare', titolo: `${a.nome}: nessuna data di verifica periodica`, dettaglio: 'Chiedere libretto e ultima verifica (Allegato VII)', pagina: a.pagina });
  }
  return out;
}

const fmtPag = (c) => (c.pagina ? ` (pag. ${c.pagina})` : '');

/** Messaggio pronto per l'impresa. */
function messaggio({ impresa, cantiere, cse, esitoCheck }) {
  const problemi = esitoCheck.filter(c => c.esito !== 'ok');
  if (!problemi.length) {
    return `Gentile ${impresa},\nho verificato il vostro POS per il cantiere ${cantiere}: lo ritengo idoneo. Potete iniziare i lavori secondo il cronoprogramma del PSC.\n\nCordiali saluti,\n${cse}`;
  }
  const righe = problemi.map(c => `- ${c.titolo}${fmtPag(c)}${c.dettaglio && c.esito !== 'manca' ? `: ${c.dettaglio}` : ''}`).join('\n');
  return `Gentile ${impresa},\nho verificato il vostro POS per il cantiere ${cantiere}. Prima di iniziare i lavori vi chiedo di integrarlo con:\n${righe}\n\nPotete caricare il POS aggiornato dallo stesso link che avete ricevuto.\n\nCordiali saluti,\n${cse}`;
}

/**
 * @param {object} p { buffer, mime, companyId, userId, impresa, lavorazioniImpresa, prescrizioni }
 */
async function verifica(p, deps = {}) {
  const { content, numPages, source } = await contentFromFile(p.buffer, p.mime || 'application/pdf', `POS dell'impresa "${p.impresa}"`);
  const ai = deps.ai || ((args) => callTool(args));
  const { input } = await ai({ system: systemPrompt(p.impresa, p.prescrizioni || []), content, tool: TOOL, maxTokens: 8000, companyId: p.companyId, userId: p.userId, callSite: 'psc_pos_verify' });
  if (!input) { const e = new Error('Non sono riuscito a leggere il POS'); e.status = 502; throw e; }
  const res = sanitize(input, numPages, p.prescrizioni || []);
  if (!res.isPos) return { isPos: false, numPages, source, checks: [] };
  const checks = controlli(res, { lavorazioniImpresa: p.lavorazioniImpresa || [], prescrizioni: p.prescrizioni || [] });
  return {
    isPos: true, numPages, source, checks,
    riepilogo: { lavoratori: res.lavoratori.length, attrezzature: res.attrezzature.length, impresa_dichiarata: res.impresa, cantiere_dichiarato: res.cantiere },
  };
}

module.exports = { TOOL, sanitize, controlli, messaggio, verifica, systemPrompt };
