# Palladia Backend — Architettura (per chi arriva da fuori)

Questo documento esiste per una ragione precisa: oggi un'unica persona conosce
questo codebase. Se domani dovesse subentrare qualcun altro (un freelancer di
backup, un secondo sviluppatore), questo è il punto di partenza — non
sostituisce leggere il codice, ma evita di doverlo rileggere tutto da zero
per capire dove sta cosa e perché.

`README.md` resta la guida rapida (avvio locale, env var). Questo file va più
in profondità: cosa fa davvero il sistema, come sono organizzati i moduli, e
soprattutto **le trappole non ovvie** che hanno già causato bug reali in
produzione — per non ripeterli.

---

## 1. Cos'è Palladia, in una frase

Piattaforma SaaS multi-tenant per la gestione digitale di cantieri edili in
Italia: presenze via badge/QR con geofence GPS, generazione documenti di
sicurezza (POS/DVR/PIMUS) assistita da AI, un assistente conversazionale con
tool calling reale sul database ("Ladia"), un marketplace di corsi di
formazione con pagamenti Stripe Connect, un portale per Studi CDL (consulenti
del lavoro) che gestiscono i loro clienti-imprese, e un portale per
coordinatori CSE esterni. Sei tipi di utente diversi condividono lo stesso
backend: impresa, lavoratore, coordinatore CSE, studio CDL, ente di
formazione, ispettore ASL.

Due repository separati:
- **Backend** (questo repo) — Node.js/Express su Railway
- **Frontend** — React/Vite su Vercel, repo `palladiaofficial-debug/palladia`
  (locale: `C:\Users\ricka\palladia` sulla macchina di sviluppo principale)

Database: **Supabase** (Postgres + Auth + Storage), un solo progetto condiviso
da entrambi i repo. Non c'è un ORM: tutte le query passano dal client
`@supabase/supabase-js` con la **service-role key** (bypassa RLS lato
backend — la sicurezza multi-tenant è enforced a mano in ogni query con
`.eq('company_id', ...)`, non dal database).

---

## 2. Mappa dei moduli — per dominio, non per file

`routes/v1/` ha oggi **85+ file**. Elencarli tutti non aiuterebbe — quello
che serve è sapere in quale area cercare:

| Dominio | File principali | Cosa fa |
|---|---|---|
| **Presenze/badge** | `scan.js`, `badge.js`, `badgePunch.js`, `presence.js`, `presenceCorrections.js`, `qr.js`, `qrPdf.js`, `sessions.js`, `alerts.js` | Timbratura QR/badge, firma HMAC, geofence, correzioni manuali, sessioni dispositivo lavoratore |
| **Report/export** | `reports.js`, `siteExport.js` + `services/presenceReport.js`, `services/workerHoursReport.js` | PDF/CSV/Excel presenze e ore lavorate — tutti passano da `lib/presencePairing.js` (algoritmo unico di pairing ENTRY/EXIT, vedi §4) |
| **Cantieri** | `sitesOverview.js`, `siteAdmin.js`, `siteChecklist.js`, `siteCosts.js`, `siteNotes.js`, `sitePhases.js`, `siteSchedule.js`, `siteWeather.js` | CRUD cantiere, checklist setup, meteo, fasi lavoro |
| **Sicurezza (documenti)** | `pos.js`, `dvr.js`, `pimus.js` + `pos-html-generator.js`, `dvr-html-generator.js`, `pimus-html-generator.js` (root) | Generazione documenti via AI (Claude) + Puppeteer per il PDF finale. **DVR/PIMUS sono disattivati in tutta la piattaforma** (decisione prodotto, non bug — vedi §4) |
| **Ladia (AI)** | `chat.js`, `chatUpload.js` + `services/ladiaEngine.js`, `ladiaTools.js`, `ladiaActions.js`, `ladiaMemory.js`, `ladiaProactive.js`, `ladiaSmartProposal.js`, `ladiaDocumentSearch.js` | L'assistente conversazionale — tool calling reale (crea/modifica record DB), non solo Q&A. `lib/ladiaGenericTools.js` + `lib/ladiaSchemaRegistry.js` generano i tool dallo schema DB |
| **Billing** | `billing.js` + `services/stripe.js`, `lib/billing.js` | Checkout/portale Stripe, gate abbonamento centralizzato in `middleware/verifyJwt.js` (blocca scritture su trial scaduto) |
| **Studio CDL** | `studio.js`, `studioFiles.js` | Portale consulenti del lavoro: gestione clienti, semaforo compliance, cedolini/ore mensili |
| **Coordinatore CSE** | `coordinator.js`, `coordinatorPortal.js`, `coordinatorPro.js`, `coordinatorVerifications.js`, `verbale.js`, `nonconformities.js` | Portale esterno per coordinatori sicurezza: verbali sopralluogo, non conformità |
| **Formazione (marketplace)** | `formazioneAdmin.js`, `formazioneProvider.js`, `formazioneRecommend.js`, `bookings.js`, `marketplace.js`, `consultant*.js`, `courseQuotes.js` | Marketplace corsi con provider esterni, prenotazioni, pagamenti |
| **Fatture** | `expenses.js`, `sdiInvoices.js`, `sdiConsultation.js` + `services/sdiInvoices.js`, `sdiConsultation.js` | **`sdiInvoices.js` (collegamento diretto via Openapi) è codice morto** — mai configurato, UI rimossa 2026-07-18. La via viva è `sdiConsultation.js` (Delega Unificata / A-Cube) |
| **Lavoratori** | `workers.js`, `workerArea.js`, `workerDocs.js`, `workerInvite.js`, `certificates.js`, `certificateOcr.js` | Anagrafica, area self-service (login via CF), documenti/idoneità, OCR certificati |
| **Computo/economia** | `computo.js`, `capitolato.js`, `prezzario.js`, `economia.js` + `services/computoParser.js`, `capitolatoParser.js` | Computo metrico, capitolati, listino prezzi, conto economico cantiere |
| **Onboarding/team** | `onboarding.js`, `invites.js`, `company.js` | Setup company, inviti membri team |

