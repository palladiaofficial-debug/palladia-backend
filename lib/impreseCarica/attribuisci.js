'use strict';
/**
 * lib/impreseCarica/attribuisci.js — F-401: di chi è un documento e se va bene.
 * Puro (nessun DB, nessun modello): provato da scripts/selftest_imprese_carica.js.
 *
 * Impresa, in quest'ordine:
 *   1. partita IVA scritta sul foglio = quella di un'impresa  → certa
 *   2. visita o attestato: il codice fiscale (o il nome, se uno solo somiglia
 *      molto) di un operaio già noto → l'impresa di quell'operaio
 *   3. ragione sociale che somiglia a una sola impresa
 *   4. l'impresa da cui si è partiti (se si carica dalla sua scheda)
 *   5. un'impresa nuova, se il foglio ha nome e partita IVA
 *   6. altrimenti «da assegnare»: meglio una domanda che un documento sbagliato.
 * Un foglio con la NOSTRA partita IVA è della nostra impresa: non si mette su un'altra.
 * Operaio: codice fiscale, poi nome; se non c'è → operaio nuovo da aggiungere.
 * Il giudizio è quello di Imprese (lib/impreseControllo.giudica): impresa
 * sbagliata, scaduto, visura vecchia, firma mancante, POS di un altro cantiere.
 */
const { giudica, paroleIndirizzo } = require('../impreseControllo');
const { scoreDitta } = require('../documentiLeggi');
const { scoreMatch, normName } = require('../fuzzyMatch');

const PERSONA = new Set(['idoneita', 'formazione', 'attestato']);
const IMPRESA = new Set(['durc', 'visura', 'dvr', 'dichiarazione', 'assicurazione', 'pos', 'altro']);
const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

/**
 * Quanto somigliano due nomi di persona. Le parole in qualsiasi ordine
 * («NERI PAOLO» = «Paolo Neri») valgono 100; tutte quelle del nome più corto
 * (almeno due) dentro il più lungo («Giuseppe Di Leonardo» in «Di Leonardo
 * Giuseppe Salvatore») 90; altrimenti il punteggio di fuzzyMatch.
 */
function somiglianza(a, b) {
  const pa = normName(a).split(' ').filter(t => t.length > 1), pb = normName(b).split(' ').filter(t => t.length > 1);
  if (!pa.length || !pb.length) return 0;
  const [corto, lungo] = pa.length <= pb.length ? [pa, new Set(pb)] : [pb, new Set(pa)];
  if (corto.every(t => lungo.has(t))) return corto.length === lungo.size ? 100 : corto.length >= 2 ? 90 : scoreMatch(a, b);
  return scoreMatch(a, b);
}

function operaioPer(letto, operai) {
  if (letto.cfPersona) {
    const o = operai.find(x => x.cf && x.cf.toUpperCase() === letto.cfPersona);
    if (o) return { o, come: 'cf' };
  }
  if (letto.persona) {
    const punti = operai.map(o => ({ o, s: somiglianza(letto.persona, o.nome) })).filter(x => x.s >= 80).sort((a, b) => b.s - a.s);
    // Uno solo, o il primo nettamente meglio del secondo
    if (punti.length === 1 || (punti.length > 1 && punti[0].s - punti[1].s >= 10)) return { o: punti[0].o, come: 'nome' };
  }
  return null;
}

function cantierePer(letto, cantieri) {
  if (!cantieri?.length) return null;
  if (letto.cantiere) {
    // Il cantiere con più parole in comune, se è uno solo («Genova» da sola non basta)
    const lette = new Set(paroleIndirizzo(letto.cantiere));
    const punti = cantieri.map(c => ({ c, n: new Set([...paroleIndirizzo(c.nome), ...paroleIndirizzo(c.indirizzo)].filter(w => lette.has(w))).size }))
      .filter(x => x.n > 0).sort((a, b) => b.n - a.n);
    if (punti.length && (punti.length === 1 || punti[0].n > punti[1].n)) return punti[0].c.id;
  }
  return cantieri.length === 1 ? cantieri[0].id : null;
}

