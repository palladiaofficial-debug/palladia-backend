'use strict';
/**
 * services/economiaOverview.js
 *
 * F-215 (AUDIT.md): pagina "Economia" unificata — sostituisce come fonte dati
 * per la vista d'insieme le tre pagine separate di oggi (Economia cantieri,
 * Economia subappaltatori, Spese aziendali). Non introduce una quarta fonte
 * di verità: legge le stesse tabelle già reali e in uso (site_costs,
 * company_expenses, site_sal_history, site_subcontractors) — nessun dato dal
 * registro Controllo Economico (site_economia_movimenti, F-119), ancora
 * dietro flag e mai validato su un'azienda reale.
 *
 * Due soli numeri per livello (azienda o singolo cantiere), niente storico
 * "speso/incassato" in prima vista — deciso dopo un giro dal vivo sui dati
 * reali dell'azienda, che ha mostrato quanto la vecchia struttura (3 pagine,
 * fino a 4 sezioni impilate per cantiere) restasse in pratica inutilizzata:
 *
 *   da_incassare = SAL emessi (site_sal_history.importo_maturato) MAI pagati
 *                  dal cliente (pagato_il IS NULL) — non "maturato totale",
 *                  che confonderebbe fatturato con soldi arrivati davvero.
 *   da_pagare    = fatture/altre spese aperte (site_costs + company_expenses,
 *                  pagato_il IS NULL) + saldo residuo verso i subappaltatori
 *                  (budget pattuito − acconti già dati, stesso identico
 *                  calcolo già in uso e verificato in
 *                  services/subcontractorEconomia.js — non ricalcolato qui
 *                  con una formula diversa che potrebbe disallinearsi).
 *
 * Un "acconto" (tipo='acconto') non è mai un debito aperto — per definizione
 * è denaro già dato — quindi è sempre escluso da da_pagare, sia per i
 * subappaltatori (già escluso dalla formula saldo_da_erogare) sia per
 * qualunque altro fornitore.
 */

