'use strict';
const router = require('express').Router();
const { apiLimiter } = require('../../middleware/rateLimit');

// Rate limit globale su tutto /api/v1/
router.use(apiLimiter);

// Ricerca globale (JWT)
router.use('/', require('./search'));

// Route private (JWT + company membership)
router.use('/', require('./workerDocs'));
router.use('/', require('./dashboard'));
router.use('/', require('./sitesOverview'));
router.use('/', require('./siteAdmin'));
router.use('/', require('./siteSchedule'));
router.use('/', require('./siteWeather'));
router.use('/', require('./workers'));
router.use('/', require('./sessions'));
router.use('/', require('./qr'));
router.use('/', require('./presence'));
router.use('/', require('./presenceCorrections'));
router.use('/', require('./reports'));
router.use('/', require('./alerts'));
router.use('/', require('./asl'));
router.use('/', require('./auditLog'));
router.use('/', require('./qrPdf'));
router.use('/', require('./onboarding'));

// Company profile
router.use('/', require('./company'));

// Founder Mode — auto-provisioning identità per tutte le viste (JWT only)
router.use('/', require('./founder'));

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

// Checklist preparazione cantiere AI (JWT richiesto)
router.use('/', require('./siteChecklist'));

// DVR — Documento di Valutazione dei Rischi (JWT richiesto)
router.use('/', require('./dvr'));

// PIMUS — Piano di Montaggio Uso e Smontaggio Ponteggi (JWT richiesto)
router.use('/', require('./pimus'));

// Feature Flags — visibilità moduli per company (JWT richiesto)
router.use('/', require('./featureFlags'));

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

// Area Lavoratore: auth CF + profilo/timbrature/payslips/documenti (endpoint pubblici)
// DEVE stare prima di qualsiasi sub-router con router.use(verifySupabaseJwt) globale
router.use('/', require('./workerArea'));

// Fatture fornitore automatiche via SdI: webhook pubblico (autenticato via header
// segreto per-company, non JWT) + rotte azienda (JWT) per collegare/scollegare.
// DEVE stare prima di qualsiasi sub-router con router.use(verifySupabaseJwt) globale
router.use('/', require('./sdiInvoices'));

// Consultazione fatture via Delega Unificata (sola lettura, complementare a sdiInvoices):
// nessun webhook pubblico, solo rotte azienda (JWT) — vedi services/sdiConsultation.js
router.use('/', require('./sdiConsultation'));

// Documenti di sicurezza: upload/list/download (JWT) + accesso pubblico coordinatore (token)
router.use('/', require('./documents'));

// Studio CDL Partner: portale per Consulenti del Lavoro (CDL) + N imprese clienti
// NOTA: verifyStudioJwt NON usa X-Company-Id — montato PRIMA dei router con
//       router.use(verifySupabaseJwt) globale per evitare 400 MISSING_X-COMPANY-ID
router.use('/', require('./studio'));
// Documenti condivisi CDL↔impresa e cedolini (upload multer, middleware per-route)
router.use('/', require('./studioFiles'));

// Consulente RSPP: profilo (middleware per-route, safe per tutti gli utenti)
router.use('/', require('./consultantProfile'));

// Consulente RSPP: corsi, prenotazioni, Stripe Connect — guard scoped a /consultant
// (router.use('/consultant', verifyConsultantJwt) dentro ciascun file). Montati qui,
// PRIMA di qualsiasi router con router.use(verifySupabaseJwt) globale non scoped
// (companyDocuments, notifications, push, telegram, ecc. più sotto), altrimenti
// quei middleware intercettano /consultant/* per primi e rispondono 400
// MISSING_X-COMPANY-ID prima ancora di raggiungere questi router — esattamente
// lo stesso problema che verifyStudioJwt/studio.js risolve con questo stesso
// posizionamento (vedi nota sopra).
router.use('/', require('./consultantCourses'));
router.use('/', require('./consultantBookings'));
router.use('/', require('./consultantConnect'));

// Admin Formazione (super_admin only) — guard scoped a /admin, stesso motivo di sopra.
router.use('/', require('./formazioneAdmin'));

// Safety Copilot — risk score predittivo + scudo ispezione. Middleware per-route
// (verifySupabaseJwt), ma montato qui per essere raggiunto prima che qualunque
// router con guard non scoped possa intercettarlo per errore.
router.use('/', require('./safetyCopilot'));

// Preventivi corsi in cantiere (impresa + consulente, middleware per-route)
router.use('/', require('./courseQuotes'));