/** Il giudizio sul documento, con l'attribuzione data. Ricalcolato a ogni correzione. */
function giudizio(p, letto, ctx) {
  const oggi = ctx.oggi || oggiRoma();
  if (p.nostra) return { esito: 'non_va', motivo: { codice: 'nostra_impresa', valore: null }, scadenza: letto.scadenza };
  if (p.tipo === 'altro') return { esito: 'va_bene', motivo: null, scadenza: letto.scadenza };
  if (p.tipo === 'attestato') {
    const scad = p.scadenzaScelta || letto.scadenza;
    return scad && scad < oggi ? { esito: 'non_va', motivo: { codice: 'scaduto', valore: scad }, scadenza: scad } : { esito: 'va_bene', motivo: null, scadenza: scad };
  }
  const impresa = p.impresa?.id ? ctx.imprese.find(i => i.id === p.impresa.id) : p.impresa?.nuova || null;
  const operaio = p.operaio?.id ? ctx.operai.find(o => o.id === p.operaio.id) : null;
  const cantiere = p.siteId ? (ctx.cantieriPer[p.impresa?.id] || []).find(c => c.id === p.siteId) : null;
  const g = giudica(p.tipo, { ...letto, tipo: p.tipo, scadenza: p.scadenzaScelta || letto.scadenza }, {
    oggi,
    impresa: IMPRESA.has(p.tipo) && impresa ? { nome: impresa.daCompletare ? null : impresa.nome, piva: impresa.piva } : null,
    operaio: operaio ? { nome: operaio.nome } : null,
    cantiere: cantiere ? { nome: cantiere.nome, indirizzo: cantiere.indirizzo } : null,
  });
  return { esito: g.esito, motivo: g.motivo, scadenza: g.scadenza };
}

/**
 * letto (lettura.pulisci) + ctx { imprese: [{id,nome,piva,daCompletare}], operai: [{id,nome,cf,subId}],
 * cantieriPer: { [subId]: [{id,nome,indirizzo}] }, pre: subId|null, pivaNostra, oggi } → proposta
 */
function attribuisci(letto, ctx) {
  const persona = PERSONA.has(letto.tipo);
  const p = {
    tipo: letto.tipo, titolo: letto.titolo, corso: letto.corso,
    impresa: null, come: null, nostra: false, operaio: null, siteId: null,
    scadenzaScelta: null, scartato: false,
  };
  if (letto.piva && ctx.pivaNostra && letto.piva === ctx.pivaNostra && !persona) p.nostra = true;

  // 1. partita IVA
  const perPiva = letto.piva ? ctx.imprese.find(i => i.piva && i.piva.replace(/\D/g, '') === letto.piva) : null;
  if (perPiva && !p.nostra) { p.impresa = { id: perPiva.id }; p.come = 'piva'; }
  // 2. l'operaio, se il foglio è di una persona
  let op = null;
  if (persona) {
    const tra = p.impresa ? ctx.operai.filter(o => o.subId === p.impresa.id) : ctx.operai;
    op = operaioPer(letto, tra);
    if (op && !p.impresa) { p.impresa = { id: op.o.subId }; p.come = 'operaio'; }
  }
  // 3. ragione sociale
  if (!p.impresa && !p.nostra && letto.ragioneSociale) {
    const punti = ctx.imprese.map(i => ({ i, s: i.daCompletare ? 0 : scoreDitta(letto.ragioneSociale, i.nome) })).filter(x => x.s >= 60).sort((a, b) => b.s - a.s);
    if (punti.length === 1 || (punti.length > 1 && punti[0].s - punti[1].s >= 10)) { p.impresa = { id: punti[0].i.id }; p.come = 'nome'; }
  }
  // 4. l'impresa da cui si è partiti. Un foglio d'impresa che nomina un'ALTRA ditta
  //    (partita IVA di nessuno, o un nome che non le somiglia) NON ci finisce: è
  //    di un'altra impresa (5). Trovato dal test su palladia.net: il DURC di
  //    un'altra ditta, senza P.IVA letta, finiva sull'impresa di partenza.
  const pre = ctx.pre ? ctx.imprese.find(i => i.id === ctx.pre) : null;
  const altraDitta = !persona && (!!letto.piva || (!!letto.ragioneSociale && !!pre && !pre.daCompletare && scoreDitta(letto.ragioneSociale, pre.nome) < 60));
  if (!p.impresa && !p.nostra && pre && !altraDitta) { p.impresa = { id: pre.id }; p.come = 'scelta'; }
  // 5. impresa nuova: dal nome (e dalla partita IVA, se c'è)
  if (!p.impresa && !p.nostra && !persona && letto.ragioneSociale) {
    p.impresa = { nuova: { nome: letto.ragioneSociale, piva: letto.piva || null, sede: letto.sede } }; p.come = 'nuova';
  }

  if (persona && p.impresa?.id && !op) op = operaioPer(letto, ctx.operai.filter(o => o.subId === p.impresa.id));
  if (persona) p.operaio = op ? { id: op.o.id } : letto.persona ? { nuovo: { nome: letto.persona, cf: letto.cfPersona } } : null;
  if (p.tipo === 'pos' && p.impresa?.id) p.siteId = cantierePer(letto, ctx.cantieriPer[p.impresa.id]);
  return { ...p, ...giudizio(p, letto, ctx) };
}

module.exports = { attribuisci, giudizio, somiglianza, PERSONA, IMPRESA };
