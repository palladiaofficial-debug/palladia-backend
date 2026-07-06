'use strict';
const supabase = require('./supabase');

/**
 * Feature flags — logica a tre livelli (priorità decrescente):
 *   1. MASTER_COMPANY_IDS env (comma-separated) → tutti i flag ON, TRANNE quelli
 *      in FROZEN_FEATURES (vedi sotto) — per quelli anche la master company
 *      passa dalla normale risoluzione DB-override/default.
 *   2. company_feature_flags table (override per-company dal DB)
 *   3. Variabili d'ambiente globali FEATURE_<NAME>_DEFAULT (true/false)
 *
 * Estratto da routes/v1/featureFlags.js per essere riusabile anche come guardia
 * server-side sugli endpoint di generazione (dvr/pimus), non solo dalla route
 * GET che il frontend legge per nascondere/mostrare i bottoni in UI.
 */

const FEATURES = {
  computo:                   process.env.FEATURE_COMPUTO_DEFAULT                    !== 'false',
  capitolato:                process.env.FEATURE_CAPITOLATO_DEFAULT                 !== 'false',
  // dvr/pimus: troppo delicati per essere generati dall'AI/offerti ai clienti in
  // questa fase — OFF di default finché non si decide di riattivarli.
  dvr:                       process.env.FEATURE_DVR_DEFAULT                        === 'true',
  pimus:                     process.env.FEATURE_PIMUS_DEFAULT                      === 'true',
  subcontractors_enterprise: process.env.FEATURE_SUBCONTRACTORS_ENTERPRISE_DEFAULT  !== 'false',
};

// Feature che restano disattivate anche per la master company — niente
// eccezioni, nemmeno per test interni, finché non si decide di riattivarle.
const FROZEN_FEATURES = new Set(['dvr', 'pimus']);

const MASTER_IDS = new Set(
  (process.env.MASTER_COMPANY_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

async function isFeatureEnabled(companyId, featureName) {
  if (!(featureName in FEATURES)) return false;
  if (MASTER_IDS.has(companyId) && !FROZEN_FEATURES.has(featureName)) return true;

  const { data } = await supabase
    .from('company_feature_flags')
    .select('enabled')
    .eq('company_id', companyId)
    .eq('feature', featureName)
    .maybeSingle();

  return data ? data.enabled : FEATURES[featureName];
}

module.exports = { FEATURES, FROZEN_FEATURES, MASTER_IDS, isFeatureEnabled };