// Router pubblici token-based (nessun router.use(verifySupabaseJwt) globale):
// DEVONO stare PRIMA di companyDocuments/documentsHub/notifications/economia/ecc.
// più sotto, che montano router.use(verifySupabaseJwt) SENZA scoping di path —
// quel middleware intercetta e blocca (401) qualunque richiesta priva di header
// Authorization che attraversi il router, indipendentemente dal path richiesto.
// Stesso identico problema/soluzione già documentato sopra per studio/consultant/
// admin/safetyCopilot (vedi commit 81d14eb).
router.use('/', require('./coordinatorPortal'));       // Portale coordinatore unificato (Pro + CSE) — DEVE stare PRIMA di coordinator
router.use('/', require('./coordinator'));              // Coordinatore della Sicurezza CSE: inviti (JWT) + accesso pubblico (token)
router.use('/', require('./nonconformities'));          // Non Conformità: aperte da coordinatori, gestite dall'impresa (JWT + token)
router.use('/', require('./coordinatorVerifications')); // Verifiche coordinatore: registro immutabile + timeline (JWT + token)
router.use('/', require('./verbale'));                  // Verbale di Sopralluogo PDF (token — no JWT)
router.use('/', require('./formazioneProvider'));       // Portale Enti Formazione: auto-registrazione, magic link, corsi/sessioni/prenotazioni
router.use('/', require('./workerInvite'));             // Onboarding self-service lavoratore: link invito → compilazione dati → approvazione admin

// Documenti aziendali: libreria centralizzata (JWT)
router.use('/', require('./companyDocuments'));

// Hub documenti unificato: search, expiring, site summary (JWT)
router.use('/', require('./documentsHub'));

// Notifiche in-app scadenze (JWT)
router.use('/', require('./notifications'));

// Preferenze notifiche per utente: opt-out email/telegram/push (JWT)
router.use('/', require('./notificationPrefs'));

// Web Push: subscribe/unsubscribe/vapid-public-key
router.use('/', require('./push'));

// Assistente IA Pal (JWT — rate limit anti-abuso AI applicato solo su /chat/stream in chat.js)
router.use('/', require('./chat'));

// Upload file per chat Ladia (JWT — file temporanei archiviati da Ladia via tool)
router.use('/', require('./chatUpload'));

// Importazione massiva documenti da zip (JWT — SSE progresso live)
router.use('/', require('./chatBulkImport'));

// Importazione Intelligente: onboarding principale via zip/cartella, coda +
// revisione umana prima della scrittura in produzione (JWT)
router.use('/', require('./smartImport'));

// Telegram Bot: link account (JWT) + note cantiere
router.use('/', require('./telegram'));
router.use('/', require('./siteNotes'));

// Export archivio cantiere: XLSX multi-foglio (cantiere, lavoratori, presenze, subappaltatori)
router.use('/', require('./siteExport'));

// SAL — Stato Avanzamento Lavori: budget, costi, ricavi per cantiere
router.use('/', require('./economia'));

// Gestione Spese Aziendali: tracciamento uscite, ricevute, export commercialista
router.use('/', require('./expenses'));

// Computo Metrico: import PDF/Excel, parsing AI, SAL% per voce
router.use('/', require('./computo'));

// Ladia In Cantiere: attivazione, capitolato, fasi, costi
router.use('/', require('./ladiaConfig'));
router.use('/', require('./capitolato'));
router.use('/', require('./sitePhases'));
router.use('/', require('./siteCosts'));

// Prezzario regionale + prezzi fornitori azienda
router.use('/', require('./prezzario'));

// Kit Baracca: semaforo compliance + checklist + PDF kit (JWT)
router.use('/', require('./baracca'));

// Modulo Formazione: attestati, notifiche scadenze, cron check
router.use('/', require('./certificates'));

// Formazione: raccomandazioni corsi intelligenti (scadenze → corsi disponibili)
router.use('/', require('./formazioneRecommend'));

// Formazione: OCR upload attestati (richiede multer — DEVE stare prima di altri middleware body)
router.use('/', require('./certificateOcr'));

// OCR scadenze documenti (DURC, idoneità, assicurazioni) via Claude Vision
router.use('/', require('./ocrExpiry'));

// Scadenzario unificato: lavoratori, subappaltatori, azienda, cantieri
router.use('/', require('./expiryCalendar'));

// Diario di cantiere: voce giornaliera, meteo auto, presenze, PDF
router.use('/', require('./diary'));

// Buste paga: upload CDL/datore → revisione → condivisione → firma lavoratore
router.use('/', require('./payslips'));

// Marketplace corsi di formazione (provider + consulenti)
router.use('/', require('./marketplace'));

// Prenotazioni corsi + Stripe Checkout
router.use('/', require('./bookings'));

// ── Error handler v1 ─────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[v1-error]', req.method, req.path, err.message);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: 'INTERNAL', detail: err.message });
  }
});

module.exports = router;
