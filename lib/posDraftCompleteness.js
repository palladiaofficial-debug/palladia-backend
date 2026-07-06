'use strict';

// Cosa si intende per "POS ragionevolmente completo" — euristica di prodotto,
// non un vincolo DB (pos_drafts non ha NOT NULL oltre a id/company_id/site_id,
// per non rompere bozze parziali). Usata da get_pos_draft per dare a Ladia una
// base su cui segnalare cosa manca, ai checkpoint (non ad ogni turno).

function getMissingFields(draft) {
  const missing = {};

  const datiGenerali = [];
  if (!draft.site_address)  datiGenerali.push('indirizzo cantiere');
  if (!draft.client_name)   datiGenerali.push('committente');
  if (!draft.start_date || !draft.end_date) datiGenerali.push('date inizio/fine lavori');
  if (datiGenerali.length) missing.dati_generali = datiGenerali;

  const figureSicurezza = [];
  if (!draft.cse)      figureSicurezza.push('CSE');
  if (!draft.rspp)     figureSicurezza.push('RSPP');
  if (!draft.preposto) figureSicurezza.push('preposto di cantiere');
  if (figureSicurezza.length) missing.figure_sicurezza = figureSicurezza;

  if (!Array.isArray(draft.selected_works) || draft.selected_works.length === 0) {
    missing.lavorazioni = ['nessuna lavorazione selezionata'];
  }

  if (!draft.risks_content) {
    missing.rischi = ['sezione rischi non ancora generata'];
  }

  return missing;
}

module.exports = { getMissingFields };
