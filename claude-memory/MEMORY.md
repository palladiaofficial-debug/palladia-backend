# Palladia Backend — Memory

## Architettura PDF
- **Stack**: Express + Puppeteer (Chromium headless) — NO pdf-lib
- **Entry**: `server.js` → `pos-html-generator.js` → `pdf-renderer.js`
- **Rendering**: `rendererPool` (browser condiviso in produzione), `renderHtmlToPdf` (browser monouso)

## REGOLA FISSA — NON MODIFICARE MAI
Il seguente setup H/F Puppeteer è definitivo e risolve il problema di overlay.
NON cambiare questi valori in nessuna circostanza:
- Puppeteer `margin: { top:'26mm', bottom:'24mm', left:'0mm', right:'0mm' }`
- CSS `@page { size: A4; margin: 26mm 0 24mm 0; }` — DEVE coincidere con Puppeteer
- Cover `height: 247mm !important; overflow: hidden !important;` (247 = 297-26-24)
- NO `preferCSSPageSize: true` — rimosso perché confligge con il setup
- NO `@page { margin: 0 }` — era il bug root cause: Chrome layout da y=0 ma Puppeteer
  metteva il contenuto a y=22mm → il header copriva i primi 22mm di ogni pagina

## Architettura H/F PDF (v13 — definitiva, Puppeteer nativo)
- **displayHeaderFooter: true** — Chrome riserva fisicamente le bande verticali, overlay impossibile
- **margin: { top:'26mm', bottom:'24mm', left:'0mm', right:'0mm' }** — Chrome gestisce top/bottom
- **`.doc { padding: 0 16mm }`** — SOLO margini laterali nel DOM; nessun margine verticale DOM
- **CRITICO**: `@page { margin: 26mm 0 24mm 0 }` nel CSS DEVE corrispondere esattamente ai margini Puppeteer.
  Se `@page { margin: 0 }` Chrome fa il layout su 297mm/pag e i primi 26mm di ogni pagina vengono coperti dall'header (BUG).
  Se corrispondono, Chrome fa il layout su 247mm/pag (297-26-24) → zero overlap garantito.
- **Breathing room**: top=26mm → gap header-contenuto 16mm (era 12mm); bottom=24mm → gap contenuto-footer 15mm (era 11mm)
- **Header template** (`buildHeaderTemplate`): `height:10mm`, `padding:0 16mm`, `font-size:0` container, span espliciti `9px`
- **Footer template** (`buildFooterTemplate`): `height:9mm`, `padding:0 16mm`, `8.5px` font, `<span class="pageNumber">/<span class="totalPages">` iniettati da Chrome
- **Numerazione**: Chrome-nativo — zero 2-pass, zero stima scrollHeight, zero pdf-lib
- **Struttura HTML**: `<body> → <div class="doc"> → cover + content` (NO `.print-header`/`.print-footer` DOM)
- **NOTA**: `position:fixed` nel DOM causa overlay dopo page-break reali → NON usarlo per H/F

## File chiave
- `pos-html-generator.js` — CSS (`buildCss()`) + template HTML (`generatePosHtml()`)
- `pdf-renderer.js` — opzioni Puppeteer (`makePdfOpts()`), header/footer template, PDF_DEBUG flag
- `server.js` — routing Express, endpoint SSE `/api/generate-pos-template-stream`, diagnostica `/api/pdf-diag`

## CSS Note
- Tabelle: `table-layout:fixed`, `width:100%`, `th,td { overflow-wrap:anywhere; word-break:break-word }`
- Header/footer Puppeteer: `padding:0 16mm` — allineati alla griglia `.doc { padding:0 16mm }`
- `pageNumber`/`totalPages`: iniettati da Chrome — ogni span DEVE avere `font-size` esplicito in `px`
- `@page { size:A4; margin:26mm 0 24mm 0 }` — DEVE corrispondere a Puppeteer margin (non 0!)
- **Cover v13**: `height: 247mm !important; overflow: hidden !important;` — garantisce che background scuro non sfori nel footer; `247mm = 297-26-24`
- `table.allow-break tr { break-inside: auto !important; }` — righe di tabelle AI possono spezzarsi
- `.lav-header { break-after: avoid-page !important; }` — nel blocco finale con !important

## Debug
- `PDF_DEBUG=true` env var → `_debugOverflow()` logga elementi con overflow `[W]` orizzontale o `[V]` verticale
- Verticale: safe area `[98px top, 1025px bottom]` (26mm/24mm a 96dpi)
- Max 10 righe log per selector, raggruppate — nessun spam Railway
- Default: `false`

