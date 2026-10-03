'use strict';
// ── Iscrizione alle notifiche push dell'operaio (F-267, AUDIT.md del frontend)
// Il badge (public/badge-punch.html) chiede il permesso per le notifiche dopo
// una timbratura; prima salvava l'iscrizione su POST /push/subscribe, che
// richiede il login dell'app → 401 in silenzio, nessun operaio mai iscritto.
// Qui l'identità è il badge_code, come per la timbratura. Le iscrizioni vanno
// in worker_push_subscriptions (migrazione 234), separata da push_subscriptions:
// gli avvisi dell'ufficio non devono arrivare agli operai.
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { badgePunchLimiter } = require('../../middleware/rateLimit');
const { BADGE_CODE_RE } = require('../../lib/workerByBadge');

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

router.post('/badge/:code/push-subscribe', badgePunchLimiter, async (req, res) => {
  try {
    const { code } = req.params;
    if (!BADGE_CODE_RE.test(code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
    const { endpoint, keys } = req.body || {};
    if (!str(endpoint, 1000) || !endpoint.startsWith('https://') || !str(keys?.p256dh, 500) || !str(keys?.auth, 200)) {
      return res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });
    }

    const { data: worker, error } = await supabase.from('workers')
      .select('id, company_id, is_active').eq('badge_code', code.toUpperCase()).maybeSingle();
    if (error) return res.status(500).json({ error: 'DB_ERROR' });
    if (!worker) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
    if (!worker.is_active) return res.status(403).json({ error: 'BADGE_REVOKED' });

    // Un telefono = un'iscrizione: se lo stesso telefono passa a un altro
    // operaio (telefono condiviso), l'iscrizione si sposta su di lui.
    const { error: upErr } = await supabase.from('worker_push_subscriptions').upsert({
      company_id: worker.company_id,
      worker_id:  worker.id,
      endpoint,
      p256dh:     keys.p256dh,
      auth:       keys.auth,
      user_agent: (req.headers['user-agent'] || '').slice(0, 300) || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
    if (upErr) {
      console.error('[worker-push] subscribe error:', upErr.message);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[worker-push] unexpected error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
