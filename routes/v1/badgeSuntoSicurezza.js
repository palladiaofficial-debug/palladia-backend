'use strict';
// ── Sunto del POS dopo l'entrata dal badge (F-340, AUDIT.md del frontend) ────
// GET  /api/v1/badge/:code/sunto-sicurezza?lingua=it  → { show, pos_id, schede, testi }
// POST /api/v1/badge/:code/sunto-sicurezza { pos_id, lingua, schede, secondi } → HO CAPITO
// Stessa autenticazione del "Timbra" del badge (codice badge), solo dopo
// un'entrata. File separato da badgePunch.js di proposito: la timbratura
// resta intoccata; se qui qualcosa fallisce, il badge non mostra il sunto.
const router = require('express').Router();
const { badgeUscitaLimiter } = require('../../middleware/rateLimit');
const { sunto, accetta } = require('../../lib/suntoSicurezza');

const BADGE_RE = /^[A-Fa-f0-9]{18}$/;

router.get('/badge/:code/sunto-sicurezza', badgeUscitaLimiter, async (req, res) => {
  if (!BADGE_RE.test(req.params.code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE', show: false });
  try {
    const r = await sunto(req.params.code, String(req.query.lingua || 'it'));
    if (r.error) return res.status(r.status).json({ error: r.error, show: false });
    res.json(r);
  } catch (err) {
    console.error('[sunto-sicurezza] GET:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', show: false });
  }
});

router.post('/badge/:code/sunto-sicurezza', badgeUscitaLimiter, async (req, res) => {
  if (!BADGE_RE.test(req.params.code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  try {
    const r = await accetta(req.params.code, req.body, { ip: req.ip, ua: req.get('user-agent') });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (err) {
    console.error('[sunto-sicurezza] POST:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