## Stripe Billing — Implementato (2026-03-18, aggiornato piani 2026-03-20)
- **Modello**: free trial 14gg → paywall → Stripe Checkout → webhook attiva abbonamento
- **Piani attivi**: Starter €29 (max 2 cantieri), Grow €59 (max 6), Pro €99 (max 15), Enterprise (illimitati)
- **Limite cantieri**: enforcement in `POST /api/v1/sites` — conta cantieri con status != 'chiuso'; 403 SITE_LIMIT_REACHED se al limite
- **Migration 009**: colonne `stripe_customer_id`, `stripe_subscription_id`, `subscription_status` (trial/active/past_due/canceled), `subscription_plan`, `trial_ends_at` (default +14gg), `subscription_current_period_end`
- **Migration 010**: migra `subscription_plan = 'base'` → `'starter'`, aggiorna default colonna
- **Backend**: `services/stripe.js` (lazy Stripe SDK, `PLAN_LIMITS`, `getSiteLimit()`), `routes/v1/billing.js` (GET /status → include `site_limit`, POST /checkout → starter|grow|pro, POST /portal), webhook `server.js`
- **Frontend**: `BillingContext.tsx` (stato abbonamento + cache 5min), `Paywall.tsx`, `BillingSuccess.tsx`, `TrialBanner.tsx` (≤7gg), `ProtectedRoute.tsx` (redirect /paywall se scaduto), `App.tsx` con `BillingProvider`, `Account.tsx`
- **ENV Railway**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER` (€29), `STRIPE_PRICE_GROW` (€59), `STRIPE_PRICE_PRO` (€99)
- **Backward compat**: `STRIPE_PRICE_BASE` usato come fallback per STARTER; piano 'base' nel DB = 2 cantieri
- **Webhook endpoint**: `https://palladia-backend-production.up.railway.app/api/webhooks/stripe`

## POS Data Fix (2026-03-20)
- Vedere `project_pos_fixes_2026_03_20.md` per dettagli completi
- `mapFormToBackend` ora passa tutti i campi (direttoreTecnico, preposto, orario lavoro, cfCommittente, tipoAppalto)
- `formatBudget()` aggiunta in pos-html-generator.js e pos-template.js
- Sezione 2.3 PDF usa dati reali (non hardcoded)
- UI generazione: schermata pulita "L'IA sta componendo il tuo POS" (no streaming text)
- importoLavori: type="text" con formato IT (virgola/punto ammessi)

## Stato fix pre-lancio — TUTTO COMPLETATO (2026-03-18)
- **Bug PDF overlay (3 problemi, screenshot 2026-02-26)**: risolti in v13 — `@page { margin: 26mm 0 24mm 0 }` combacia con Puppeteer; cover `height:247mm; overflow:hidden`; no `@page :first`. Verificato analisi codice + smoke test OK.

## Stato fix pre-lancio (2026-03-12)
- **Dashboard.tsx**: riscritta completamente — usa `GET /api/v1/dashboard` (nuovo endpoint backend)
- **Index.tsx (Cantieri)**: carica lista reale da `GET /api/v1/sites` + spinner
- **SiteDetail.tsx**: riscritta — sito reale da Supabase, presenze da `/api/v1/presence`, lavoratori da `/api/v1/workers?siteId`, storico con date picker, lazy loading tab
- **Risorse.tsx**: lavoratori reali da `GET /api/v1/workers`; subappaltatori/mezzi restano placeholder
- **AddWorkerModal.tsx**: rewrite — carica DB reale, crea via POST /api/v1/workers, assegna a cantiere via POST /api/v1/sites/:siteId/workers
- **NewSiteModal.tsx**: refresh token automatico, errori specifici
- **Backend dashboard.js**: nuovo endpoint `GET /api/v1/dashboard` — KPI + presenze oggi in 1 call

## Security Audit v2 (2026-03-12) — Completato
- **Task 1** append-only: già OK — trigger DB-level PostgreSQL, survives service_role
- **Task 2** bcrypt PIN: `lib/pinHash.js` → bcryptjs async; `scan.js` isPinValid() async + await; `siteAdmin.js` await hashPin; `scripts/set-site-pin.js` await hashPin; `migrations/008_bcrypt_pin_cleanup.sql` DROP pin_code
- **Task 3** scan hardening: già OK
- **Task 4** company_id from DB: già OK
- **Task 5** session security: max 2 sessioni (revoca oldest) in identify; `POST /scan/logout-device` aggiunto in scan.js
- **Task 6** presence report alias: `GET /api/v1/worksites/:id/presence-report?format=pdf|csv&from=&to=` in reports.js
- **Task 7** selftest: Test 10 aggiunto (logout-device: 200/401/400)
- **PIN_SIGNING_SECRET**: non più usato dopo Task 2 — la variabile ENV può rimanere ma è ignorata

