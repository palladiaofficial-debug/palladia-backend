'use strict';
const router = require('express').Router();
const { apiLimiter, chatLimiter } = require('../../middleware/rateLimit');

// Rate limit globale su tutto /api/v1/
router.use(apiLimiter);

// Route private (JWT + company membership)
router.use('/', require('./workerDocs'));
router.use('/', require('./dashboard'));
router.use('/', require('./sitesOverview'));
router.use('/', require('./siteAdmin'));
router.use('/', require('./workers'));
router.use('/', require('./sessions'));
router.use('/', require('./qr'));
router.use('/', require('./presence'));
router.use('/', require('./reports'));
router.use('/', require('./alerts'));
router.use('/', require('./asl'));
router.use('/', require('./auditLog'));
router.use('/', require('./qrPdf'));
router.use('/', require('./onboarding'));

// Company profile
router.use('/', require('./company'));

// Subappaltatori: CRUD completo (JWT richiesto)
router.use('/', require('./subcontractors'));

// Mezzi & Attrezzature: CRUD completo (JWT richiesto)
router.use('/', require('./equipment'));

// Team invites
router.use('/', require('./invites'));

// Billing / abbonamenti (JWT richiesto)
router.use('/', require('./billing'));

// POS — lista documenti azienda (JWT richiesto)
router.use('/', require('./pos'));

// Portale Professionisti (CSE/CSP/DL/RUP) — accesso pubblico via magic link
router.use('/', require('./coordinatorPro'));

// Badge digitale: verifica pubblica (no JWT) + PDF privato (JWT)
router.use('/', require('./badge'));

// Route pubbliche scan badge (no JWT — session token o signed QR link)
// DEVE stare prima di qualsiasi sub-router con router.use(verifySupabaseJwt) globale
router.use('/', require('./scan'));

// Badge Punch: timbratura via badge personale lavoratore (endpoint pubblici)
// DEVE stare prima di qualsiasi sub-router con router.use(verifySupabaseJwt) globale
router.use('/', require('./badgePunch'));

// Documenti di sicurezza: upload/list/download (JWT) + accesso pubblico coordinatore (token)
router.use('/', require('./documents'));

// Documenti aziendali: libreria centralizzata (JWT)
router.use('/', require('./companyDocuments'));

// Portale coordinatore unificato (Pro + CSE) — DEVE stare PRIMA di coordinator
router.use('/', require('./coordinatorPortal'));

// Coordinatore della Sicurezza CSE: inviti (JWT) + accesso pubblico (token)
router.use('/', require('./coordinator'));

// Non Conformità: aperte da coordinatori, gestite dall'impresa (JWT + token)
router.use('/', require('./nonconformities'));

// Verifiche coordinatore: registro immutabile + timeline (JWT + token)
router.use('/', require('./coordinatorVerifications'));

// Verbale di Sopralluogo PDF (token — no JWT)
router.use('/', require('./verbale'));

// Assistente IA Pal (JWT + rate limit dedicato anti-abuso costi AI)
router.use('/chat', chatLimiter);
router.use('/', require('./chat'));

// Telegram Bot: link account (JWT) + note cantiere
router.use('/', require('./telegram'));
router.use('/', require('./siteNotes'));

// SAL — Stato Avanzamento Lavori: budget, costi, ricavi per cantiere
router.use('/', require('./economia'));

// Computo Metrico: import PDF/Excel, parsing AI, SAL% per voce
router.use('/', require('./computo'));

// Ladia In Cantiere: attivazione, capitolato, fasi, costi
router.use('/', require('./ladiaConfig'));
router.use('/', require('./capitolato'));
router.use('/', require('./sitePhases'));
router.use('/', require('./siteCosts'));

// Prezzario regionale + prezzi fornitori azienda
router.use('/', require('./prezzario'));


// ── Error handler v1 ─────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[v1-error]', req.method, req.path, err.message);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: 'INTERNAL', detail: err.message });
  }
});

module.exports = router;
