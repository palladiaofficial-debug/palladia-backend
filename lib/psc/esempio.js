'use strict';
/**
 * lib/psc/esempio.js — F-270. Il cantiere di esempio: un PSC già compilato e
 * pronto da firmare, per capire in due minuti come funziona tutto. Imprese
 * fittizie senza email (nessun invio parte), dati di contesto scritti qui
 * (nessuna chiamata alle mappe). Si cancella come un cantiere qualunque.
 */
const supabase = require('../supabase');
const L = require('./lavorazioni');
const { proponi } = require('./costi');
const { soluzioni, detect } = require('./interferenze');
const cat = require('./catalog');
const store = require('./store');

async function creaEsempio(companyId, user) {
  const def = await store.defaults(companyId, user);
  // Nell'esempio tutto è già approvato: si vede il PSC "finito"
  for (const v of Object.values(def.organizzazione)) v.approvata = true;
  def.uso_comune = cat.USO_COMUNE.slice(0, 4).map(u => ({ key: u.key, titolo: u.titolo, testo: u.testo, fonte: 'palladia', approvata: true }));
  def.coordinamento.approvato = true;
  def.emergenze = { ...def.emergenze, approvato: true, punto_raccolta: 'Cortile interno, lato via San Vincenzo', pronto_soccorso: { nome: 'Ospedale Galliera', indirizzo: 'Via Alessandro Volta 8, Genova', distanza_km: 0.9, minuti: 3 } };
  const C = cat.CONTESTO;
  const contesto = {
    analizzato: true, fonte: 'esempio', domande: { edificio_in_uso: true },
    trovati: [
      { key: 'strada', titolo: C.strada.titolo, dettaglio: 'Corso Andrea Podestà, a 32 m', distanza_m: 32, fonte: 'OpenStreetMap', attivo: true, misure: C.strada.misure },
      { key: 'scuola', titolo: C.scuola.titolo, dettaglio: 'Scuola dell\'infanzia a 49 m', distanza_m: 49, fonte: 'OpenStreetMap', attivo: true, misure: C.scuola.misure },
      { key: 'fermata_bus', titolo: C.fermata_bus.titolo, dettaglio: 'a 77 m', distanza_m: 77, fonte: 'OpenStreetMap', attivo: true, misure: C.fermata_bus.misure },
    ],
    da_sopralluogo: cat.DA_SOPRALLUOGO.map(d => ({ key: d.key, titolo: C[d.key].titolo, domanda: d.domanda, verificato: false })),
    ordigni: { esito: 'nessuno_scavo', testo: cat.ORDIGNI.nessuno_scavo.testo },
  };
  const { data: p, error } = await supabase.from('psc_projects').insert({
    company_id: companyId, created_by: user.id, esempio: true, source: 'indirizzo',
    title: 'Esempio · Ristrutturazione Scuola Media G. Mazzini',
    address: 'Via XX Settembre 20', comune: 'Genova', provincia: 'GE', lat: 44.4054085, lon: 8.9397173,
    descrizione: 'Ristrutturazione interna del secondo piano, rifacimento della copertura in coppi, nuovo impianto elettrico, sostituzione dei serramenti e tinteggiature.',
    tipo_opera: 'Edilizia scolastica, manutenzione straordinaria',
    start_date: '2026-10-12', end_date: '2026-12-23', importo_lavori: 136000,
    ...def,
    soggetti: { ...def.soggetti, committente: { nome: 'Comune di Genova (esempio)' }, responsabile_lavori: { nome: 'Arch. Paolo Verdi (esempio)', qualifica: 'RUP' } },
    contesto,
  }).select('*').single();
  if (error) throw error;

  const imp = [
    { ragione_sociale: 'Edil Rossi S.r.l. (esempio)', ruolo: 'affidataria', color: '#22384F', referente: 'Mario Rossi' },
    { ragione_sociale: 'Ponteggi Riviera S.r.l. (esempio)', ruolo: 'esecutrice', color: '#B7832F', referente: 'Luca Neri' },
    { ragione_sociale: 'Elettro Sud S.n.c. (esempio)', ruolo: 'esecutrice', color: '#3E7C78', referente: 'Anna Sala' },
  ];
  const { data: imprese } = await supabase.from('psc_imprese').insert(imp.map(x => ({ ...x, project_id: p.id, company_id: companyId }))).select('*');
  const byRuolo = (n) => imprese.find(i => i.ragione_sociale.startsWith(n)).id;
  const piano = [
    ['allestimento-cantiere', 'Edil', '', '2026-10-12', '2026-10-16', 3, 15],
    ['demolizioni-interne', 'Edil', 'aule secondo piano', '2026-10-19', '2026-10-30', 4, 40],
    ['ponteggio-montaggio', 'Ponteggi', 'facciata nord', '2026-10-19', '2026-11-06', 3, 45],
    ['coperture-lavori', 'Edil', 'copertura', '2026-11-09', '2026-12-04', 4, 80],
    ['impianti-elettrici', 'Elettro', '', '2026-10-26', '2026-11-20', 2, 40],
    ['serramenti', 'Edil', 'aule secondo piano', '2026-11-23', '2026-12-04', 2, 20],
    ['tinteggiature', 'Edil', 'aule secondo piano', '2026-12-07', '2026-12-18', 3, 30],
  ];
  const lavRows = piano.map(([sid, im, area, s, e, addetti, ug], i) => {
    const b = L.fromScheda(sid, { library: [] });
    return { ...b, misure: b.misure.map(m => ({ ...m, approvata: true })), project_id: p.id, company_id: companyId, ordine: i, impresa_id: byRuolo(im), area, start_date: s, end_date: e, addetti, uomini_giorno: ug };
  });
  const { data: lavs } = await supabase.from('psc_lavorazioni').insert(lavRows).select('*');
  // Una interferenza già decisa; l'altra resta aperta da provare
  const inter = detect(lavs, []).aperte;
  const lavById = new Map(lavs.map(l => [l.id, l]));
  const impById = new Map(imprese.map(i => [i.id, i]));
  const prima = inter.find(x => /ponteggio/i.test(`${x.nome_a} ${x.nome_b}`)) || inter[0];
  if (prima) {
    const s = soluzioni(prima, lavById, impById, p.end_date);
    const m = s.opzioni.find(o => o.soluzione === 'misure');
    await supabase.from('psc_interferenze').insert({ project_id: p.id, company_id: companyId, lav_a: prima.lav_a < prima.lav_b ? prima.lav_a : prima.lav_b, lav_b: prima.lav_a < prima.lav_b ? prima.lav_b : prima.lav_a, soluzione: 'misure', testo: m.testo, rischio: s.rischio, decided_by: user.id });
  }
  const { data: dec } = await supabase.from('psc_interferenze').select('*').eq('project_id', p.id);
  const qta = { recinzione: 120, ponteggio: 420, ponteggio_nolo: 420, mantovana: 35, teli: 420, parapetti: 90, linea_vita: 40, cartelli: 12, estintori: 4, transenne_interferenze: 40 };
  const costi = proponi({ project: p, lavorazioni: lavs, contestoKeys: new Set(['strada', 'scuola', 'fermata_bus', 'edificio_in_uso']), decisioni: dec || [], nImprese: imprese.length, library: [] })
    .map(c => { const k = (c.origine || '').replace('catalogo:', ''); return { ...c, quantita: c.quantita || qta[k] || 1, prezzo_fonte: 'manuale', project_id: p.id, company_id: companyId, impresa_id: c.categoria === 'a' && /ponteg|mantovan|teli/i.test(c.descrizione) ? byRuolo('Ponteggi') : byRuolo('Edil') }; });
  if (costi.length) await supabase.from('psc_costi').insert(costi);
  return p;
}

module.exports = { creaEsempio };