`services/` contiene la logica di dominio (chiamata dalle routes) più **~20
cron job** (`*Cron.js`) per scadenze, digest, alert — schedulati in
`server.js` all'avvio del processo.

`lib/` contiene helper condivisi senza stato applicativo: client Supabase,
audit log, compliance engine, PDF extraction, autenticazione.

---

## 3. Come parlano i due repository

- Frontend chiama `VITE_API_URL` (Railway) su `/api/v1/*` con
  `Authorization: Bearer <supabase-jwt>` + header `X-Company-Id`.
- **`X-Company-Id` non è mai una fonte di verità** — è solo un hint di
  routing. Ogni middleware/route ricava il company reale dal JWT + tabella
  `company_users`, mai dall'header da solo (altrimenti sarebbe un IDOR banale).
- Le pagine pubbliche (`scan.html`, `asl.html`, `badge-punch.html`) sono
  servite come file statici da Express (`public/`), non dal frontend React —
  usate da chi non ha (o non deve avere) un account Palladia.
- Le migrazioni SQL vivono **in questo repo** (`migrations/`), non nel
  frontend — anche se toccano tabelle usate anche lì. `supabase/migrations/`
  nel frontend è uno specchio storico, non la fonte di verità.

---

## 4. Le trappole — cose che sembrano ovvie e non lo sono

Questa sezione esiste perché ognuna di queste ha già causato un bug reale in
produzione. Leggila prima di toccare le aree corrispondenti.

**`presence_logs` è append-only a livello di database.** Un trigger
PostgreSQL blocca UPDATE/DELETE — anche con la service-role key. Non è un
bug se un DELETE fallisce silenziosamente: è voluto (tracciabilità D.Lgs.
81/2008). Per "correggere" una timbratura si INSERISCE un nuovo record
(`method: 'admin_manual_correction'`), mai si modifica quello vecchio.

**Il pairing ENTRY/EXIT è centralizzato in `lib/presencePairing.js`.** Fino
al 18/7/2026 esistevano 7 copie indipendenti dello stesso algoritmo, tutte
con lo stesso bug (raggruppavano i log per giorno solare PRIMA di accoppiare
ENTRY/EXIT, spezzando i turni a cavallo di mezzanotte). Se serve calcolare
ore lavorate da presence_logs, **usa sempre `pairLogsByDay()` da lì** — non
scrivere un ottavo algoritmo.

