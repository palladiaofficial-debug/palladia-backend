'use strict';
/**
 * routes/v1/notificationPrefs.js
 * Preferenze notifiche per utente — opt-out per canale (email, telegram, push).
 *
 * GET  /api/v1/notification-preferences          — leggi le tue preferenze
 * PUT  /api/v1/notification-preferences          — aggiorna preferenze
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.use(verifySupabaseJwt);

// ── GET: leggi preferenze correnti ─────────────────────────────────────────
router.get('/notification-preferences', async (req, res) => {
  try {
    const { user, companyId } = req;

    const { data, error } = await supabase
      .from('notification_preferences')
      .select('email_enabled, telegram_enabled, push_enabled, updated_at')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) throw error;

    res.json({
      email_enabled:    data?.email_enabled    ?? true,
      telegram_enabled: data?.telegram_enabled ?? true,
      push_enabled:     data?.push_enabled     ?? true,
      updated_at:       data?.updated_at       ?? null,
    });
  } catch (err) {
    console.error('[notificationPrefs] GET error:', err.message);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// ── PUT: aggiorna preferenze ───────────────────────────────────────────────
router.put('/notification-preferences', async (req, res) => {
  try {
    const { user, companyId } = req;
    const { email_enabled, telegram_enabled, push_enabled } = req.body;

    if (
      typeof email_enabled    !== 'boolean' &&
      typeof telegram_enabled !== 'boolean' &&
      typeof push_enabled     !== 'boolean'
    ) {
      return res.status(400).json({
        error: 'VALIDATION',
        detail: 'Almeno un campo boolean richiesto: email_enabled, telegram_enabled, push_enabled',
      });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (typeof email_enabled    === 'boolean') updates.email_enabled    = email_enabled;
    if (typeof telegram_enabled === 'boolean') updates.telegram_enabled = telegram_enabled;
    if (typeof push_enabled     === 'boolean') updates.push_enabled     = push_enabled;

    const { data, error } = await supabase
      .from('notification_preferences')
      .upsert({
        company_id: companyId,
        user_id:    user.id,
        ...updates,
      }, { onConflict: 'company_id,user_id' })
      .select('email_enabled, telegram_enabled, push_enabled, updated_at')
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('[notificationPrefs] PUT error:', err.message);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
