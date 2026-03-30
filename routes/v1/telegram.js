'use strict';
/**
 * routes/v1/telegram.js
 * API protetta da JWT per gestire il collegamento Telegram dall'interfaccia Palladia.
 *
 * POST   /api/v1/telegram/link-token   — genera token di collegamento
 * GET    /api/v1/telegram/status       — stato collegamento utente corrente
 * DELETE /api/v1/telegram/unlink       — scollega account Telegram
 * GET    /api/v1/telegram/setup        — info webhook (solo owner/admin, per debug)
 */

const router   = require('express').Router();
const crypto   = require('crypto');
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.use(verifySupabaseJwt);

// ── Genera token di collegamento ─────────────────────────────

router.post('/telegram/link-token', async (req, res) => {
  try {
    const { user, companyId } = req;

    // Invalida token precedenti non ancora usati di questo utente
    await supabase
      .from('telegram_link_tokens')
      .delete()
      .eq('user_id', user.id)
      .is('used_at', null);

    // Crea nuovo token: 12 byte hex (24 char leggibili, facile da copiare)
    const token     = crypto.randomBytes(12).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

    const { error } = await supabase.from('telegram_link_tokens').insert({
      token,
      company_id: companyId,
      user_id:    user.id,
      expires_at: expiresAt,
    });

    if (error) throw error;

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'PalladiaBot';

    res.json({
      token,
      expires_at:   expiresAt,
      bot_username: botUsername,
      instructions: `Apri Telegram, cerca @${botUsername} e invia:\n/start ${token}`,
      deep_link:    `https://t.me/${botUsername}?start=${token}`,
    });
  } catch (err) {
    console.error('[telegram/link-token]', err.message);
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Stato collegamento ───────────────────────────────────────

router.get('/telegram/status', async (req, res) => {
  try {
    const { user, companyId } = req;

    const { data: tuUser } = await supabase
      .from('telegram_users')
      .select('telegram_username, telegram_first_name, active_site_id, linked_at, last_active_at')
      .eq('user_id', user.id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!tuUser) {
      return res.json({ linked: false });
    }

    // Conta note inviate via Telegram da questo utente
    const { count } = await supabase
      .from('site_notes')
      .select('id', { count: 'exact', head: true })
      .eq('author_id', user.id)
      .eq('source', 'telegram');

    // Cantiere attivo
    let activeSite = null;
    if (tuUser.active_site_id) {
      const { data: site } = await supabase
        .from('sites')
        .select('id, site_name, name, address')
        .eq('id', tuUser.active_site_id)
        .maybeSingle();
      if (site) {
        activeSite = {
          id:   site.id,
          name: site.site_name || site.name || site.address || 'Cantiere',
        };
      }
    }

    res.json({
      linked:               true,
      telegram_username:    tuUser.telegram_username,
      telegram_first_name:  tuUser.telegram_first_name,
      linked_at:            tuUser.linked_at,
      last_active_at:       tuUser.last_active_at,
      active_site:          activeSite,
      notes_sent:           count || 0,
    });
  } catch (err) {
    console.error('[telegram/status]', err.message);
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Scollega account ─────────────────────────────────────────

router.delete('/telegram/unlink', async (req, res) => {
  try {
    const { user, companyId } = req;

    const { error } = await supabase
      .from('telegram_users')
      .delete()
      .eq('user_id', user.id)
      .eq('company_id', companyId);

    if (error) throw error;

    res.json({ unlinked: true });
  } catch (err) {
    console.error('[telegram/unlink]', err.message);
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Invia notifica via Telegram ───────────────────────────────

/**
 * POST /api/v1/telegram/notify
 * Body: { message: string, site_id?: string }
 * Invia un messaggio personalizzato a tutti gli utenti collegati della company.
 * Solo owner/admin possono usarlo.
 */
router.post('/telegram/notify', async (req, res) => {
  try {
    const { userRole, companyId } = req;
    if (!['owner', 'admin', 'tech'].includes(userRole)) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length < 3) {
      return res.status(400).json({ error: 'INVALID_MESSAGE' });
    }

    const { notifyCompany } = require('../../services/telegramNotifications');
    const result = await notifyCompany(companyId, message.slice(0, 2000));

    res.json(result);
  } catch (err) {
    console.error('[telegram/notify]', err.message);
    res.status(500).json({ error: 'INTERNAL', detail: err.message });
  }
});

// ── Webhook info (debug, solo owner/admin) ───────────────────

router.get('/telegram/setup', async (req, res) => {
  try {
    const { userRole } = req;
    if (!['owner', 'admin', 'tech'].includes(userRole)) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return res.json({
        configured:    false,
        message:       'TELEGRAM_BOT_TOKEN non configurato su Railway.',
        required_envs: [
          'TELEGRAM_BOT_TOKEN',
          'TELEGRAM_WEBHOOK_SECRET',
          'TELEGRAM_BOT_USERNAME',
        ],
      });
    }

    const { getWebhookInfo } = require('../../services/telegram');
    const info = await getWebhookInfo();

    res.json({
      configured:         true,
      webhook_url:        info.url || null,
      pending_updates:    info.pending_update_count || 0,
      last_error:         info.last_error_message   || null,
      expected_webhook:   `${process.env.APP_BASE_URL || ''}/api/telegram/webhook`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
