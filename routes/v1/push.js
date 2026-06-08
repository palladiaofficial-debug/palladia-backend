'use strict';
/**
 * routes/v1/push.js
 *
 * GET    /api/v1/push/vapid-public-key  — chiave pubblica VAPID (no auth)
 * POST   /api/v1/push/subscribe         — salva subscription (JWT)
 * DELETE /api/v1/push/unsubscribe       — rimuovi subscription (JWT)
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// Pubblica — serve al browser prima ancora del login per capire se push è disponibile
router.get('/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'PUSH_NOT_CONFIGURED' });
  res.json({ vapidPublicKey: key });
});

router.use(verifySupabaseJwt);

// Salva o aggiorna la subscription del dispositivo corrente
router.post('/push/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });
  }

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      company_id: req.companyId,
      user_id:    req.user.id,
      endpoint,
      p256dh:     keys.p256dh,
      auth:       keys.auth,
      user_agent: (req.headers['user-agent'] || '').slice(0, 300) || null,
    },
    { onConflict: 'endpoint' }
  );

  if (error) {
    console.error('[push] subscribe error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  res.json({ ok: true });
});

// Rimuovi la subscription (utente disattiva notifiche o si disconnette)
router.delete('/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'MISSING_ENDPOINT' });

  await supabase.from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
    .eq('user_id', req.user.id)
    .catch(() => {});

  res.json({ ok: true });
});

// Test push — invia una notifica di test all'utente corrente (owner/admin only)
router.post('/push/test', async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  try {
    const { sendPushToUser } = require('../../services/pushNotifications');
    await sendPushToUser(req.user.id, {
      title: 'Notifiche attive',
      body:  'Palladia è configurato per avvisarti in tempo reale — scadenze, presenze e cantieri.',
      tag:   'test',
      url:   '/settings',
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
