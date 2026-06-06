'use strict';
/**
 * routes/v1/founder.js
 * Founder Mode — auto-provisioning identità per tutte le viste dell'app.
 *
 * POST /api/v1/founder/ensure-identities
 *   Crea (idempotente) i record necessari per navigare ogni sezione:
 *   - studio_partners + studio_users     → vista Studio CDL (/studio)
 *   - consultant_profiles                → vista Consulente (/consulente)
 *   - training_providers + session token → portale Provider (/formazione/provider/accesso/:token)
 *
 * Richiede FOUNDER_USER_IDS env con l'UUID dell'utente Supabase del fondatore.
 * JWT-only (no X-Company-Id).
 */

const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { isFounder } = require('../../lib/founder');

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

async function resolveUser(req, res) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  const { data, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !data?.user) {
    res.status(401).json({ error: 'INVALID_TOKEN' });
    return null;
  }
  return data.user;
}

// POST /api/v1/founder/ensure-identities
router.post('/founder/ensure-identities', async (req, res) => {
  const user = await resolveUser(req, res);
  if (!user) return;

  if (!isFounder(user.id)) {
    return res.status(403).json({ error: 'NOT_FOUNDER' });
  }

  const result = {};

  // 1. Studio CDL ─────────────────────────────────────────────────────────────
  const { data: studio, error: studioErr } = await supabase
    .from('studio_partners')
    .upsert({
      user_id:              user.id,
      studio_name:          'Studio CDL — Founder Preview',
      operative_regions:    [],
      onboarding_completed: true,
    }, { onConflict: 'user_id' })
    .select('id')
    .single();

  if (!studioErr && studio) {
    await supabase.from('studio_users').upsert({
      studio_id: studio.id,
      user_id:   user.id,
      role:      'owner',
      joined_at: new Date().toISOString(),
    }, { onConflict: 'studio_id,user_id' });
    result.studio_id = studio.id;
  }

  // 2. Consulente RSPP ────────────────────────────────────────────────────────
  const { error: consultErr } = await supabase
    .from('consultant_profiles')
    .upsert({
      user_id:              user.id,
      company_name:         'RSPP — Founder Preview',
      operative_regions:    [],
      onboarding_completed: true,
    }, { onConflict: 'user_id' });

  if (!consultErr) result.consultant_id = user.id;

  // 3. Provider Formazione ────────────────────────────────────────────────────
  let { data: provider } = await supabase
    .from('training_providers')
    .select('id')
    .eq('email', user.email)
    .maybeSingle();

  if (!provider) {
    const { data: created } = await supabase
      .from('training_providers')
      .insert({
        name:              'Provider Demo — Founder',
        email:             user.email,
        location_city:     'Milano',
        location_province: 'MI',
        is_active:         true,
        is_featured:       false,
        commission_rate:   0,
      })
      .select('id')
      .single();
    provider = created;
  } else {
    // Assicura che sia attivo
    await supabase.from('training_providers').update({ is_active: true }).eq('id', provider.id);
  }

  if (provider) {
    result.provider_id = provider.id;
    // Genera sempre un token fresco a lunga durata (365 gg)
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
    const { error: tokenErr } = await supabase
      .from('training_provider_sessions')
      .insert({
        provider_id: provider.id,
        email:       user.email,
        token_hash:  hashToken(token),
        expires_at:  expiresAt,
      });
    if (!tokenErr) result.provider_token = token;
  }

  res.json(result);
});

module.exports = router;
