'use strict';
/**
 * lib/daRinnovare.js — F-417 (AUDIT.md del frontend): «Da rinnovare», la
 * schermata 6 del disegno del lancio.
 *
 * Una pagina sola con quello che è scaduto, quello che manca e quello che
 * scade entro un mese, di tutti: i tuoi operai, la tua impresa, i mezzi, i
 * cantieri, le imprese in subappalto e i loro operai. Nessun calcolo nuovo:
 *  - stati e regole sono quelli di Documenti (lib/documentiStato.js), cioè le
 *    stesse date che guardano il badge e la scheda;
 *  - gli operai delle imprese sono quelli di Da fare (lib/impreseScadenze.js).
 * Per ogni riga, cosa fare:
 *  - «carica»: tuoi operai e tua impresa → /carica (F-415 capisce di chi è);
 *    mezzi e cantieri → la loro scheda in Documenti (sa già cosa caricare);
 *  - «chiedi»: un'impresa o un suo operaio → il messaggio con il link per l'impresa.
 */
const { stati } = require('./documentiStato');
const { scadenzeOperaiImprese } = require('./impreseScadenze');

const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const piuGiorni = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function azione(kind, id) {
  if (kind === 'subappaltatori') return { azione: 'chiedi', impresaId: id };
  if (kind === 'lavoratori' || kind === 'impresa') return { azione: 'carica', link: '/carica' };
  return { azione: 'carica', link: `/documenti/${kind}/${id}` };
}

async function daRinnovare(companyId, { oggi } = {}) {
  const today = oggi || oggiRoma();
  const fra30 = piuGiorni(today, 30);
  const { stati: tutti, subsEnabled } = await stati(companyId);
  const righe = [];
  for (const o of tutti) {
    const voci = [
      ...o.requirements.filter(r => !r.consigliata).map(r => ({ chiave: r.key, label: r.label, state: r.state, expiry: r.expiry || null })),
      ...o.documents.map(d => ({ chiave: d.id, label: d.label, state: d.state, expiry: d.expiry || null })),
    ];
    for (const v of voci) {
      if (!['scaduto', 'manca', 'in_scadenza'].includes(v.state)) continue;
      righe.push({
        id: `${o.kind}:${o.id}:${v.chiave}`, kind: o.kind,
        chi: o.kind === 'impresa' ? 'La tua impresa' : o.name, cosa: v.label,
        scadenza: v.expiry, stato: v.state, ...azione(o.kind, o.id),
      });
    }
  }
  if (subsEnabled) {
    for (const d of await scadenzeOperaiImprese(companyId, { horizon: fra30 })) {
      righe.push({
        id: `operaio_impresa:${d.id}`, kind: 'operaio_impresa',
        chi: `${d.nome} (${d.impresa})`, cosa: d.label, scadenza: d.scadenza,
        stato: d.scadenza < today ? 'scaduto' : 'in_scadenza', azione: 'chiedi', impresaId: d.subId,
      });
    }
  }
  const per = (a, b) => String(a.scadenza || '').localeCompare(String(b.scadenza || '')) || a.chi.localeCompare(b.chi, 'it');
  const scaduti = righe.filter(r => r.stato === 'scaduto').sort(per);
  const mancano = righe.filter(r => r.stato === 'manca').sort((a, b) => a.chi.localeCompare(b.chi, 'it'));
  const entroUnMese = righe.filter(r => r.stato === 'in_scadenza' && r.scadenza && r.scadenza <= fra30).sort(per);
  return { scaduti, mancano, entroUnMese, totale: scaduti.length + mancano.length + entroUnMese.length };
}

module.exports = { daRinnovare };
