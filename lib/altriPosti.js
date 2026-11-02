'use strict';
/**
 * lib/altriPosti.js — F-371 (AUDIT.md del frontend): Documenti e POS in fondo a Cantieri.
 *
 * Col menu a 4 voci (F-365) Documenti e POS erano finiti sotto il nome del
 * titolare, dove si va solo per le impostazioni: il titolare non li trovava
 * più. Ora sono due righe grandi in fondo a Cantieri, con un numero che dice
 * se c'è da fare qualcosa. I numeri sono gli stessi che Palladia mostra già:
 *  - documenti scaduti: come la riga «N documenti scaduti» della home
 *    (lib/oggi.js: voci di Da fare scadute, fine lavori escluse);
 *  - cantieri senza POS: come «Manca il POS» nella scheda del cantiere
 *    (lib/cantiereRiepilogo.js: cantieri al lavoro con il POS che manca).
 */
const { buildDaFare } = require('./daFare');
const { riepiloghi } = require('./cantiereRiepilogo');
const sicurezza = require('./sicurezzaCantieri');

/** Puro: dai dati già calcolati ai due numeri. */
function conta({ items = [], riepiloghi: r = new Map(), sicurezza: sic = null }) {
  const documentiScaduti = items.filter(i => i.kind === 'scadenza' && i.bucket === 'scaduto' && i.type !== 'fine_cantiere').length;
  let alLavoro = 0, senzaPos = 0;
  for (const x of r.values()) {
    if (!x.alLavoro) continue;
    alLavoro++;
    if (x.documenti?.pos === 'manca') senzaPos++;
  }
  // F-424: il numero sulla scheda «Sicurezza» = i cantieri da sistemare di quella pagina
  return { documenti: { scaduti: documentiScaduti }, pos: { senzaPos, alLavoro }, sicurezza: sic ? { daSistemare: sic.totale - sic.aPosto } : null };
}

async function costruisci(companyId, userId, role) {
  const [daFare, r, sic] = await Promise.all([buildDaFare(companyId, userId, { role }), riepiloghi(companyId), sicurezza.elenco(companyId).catch(() => null)]);
  return conta({ items: daFare.items, riepiloghi: r, sicurezza: sic });
}

module.exports = { conta, costruisci };
