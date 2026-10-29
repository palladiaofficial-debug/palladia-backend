'use strict';
/**
 * lib/impreseScadenze.js — F-401: le scadenze degli operai delle imprese in
 * subappalto (visita medica, corso sicurezza, altri attestati) per Da fare.
 *
 * Prima non avvisavano mai: Da fare guardava solo le date dell'impresa (DURC,
 * assicurazione, SOA). Per ogni operaio e documento conta l'ultimo caricato
 * (un rinnovo sostituisce il vecchio); un foglio che «non va» non conta.
 * Solo operai attivi di imprese attive.
 */
const supabase = require('./supabase');

const ETICHETTA = { idoneita: 'Visita medica', formazione: 'Corso sicurezza' };

async function scadenzeOperaiImprese(companyId, { horizon }) {
  const { data, error } = await supabase.from('sub_worker_documenti')
    .select('id, tipo, titolo, scadenza, esito, created_at, sub_workers!inner(id, full_name, deactivated_at, subcontractor_id, subcontractors!inner(id, company_name, is_active))')
    .eq('company_id', companyId).not('scadenza', 'is', null)
    .order('created_at', { ascending: false }).limit(5000);
  if (error) throw new Error(error.message);
  const visti = new Set();
  const out = [];
  for (const d of data || []) {
    const w = d.sub_workers, s = w?.subcontractors;
    if (!w || w.deactivated_at || !s?.is_active) continue;
    const k = `${w.id}|${d.tipo}|${d.titolo || ''}`;
    if (visti.has(k)) continue;           // il più recente fa fede
    visti.add(k);
    if (d.esito === 'non_va' || String(d.scadenza) > horizon) continue;
    out.push({
      id: d.id, subId: s.id, impresa: s.company_name, nome: w.full_name,
      label: ETICHETTA[d.tipo] || d.titolo || 'Attestato', scadenza: String(d.scadenza).slice(0, 10),
    });
  }
  return out;
}

module.exports = { scadenzeOperaiImprese };