## Implementazioni v2 (2026-03-09) — sistema completo
- **Migration 006**: `migrations/006_asl_audit.sql` — tabelle `asl_access_tokens` + `admin_audit_log` (append-only trigger)
- **lib/audit.js**: helper `auditLog()` — non blocca mai l'operazione chiamante
- **routes/v1/sessions.js**: `GET /api/v1/workers/:workerId/sessions` + `DELETE /api/v1/sessions/:sessionId` — revoca sessione se operaio perde telefono
- **routes/v1/asl.js**: link ASL temporanei → `POST /api/v1/sites/:siteId/asl-token`, `GET/DELETE /api/v1/asl-tokens/:id`, `GET /api/v1/asl/:token?format=pdf|csv|info`
- **routes/v1/alerts.js**: `GET/POST /api/v1/alerts/missing-exits` — controlla ENTRY senza EXIT, invia email admin
- **routes/v1/auditLog.js**: `GET /api/v1/audit-log` — visibile solo owner/admin
- **public/asl.html**: pagina pubblica per ispettori ASL — mostra info, scarica PDF/CSV
- **public/scan.html**: verifica firma QR HMAC al boot (`?t=&exp=`) via `/api/v1/scan/verify-qr`
- **routes/v1/scan.js**: `GET /api/v1/scan/verify-qr` — endpoint pubblico verifica firma QR
- **routes/v1/qr.js**: URL QR ora `/scan/<siteId>?t=<hmac>&exp=<unix>` (path + query params)
- **routes/v1/reports.js**: aggiunto `GET /api/v1/reports/presence-range?siteId=&from=&to=` — CSV annuale senza limite 90gg, fino a 200k righe raw
- **services/email.js**: aggiunto `sendMissingExitAlert()` — email admin con tabella uscite mancanti per cantiere
- **Audit logging**: workers.js (create, assign_site), siteAdmin.js (coords_set, pin_set/removed)
- **ENV nuove**: `ASL_TOKEN_TTL_DAYS` (default 30), `APP_BASE_URL` (usato per URL QR e ASL)

## Smoke test
- `GET /api/pdf-smoke` → genera PDF reale con 30 lavoratori + tabelle rischi AI

## Badge Digitale — Architettura v2 (multi-tenant completa)
- **Middleware auth**: `middleware/verifyJwt.js` — verifica JWT + membership reale su `company_users` → 403 se non membro
- **Rate limit**: `middleware/rateLimit.js` — `scanLimiter` (20/min), `apiLimiter` (120/min)
- **QR signing**: `routes/v1/qr.js` — HMAC-SHA256(`QR_SIGNING_SECRET`, `${siteId}.${exp}`), TTL 7gg
- **Routes v1**: index.js monta workers.js, qr.js, presence.js, reports.js, scan.js
- **Scan badge** (routes/v1/scan.js): 3 endpoint pubblici
  - `GET /api/v1/scan/worksites/:worksiteId` — info cantiere (no company_id, no pin)
  - `POST /api/v1/scan/identify` — CF → session token (32 bytes, hash SHA-256 salvato)
  - `POST /api/v1/scan/punch` — session token → ENTRY/EXIT server-side + geofence haversine
- **company_id**: derivato sempre dal cantiere nel DB, MAI dal client (scan endpoints)
- **Event_type server-side**: ultimo log → ENTRY→EXIT o →ENTRY (mai da client)
- **Geofence**: blocca se distance_m > geofence_radius_m (solo se cantiere ha lat/lon)
- **Rate limit punch**: se ultimo log < 60s → 429 PUNCH_TOO_SOON
- **Session revoca**: revoked_at + expires_at check in punch