**RLS è disabilitato su molte tabelle by design** (il backend usa la
service-role key che bypassa RLS comunque), ma **era stato disabilitato per
errore** su 24 tabelle a maggio 2026 (migrazione 129 l'ha corretto) — se
lavori su una tabella nuova, verifica sempre `pg_class.relrowsecurity` +
`pg_policies`, non fidarti che "il backend filtra già per company_id" come
unica barriera: chi ha `SUPABASE_ANON_KEY` (pubblica, `GET /api/config`) può
interrogare Supabase direttamente bypassando completamente il backend.

**DVR e PIMUS sono disattivati in tutta la piattaforma** — decisione
prodotto esplicita, non un bug o un lavoro incompiuto. Non riattivare senza
conferma esplicita.

**Le migrazioni si applicano con `node scripts/migrate.js`**, che usa l'RPC
`exec_sql` di Supabase — **non supporta `BEGIN;`/`COMMIT;` espliciti**. Le
migrazioni fondative (001-013 circa) usavano transazioni esplicite perché
applicate a mano nello SQL Editor; quelle più recenti no.

**Verifica sempre le env var di produzione con `railway variables`**, mai
dedurle dall'`.env` locale (quasi certamente disallineato) o da un server
avviato in locale.

**Due company di test/reali coesistono deliberatamente**: `carpiooricardo@gmail.com`
→ MSCedilizia (`d5dd4e79-...`) è l'ambiente di test; `carpio@mscedilizia.it`
→ MSCedilizia S.r.l. (`309e9018-...`) è l'account reale usato sul campo. Non
sono un errore di duplicazione — non unirli né disattivarne uno.
`scripts/setup-ci-user.js` sceglie "la prima company" **senza `order by`**:
nondeterministico, può restituire una company diversa da quella attesa se
rieseguito — controllare sempre l'output prima di fidarsene.

**`.env.example` non riflette più tutte le variabili richieste** — il numero
reale di integrazioni (Stripe, Anthropic, Resend, Sentry, Openapi/SdI,
A-Cube, Telegram, weather API) è cresciuto molto oltre quanto documentato
lì. In caso di dubbio, `railway variables` è la fonte di verità.

---

## 5. Deploy e osservabilità

- **Backend**: push su `main` → deploy automatico Railway. Nessun ambiente
  di staging separato — si deploya direttamente in produzione (rischio
  accettato, mitigato da test manuali pre-push e da Sentry).
- **Frontend**: push su `main` → deploy automatico Vercel. L'app **si
  ricarica da sola** ad ogni nuovo deploy rilevato (nessun banner da
  cliccare, scelta esplicita del 7/7/2026: sempre ultima versione per tutti,
  anche a costo di perdere un messaggio a Ladia non ancora inviato durante
  il reload — evento raro, controllo ogni 60s).
- **Errori**: Sentry su entrambi i lati (`SENTRY_DSN` backend,
  `VITE_SENTRY_DSN` frontend). Un middleware in `server.js` intercetta anche
  le risposte 5xx dirette (non solo le eccezioni non gestite via `next(err)`).
- **Test automatico**: `scripts/selftest_api.js` (`npm test`) — si
  autentica da solo con un utente CI dedicato (`TEST_CI_PASSWORD` su
  Railway). Se inizia a fallire silenziosamente, controllare per primo se
  quella password è ancora sincronizzata con Supabase Auth (drift possibile,
  vedi trappola sopra su `setup-ci-user.js`).

---

## 6. Dove sta la conoscenza che non è nel codice

Molto contesto su *perché* certe cose sono fatte in un certo modo vive in
due posti fuori dal codice sorgente:

1. **`CHECKLIST_LANCIO.md`** (root di questo repo) — checklist di lancio con
   la cronologia di ogni bug reale trovato e corretto durante le sessioni di
   verifica pre-lancio, con date e commit. È il registro più affidabile del
   "perché è così" per le aree toccate.
2. **I messaggi di commit** — in questo progetto sono deliberatamente
   estesi e spiegano il *perché*, non solo il *cosa*. `git log --oneline` è
   spesso più veloce di rileggere il codice per capire l'intento di una
   scelta non ovvia.

Non esiste (ancora) una wiki o una knowledge base esterna: tutto il contesto
operativo è in questi due posti, più questo file.