const supabase = require('../lib/supabase');

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Un singolo cantiere ────────────────────────────────────────────────────
async function buildSiteEconomiaOverview(siteId, companyId) {
  const [siteRes, salRes, costsRes, expensesRes, subAssignRes, subAccontiRes] = await Promise.all([
    supabase.from('sites').select('id, name, budget_totale, sal_percentuale, status')
      .eq('id', siteId).eq('company_id', companyId).maybeSingle(),
    supabase.from('site_sal_history').select('id, sal_number, importo_maturato, pagato_il, data_emissione')
      .eq('site_id', siteId).eq('company_id', companyId),
    // subcontractor_id: escluso qui, il saldo verso i subappaltatori si calcola
    // sotto con la stessa formula (budget − acconti) già in uso altrove — non
    // sommare anche le loro fatture qui creerebbe un doppio conteggio.
    supabase.from('site_costs').select('id, importo, tipo, pagato_il, data_documento, descrizione, fornitore')
      .eq('site_id', siteId).eq('company_id', companyId).is('subcontractor_id', null),
    supabase.from('company_expenses').select('id, amount, pagato_il, expense_date, description, source')
      .eq('site_id', siteId).eq('company_id', companyId),
    supabase.from('site_subcontractors').select('subcontractor_id, budget_totale, subcontractor:subcontractor_id(company_name)')
      .eq('site_id', siteId).eq('company_id', companyId),
    supabase.from('site_costs').select('subcontractor_id, importo')
      .eq('site_id', siteId).eq('company_id', companyId).eq('tipo', 'acconto').not('subcontractor_id', 'is', null),
  ]);

  if (siteRes.error) throw new Error('DB_ERROR: ' + siteRes.error.message);
  if (!siteRes.data) { const e = new Error('SITE_NOT_FOUND'); e.status = 404; throw e; }

  const salRows   = salRes.data || [];
  const costRows  = (costsRes.data || []).filter(c => c.importo !== null); // un DDT senza importo non è mai "da pagare"
  const expRows   = expensesRes.data || [];

  const daIncassare = round2(salRows.filter(s => !s.pagato_il).reduce((s, r) => s + Number(r.importo_maturato || 0), 0));

  const fattureAperte = costRows.filter(c => c.tipo !== 'acconto' && !c.pagato_il);
  const speseAperte   = expRows.filter(e => !e.pagato_il);
  const daPagareDiretto = round2(
    fattureAperte.reduce((s, c) => s + Number(c.importo), 0) +
    speseAperte.reduce((s, e) => s + Number(e.amount || 0), 0)
  );

  const acconti = {};
  for (const a of (subAccontiRes.data || [])) {
    acconti[a.subcontractor_id] = (acconti[a.subcontractor_id] || 0) + Number(a.importo || 0);
  }
  const subappaltatori = (subAssignRes.data || []).map(a => {
    const budgetTotale = a.budget_totale !== null ? Number(a.budget_totale) : 0;
    const dati = acconti[a.subcontractor_id] || 0;
    return {
      subcontractor_id: a.subcontractor_id,
      company_name:     a.subcontractor?.company_name || '—',
      saldo_da_erogare: round2(budgetTotale - dati),
    };
  }).filter(s => s.saldo_da_erogare > 0);
  const daPagareSubappalti = round2(subappaltatori.reduce((s, x) => s + x.saldo_da_erogare, 0));

  const daPagare = round2(daPagareDiretto + daPagareSubappalti);

  return {
    site: { id: siteRes.data.id, name: siteRes.data.name, status: siteRes.data.status },
    da_incassare: { totale: daIncassare, sal_aperti: salRows.filter(s => !s.pagato_il).length },
    da_pagare: {
      totale: daPagare,
      fatture: round2(fattureAperte.reduce((s, c) => s + Number(c.importo), 0)),
      spese_generali: round2(speseAperte.reduce((s, e) => s + Number(e.amount || 0), 0)),
      subappalti: daPagareSubappalti,
      subappaltatori,
    },
  };
}

// ── Tutta l'azienda ─────────────────────────────────────────────────────────
async function buildCompanyEconomiaOverview(companyId) {
  const { data: sites, error: sitesErr } = await supabase
    .from('sites').select('id, name, status')
    .eq('company_id', companyId).not('status', 'in', '(chiuso,eliminato)');
  if (sitesErr) throw new Error('DB_ERROR: ' + sitesErr.message);

  const perSite = await Promise.all((sites || []).map(s => buildSiteEconomiaOverview(s.id, companyId)));

  // Spese davvero generali — mai legate a un cantiere (affitto, assicurazione,
  // o un DDT su cantiere non ancora censito, F-214) — sommate una volta sola
  // qui, non già incluse in nessun perSite (site_id IS NULL le esclude sopra).
  const { data: generali } = await supabase
    .from('company_expenses').select('amount, pagato_il')
    .eq('company_id', companyId).is('site_id', null);
  const daPagareGenerali = round2((generali || []).filter(e => !e.pagato_il).reduce((s, e) => s + Number(e.amount || 0), 0));

  const daIncassare = round2(perSite.reduce((s, x) => s + x.da_incassare.totale, 0));
  const daPagare    = round2(perSite.reduce((s, x) => s + x.da_pagare.totale, 0) + daPagareGenerali);

  const perSiteList = perSite
    .map(x => ({
      site_id: x.site.id, site_name: x.site.name,
      da_incassare: x.da_incassare.totale, da_pagare: x.da_pagare.totale,
      saldo: round2(x.da_incassare.totale - x.da_pagare.totale),
    }))
    .sort((a, b) => a.saldo - b.saldo); // peggiore (più negativo) prima

  return {
    da_incassare: { totale: daIncassare },
    da_pagare: { totale: daPagare, spese_generali: daPagareGenerali },
    cantieri: perSiteList,
  };
}

module.exports = { buildSiteEconomiaOverview, buildCompanyEconomiaOverview };