## Schema DB (migration 002 — definitivo)
- `companies` (id, name) — tabella company root
- `company_users` (company_id FK, user_id=auth.uid, role owner/admin/tech/viewer)
- `sites` — ALTER: aggiunto company_id FK, latitude, longitude, geofence_radius_m, pin_code
- `workers` (company_id uuid FK, full_name, fiscal_code, is_active) — NO birth_date
- `worksite_workers` (company_id, site_id, worker_id, status active/inactive)
- `worker_device_sessions` (company_id, worker_id, token_hash UNIQUE, expires_at, revoked_at)
- `presence_logs` (company_id, site_id, worker_id, event_type ENTRY/EXIT, timestamp_server, lat, lon, distance_m, ip, ua, session_id, method) — APPEND-ONLY (RLS: no UPDATE/DELETE policy)
- RLS: `is_company_member(uuid)` SECURITY DEFINER evita ricorsione su company_users
- Migration file: `migrations/002_multi_tenant.sql`
- **Migration 003**: `migrations/003_append_only.sql` — trigger BEFORE UPDATE/DELETE su presence_logs + ADD COLUMN pin_hash
- **Trigger append-only**: `_presence_logs_append_only()` — funziona anche con service_role (DB-level, non RLS)
- **PIN sicuro**: `lib/pinHash.js` — HMAC-SHA256(PIN_SIGNING_SECRET, pin), timing-safe compare; env `PIN_SIGNING_SECRET` obbligatoria
- **Geofence obbligatoria**: punch ritorna 422 GEOFENCE_NOT_CONFIGURED se cantiere senza lat/lon; GPS_REQUIRED se client non manda coords
- **identifyLimiter**: `middleware/rateLimit.js` — rate limit per IP+worksite_id su /scan/identify
- **Script**: `scripts/set-site-pin.js` e `scripts/selftest_scan.js` (6 test automatici)

## Audit Sicurezza 2026-03-03 — Fix applicati
- **CORS**: `X-Company-Id` aggiunto ad allowedHeaders in server.js (era mancante → bloccava tutte le chiamate autenticate)
- **Rate limit welcome**: `welcomeLimiter` (5/10min) su `/api/send-welcome` (era senza rate limit + unauthenticated)
- **QR cross-company**: `qr.js` ora verifica `site.company_id == req.companyId` prima di firmare
- **Race condition punch**: sostituita logica JS read+write con `supabase.rpc('punch_atomic')` + `pg_advisory_xact_lock`
- **Validazione input**: CF regex, full_name min/max, 409 su duplicato in workers.js
- **Limit query**: 5000 records su presence.js + reports.js; 50k su presenceReport.js con flag `logs_limit_reached`
- **Register.tsx**: usava `localStorage.setItem("palladia_legal_ok","1")` → ora `setLegalCache()` + privacy_version corretto
- **OnboardingCompany.tsx**: aggiunto `authLoading` check prima del redirect a /login (evita redirect prematuro)
- **Migration 005**: `migrations/005_punch_atomic.sql` — RPC `punch_atomic()` SECURITY DEFINER + advisory lock

## OAuth Google — Flow definitivo (2026-03-08, reset completo)
- **Flow**: Login → Google → ritorna su `/login` (redirectTo=origin/login) → SDK legge token dal hash → INITIAL_SESSION/SIGNED_IN → decideAppEntryRoute → /dashboard
- **supabase.ts**: `{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }` — NIENTE flowType, storageKey, storage custom
- **Login.tsx**: unico punto auth. `redirectTo: ${window.location.origin}/login`. onAuthStateChange con INITIAL_SESSION + SIGNED_IN. Errori OAuth da `?error=` nel URL al mount.
- **App.tsx**: route `/auth/callback` RIMOSSA. HomeRoute semplice: loading/session/landing.
- **AuthCallback.tsx**: file lasciato ma NON nel routing — inutilizzato.
- **IMPORTANTE Supabase dashboard**: Redirect URLs deve contenere `https://palladia-kappa.vercel.app/login` (NON /auth/callback)
- **Progetto Lovable**: git init fatto nella cartella locale — per deployare: `git remote add origin URL_GITHUB && git push -u origin master`

## OAuth Google — Note storiche (già superate dal Fix 2026-03-08)
- La versione precedente usava `detectSessionInUrl:false` + exchange manuale in AuthCallback — questa strategia è stata abbandonata perché causava il 401 descritto sopra.
- `decideRouteForSession` (se presente in auth.ts) è stata sostituita da `decideAppEntryRoute` che non chiama `getSession()` ridondanti.

