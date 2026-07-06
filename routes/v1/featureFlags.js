'use strict';
/**
 * Feature Flags — GET /api/v1/feature-flags
 *
 * Restituisce quali moduli sono abilitati per la company autenticata.
 * Logica a tre livelli — vedi lib/featureFlags.js per i dettagli:
 *   1. MASTER_COMPANY_IDS env (comma-separated) → tutti i flag ON, TRANNE le
 *      feature in FROZEN_FEATURES (dvr/pimus) — quelle passano comunque dal
 *      punto 2/3, nessuna eccezione automatica nemmeno per i test interni.
 *   2. company_feature_flags table (override per-company dal DB)
 *   3. Variabili d'ambiente globali FEATURE_<NAME>_DEFAULT (true/false)
 *
 * Default env vars per moduli "congelati":
 *   FEATURE_COMPUTO_DEFAULT=false    → computo nascosto ai clienti
 *   FEATURE_CAPITOLATO_DEFAULT=false → capitolato nascosto ai clienti
 *   FEATURE_DVR_DEFAULT=true         → riattiva la generazione DVR (default: off)
 *   FEATURE_PIMUS_DEFAULT=true       → riattiva la generazione PIMUS (default: off)
 *   FEATURE_SUBCONTRACTORS_ENTERPRISE_DEFAULT=true
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { patchFeatureFlagSchema } = require('../../lib/schemas/featureFlags');
const { FEATURES, FROZEN_FEATURES, MASTER_IDS } = require('../../lib/featureFlags');

// ── GET /api/v1/feature-flags ─────────────────────────────────────────────────
router.get('/feature-flags', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;
  const isMaster  = MASTER_IDS.has(companyId);

  // Leggi override specifici dal DB
  const { data: rows } = await supabase
    .from('company_feature_flags')
    .select('feature, enabled')
    .eq('company_id', companyId);

  const dbOverrides = {};
  for (const row of (rows || [])) {
    dbOverrides[row.feature] = row.enabled;
  }

  // Componi risposta: master company → ON per tutto TRANNE le feature "frozen"
  // (vedi lib/featureFlags.js — dvr/pimus restano disattivate anche per i test
  // interni); per tutti gli altri, DB override > default env.
  const flags = {};
  for (const [feature, envDefault] of Object.entries(FEATURES)) {
    if (isMaster && !FROZEN_FEATURES.has(feature)) {
      flags[feature] = true;
    } else {
      flags[feature] = feature in dbOverrides ? dbOverrides[feature] : envDefault;
    }
  }

  res.json(flags);
});

// ── PATCH /api/v1/feature-flags/:feature — solo master company ────────────────
router.patch('/feature-flags/:feature', verifySupabaseJwt, validate(patchFeatureFlagSchema), async (req, res) => {
  if (!MASTER_IDS.has(req.companyId))
    return res.status(403).json({ error: 'FORBIDDEN' });

  const { feature } = req.params;
  if (!(feature in FEATURES))
    return res.status(400).json({ error: 'UNKNOWN_FEATURE', known: Object.keys(FEATURES) });

  const { company_id: targetCompanyId, enabled } = req.body;
  if (typeof enabled !== 'boolean')
    return res.status(400).json({ error: 'ENABLED_MUST_BE_BOOLEAN' });

  const companyId = targetCompanyId || req.companyId;

  const { error } = await supabase
    .from('company_feature_flags')
    .upsert({ company_id: companyId, feature, enabled, updated_by: req.user?.id },
             { onConflict: 'company_id,feature' });

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ ok: true, company_id: companyId, feature, enabled });
});

module.exports = router;
