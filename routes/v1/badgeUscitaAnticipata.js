'use strict';
// ── Uscita prima del solito: "Perché?" (F-318, AUDIT.md del frontend) ────────
// GET  /api/v1/badge/:code/uscita-anticipata          → { ask, uscita, uscita_solita }
// POST /api/v1/badge/:code/uscita-anticipata { motivo } → salva la risposta
// Stessa autenticazione del "Timbra" del badge (codice badge) e solo
// sull'ultima timbratura, se è un'uscita di meno di 30 minuti fa.
// File separato da badgePunch.js di proposito: la timbratura resta intoccata.
const router = require('express').Router();
const { badgeUscitaLimiter } = require('../../middleware/rateLimit');
const { domanda, rispondi } = require('../../lib/uscitaAnticipata');
const { notifyIncidente } = require('../../services/telegramNotifications');

const BADGE_RE = /^[A-Fa-f0-9]{18}$/;

router.get('/badge/:code/uscita-anticipata', badgeUscitaLimiter, async (req, res) => {
  if (!BADGE_RE.test(req.params.code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  try {
    const r = await domanda(req.params.code);
    if (r.error) return res.status(r.status).json({ error: r.error, ask: false });
    res.json(r);
  } catch (err) {
    console.error('[uscita-anticipata] GET:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', ask: false });
  }
});

router.post('/badge/:code/uscita-anticipata', badgeUscitaLimiter, async (req, res) => {
  if (!BADGE_RE.test(req.params.code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  try {
    const r = await rispondi(req.params.code, req.body?.motivo, {
      notify: ({ companyId, siteId, siteName, workerName, ora }) =>
        notifyIncidente(companyId, siteId, siteName, `Infortunio: ${workerName} ha indicato "Mi sono fatto male" uscendo alle ${ora}. Chiamalo subito.`, workerName),
    });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (err) {
    console.error('[uscita-anticipata] POST:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
