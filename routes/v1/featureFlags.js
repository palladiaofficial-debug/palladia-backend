'use strict';
/**
 * Feature Flags — GET /api/v1/feature-flags
 *
 * Restituisce quali moduli sono abilitati per la company autenticata.
 * Logica a tre livelli (priorità decrescente):
 *   1. MASTER_COMPANY_IDS env (comma-separated) → tutti i flag ON
 *   2. company_feature_flags table (override per-company dal DB)
 *   3. Variabili d'ambiente globali FEATURE_<NAME>_DEFAULT (true/false)
 *
 * Default env vars per moduli "congelati":
 *   FEATURE_COMPUTO_DEFAULT=false   → computo nascosto ai clienti
 *   FEATURE_CAPITOLATO_DEFAULT=false → capitolato nascosto ai clienti
 *   FEATURE_DVR_DEFAULT=true
 *   FEATURE_SUBCONTRACTORS_ENTERPRISE_DEFAULT=true
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// Features supportate e i loro default da env
const FEATURES = {
  computo:                   process.env.FEATURE_COMPUTO_DEFAULT                    !== 'false',
  capitolato:                process.env.FEATURE_CAPITOLATO_DEFAULT                 !== 'false',
  dvr:                       process.env.FEATURE_DVR_DEFAULT                        !== 'false',
  subcontractors_enterprise: process.env.FEATURE_SUBCONTRACTORS_ENTERPRISE_DEFAULT  !== 'false',
};

// MASTER_COMPANY_IDS: company IDs che ottengono sempre tutti i flag ON
const MASTER_IDS = new Set(
  (process.env.MASTER_COMPANY_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// ── GET /api/v1/feature-flags ─────────────────────────────────────────────────
router.get('/feature-flags', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;

  // Se la company è nella lista master → tutti i flag ON
  if (MASTER_IDS.has(companyId)) {
    const allOn = Object.fromEntries(Object.keys(FEATURES).map(k => [k, true]));
    return res.json(allOn);
  }

  // Leggi override specifici dal DB
  const { data: rows } = await supabase
    .from('company_feature_flags')
    .select('feature, enabled')
    .eq('company_id', companyId);

  const dbOverrides = {};
  for (const row of (rows || [])) {
    dbOverrides[row.feature] = row.enabled;
  }

  // Componi risposta: DB override > env default
  const flags = {};
  for (const [feature, envDefault] of Object.entries(FEATURES)) {
    flags[feature] = feature in dbOverrides ? dbOverrides[feature] : envDefault;
  }

  res.json(flags);
});

// ── PATCH /api/v1/feature-flags/:feature — solo master company ────────────────
router.patch('/feature-flags/:feature', verifySupabaseJwt, async (req, res) => {
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
