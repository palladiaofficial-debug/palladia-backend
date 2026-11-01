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
const { FEATURES, MASTER_IDS, flagsPer } = require('../../lib/featureFlags');
const { sendDbError } = require('../../lib/httpErrors');

// ── GET /api/v1/feature-flags ─────────────────────────────────────────────────
router.get('/feature-flags', verifySupabaseJwt, async (req, res) => {
  // Riga per azienda > default env; master company tutto ON tranne i congelati;
  // F-418 «essenziale» spegne lavagna/da_pagare/conti_sub (lib/featureFlags.flagsPer)
  res.json(await flagsPer(req.companyId));
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

  if (error) return sendDbError(res, error);
  res.json({ ok: true, company_id: companyId, feature, enabled });
});

module.exports = router;