## Frontend Auth Flow (aggiornato 2026-03-04 — v2 definitiva)
- **Frontend path**: `C:\Users\ricka\Desktop\PALLADIA\palladia-main\palladia-main\src`
- **Stack**: React 18 + TypeScript + React Router v6 + shadcn/ui + Supabase JS
- **supabase.ts**: `flowType:'pkce'`, `detectSessionInUrl:false`, `persistSession:true`, `autoRefreshToken:true`
- **Auth lib single source**: `src/lib/auth.ts` → `decideAppEntryRoute(session: Session, nextPath?)` — prende sessione già in mano, MAI chiama getSession()
- **AuthCallback**: `src/pages/AuthCallback.tsx` — pagina dedicata PKCE exchange a `/auth/callback`; ranRef (StrictMode), settledRef (timeout vs exchange race), 12s safety timeout
- **Google OAuth redirectTo**: `${window.location.origin}/auth/callback` (NON /login)
- **palladia_next**: sessionStorage — Login.tsx lo scrive prima del redirect Google, AuthCallback.tsx lo legge al ritorno
- **Gate flow**: legal (DB + cache) → company (DB + cache) → safeNext|/dashboard
- **Log tag**: `[AuthFlow]` in tutti i file (AuthCallback, Login, LandingPage, ProtectedRoute)
- **DebugAuth**: `src/pages/DebugAuth.tsx` → route `/debug/auth` (DEV only) — mostra session, userId, legalCache, companyId; bottone clearAuthStorage
- **Auth context**: `src/contexts/AuthContext.tsx` → `useAuth()` hook (session, user, loading)
- **ProtectedRoute**: gate inline legal + company, log `[AuthFlow]`
- **LandingPage**: guard useEffect per ?code/?error → forward /auth/callback; usa decideAppEntryRoute(session)
- **Login**: forward ?code/?error → /auth/callback; usa decideAppEntryRoute(session) per email login e INITIAL_SESSION
- **localStorage keys**: `palladia_company_id`, `palladia_legal_ok` (cleared on logout via `clearAuthStorage()`)
- **NEXT allowlist**: /dashboard, /cantieri, /risorse, /pos, /pos/nuovo, /account, /profile, /settings
- **legal_acceptances SQL**: `supabase/migrations/004_legal_acceptances.sql`
- **Supabase config richiesta**: Redirect URLs deve contenere `https://tuo-sito.vercel.app/auth/callback` + `http://localhost:5173/auth/callback`
- **Git**: repo locale in palladia-main/palladia-main, branch master, NO remote ancora (user deve aggiungere GitHub URL da Lovable.dev)
- **Root cause loop OAuth risolto**: detectSessionInUrl:true + auto-parse → SIGNED_OUT concorrente → getSession()=null → navigate('/') → loop. Fix: detectSessionInUrl:false + exchange manuale in AuthCallback + decideAppEntryRoute(session) no-getSession

## Deploy Railway
- **URL pubblico**: `https://palladia-backend-production.up.railway.app`
- **Variabili env Railway**: configurate (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, QR_SIGNING_SECRET, PIN_SIGNING_SECRET, RESEND_API_KEY, ecc.)
- **Smoke test**: `GET https://palladia-backend-production.up.railway.app/api/pdf-smoke`
- **Stato 2026-03-18**: online dopo pagamento — smoke test OK, PDF 427KB generato correttamente

## Post-lancio fix produzione (2026-03-19) — scan/identify 500
Tre cause radice indipendenti, tutte risolte:

1. **Schema drift workers**: produzione aveva `first_name`/`last_name` NOT NULL (migration 001 originale, pre-002).
   Risolto con: `ALTER TABLE workers ALTER COLUMN first_name DROP NOT NULL, ALTER COLUMN last_name DROP NOT NULL;` (Supabase SQL Editor).
   **Attenzione**: `birth_date` NON esiste su produzione — non includere nel ALTER.

2. **SUPABASE_SERVICE_ROLE_KEY mancante su Railway**: `lib/supabase.js` usa fallback `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY`. Se mancante → anon key → RLS blocca tutti gli INSERT. Aggiunta la chiave nelle env Railway.

3. **CORS bloccava Railway origin**: `scan.html` è servita da Railway → browser invia `Origin: https://palladia-backend-production.up.railway.app` → non era in whitelist → 500 HTML (non JSON). Fix in `server.js`: aggiunto `process.env.APP_BASE_URL` e `/^https:\/\/[a-z0-9-]+\.up\.railway\.app$/` a `ALLOWED_ORIGINS`.

**Diagnostica**: `GET /api/v1/scan/identify-diag?worksite_id=<uuid_reale>` — endpoint step-by-step rimasto nel codice (utile per debug futuro).

## Dipendenze
- Puppeteer (Chromium bundled), Express, CORS, @supabase/supabase-js, dotenv, express-rate-limit
- Frontend: react, react-router-dom, @supabase/supabase-js, shadcn/ui, tailwindcss, lucide-react
- Font: Arial/Helvetica (sistema Chromium)
