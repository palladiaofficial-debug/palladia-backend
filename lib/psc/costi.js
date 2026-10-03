'use strict';
/**
 * lib/psc/costi.js — F-270. Costi della sicurezza (Allegato XV, punto 4):
 * proposta delle voci a partire da lavorazioni, contesto e interferenze;
 * prezzi del coordinatore (libreria) prima di quelli indicativi; totali per
 * categoria e per impresa. Funzioni pure.
 */
const { VOCI_COSTO, CATEGORIE_COSTI } = require('./catalog');

const DAY = 86400000;

function mesiLavori(start, end) {
  if (!start || !end) return 1;
  const giorni = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1);
  return Math.max(1, Math.ceil(giorni / 30));
}

function riunioniPreviste(start, end) {
  if (!start || !end) return 3;
  const settimane = Math.max(1, Math.ceil((Date.parse(end) - Date.parse(start)) / (7 * DAY)));
  return Math.ceil(settimane / 2) + 1; // inizio lavori + una ogni due settimane
}

/**
 * @param {object} p { project, lavorazioni, contestoKeys:Set<string>, decisioni:Array, nImprese:number, library:Array, esistenti:Array }
 * @returns {Array} righe da inserire in psc_costi (senza id/project/company)
 */
function proponi({ project, lavorazioni = [], contestoKeys = new Set(), decisioni = [], nImprese = 0, library = [], esistenti = [] }) {
  const schede = new Set(lavorazioni.map(l => l.scheda_id).filter(Boolean));
  const giaKey = new Set(esistenti.map(e => e.origine).filter(Boolean));
  const libByKey = new Map();
  for (const l of library) if (l.kind === 'costo' && l.data && l.data.key && !libByKey.has(l.data.key)) libByKey.set(l.data.key, l);
  const mesi = mesiLavori(project.start_date, project.end_date);
  const riunioni = riunioniPreviste(project.start_date, project.end_date);
  const conMisure = decisioni.some(d => d.soluzione === 'misure');
  const conSpaziale = decisioni.some(d => d.soluzione === 'spaziale');

  const out = [];
  let ordine = esistenti.length;
  for (const v of VOCI_COSTO) {
    if (giaKey.has(`catalogo:${v.key}`)) continue;
    const serve = v.sempre
      || (v.schede && v.schede.some(s => schede.has(s)))
      || (v.contesto && v.contesto.some(c => contestoKeys.has(c)))
      || (v.interferenza && conMisure)
      || (v.sfasamento && conSpaziale);
    if (!serve) continue;
    const lib = libByKey.get(v.key);
    const quantita = v.q === 'mesi' ? mesi : v.q === 'uno' ? 1 : v.q === 'riunioni' ? riunioni * Math.max(2, nImprese) : 0;
    out.push({
      ordine: ordine++,
      categoria: v.cat,
      codice: lib && lib.data.codice ? lib.data.codice : null,
      descrizione: lib ? lib.testo : v.descrizione,
      um: lib && lib.data.um ? lib.data.um : v.um,
      quantita,
      prezzo: lib && Number(lib.data.prezzo) > 0 ? Number(lib.data.prezzo) : v.prezzo,
      prezzo_fonte: lib && Number(lib.data.prezzo) > 0 ? 'libreria' : 'indicativo',
      origine: `catalogo:${v.key}`,
    });
  }
  return out;
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Totali per categoria e per impresa. */
function riepilogo(costi, imprese = []) {
  const perCat = {};
  for (const k of Object.keys(CATEGORIE_COSTI)) perCat[k] = 0;
  const perImpresa = new Map(imprese.map(i => [i.id, 0]));
  let daRipartire = 0, totale = 0;
  for (const c of costi) {
    const imp = r2((Number(c.quantita) || 0) * (Number(c.prezzo) || 0));
    totale += imp;
    perCat[c.categoria] = (perCat[c.categoria] || 0) + imp;
    if (c.impresa_id && perImpresa.has(c.impresa_id)) perImpresa.set(c.impresa_id, perImpresa.get(c.impresa_id) + imp);
    else daRipartire += imp;
  }
  return {
    totale: r2(totale),
    perCategoria: Object.entries(perCat).map(([k, v]) => ({ categoria: k, titolo: CATEGORIE_COSTI[k], importo: r2(v) })),
    perImpresa: imprese.map(i => ({ impresa_id: i.id, ragione_sociale: i.ragione_sociale, importo: r2(perImpresa.get(i.id) || 0) })),
    daRipartire: r2(daRipartire),
    indicativi: costi.filter(c => c.prezzo_fonte === 'indicativo').length,
    daMisurare: costi.filter(c => !(Number(c.quantita) > 0)).length,
  };
}

module.exports = { proponi, riepilogo, mesiLavori, riunioniPreviste };
