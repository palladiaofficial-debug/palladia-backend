# Palladia — Backend API

REST API server for Palladia, a digital attendance management platform for Italian construction sites.

**Live:** `https://palladia-backend-production.up.railway.app`
**Frontend repo:** [`palladiaofficial-debug/palladia`](https://github.com/palladiaofficial-debug/palladia)
**Deployed on:** Railway
**Runtime:** Node.js 20 / Express 5

---

## What this server does

- Handles all authenticated API calls from the React frontend (workers, sites, presence, reports)
- Generates PDF documents: QR sheets (A4 printable), presence reports, POS documents (Piano Operativo Sicurezza) via Puppeteer/Chromium
- Serves the mobile-optimised punch page (`/scan/:siteId`) as a static HTML file — no app install required
- Issues and verifies HMAC-signed QR tokens for site access
- Runs a background cron job to detect workers with open entries (missing exits) and send admin alerts

---

## Architecture

```
server.js              Entry point — Express app, CORS, rate limiting, route mounting
routes/v1/             Authenticated API routes (JWT required)
  index.js             Router aggregator
  scan.js              Public punch endpoints (identify, punch, verify-qr)
  workers.js           Worker CRUD + site assignment
  presence.js          Presence log queries
  reports.js           PDF/CSV/Excel export
  qr.js                QR token signing
  qrPdf.js             Printable A4 QR PDF generation
  siteAdmin.js         Site configuration (geofence, PIN)
  dashboard.js         KPI summary endpoint
  sessions.js          Worker device session management
  asl.js               Temporary ASL inspector access tokens
  alerts.js            Missing-exit anomaly detection
  auditLog.js          Admin audit trail viewer
  onboarding.js        First-run onboarding flow
lib/
  supabase.js          Supabase service-role client
  pinHash.js           bcrypt PIN hashing helpers
  audit.js             Non-blocking audit log writer
middleware/
  verifyJwt.js         Supabase JWT verification + company membership check
  rateLimit.js         Per-endpoint rate limiters (scan, api, identify, welcome)
services/
  email.js             Transactional email (Resend)
  missingExitCron.js   Cron: daily alert for open entries
  presenceReport.js    Presence PDF/CSV builder
  workerHoursReport.js Worker hours PDF/Excel builder
migrations/            SQL migration files (001 → 010) — run manually in Supabase SQL Editor
scripts/
  selftest_scan.js     Automated smoke tests (10 scenarios)
  set-site-pin.js      CLI utility to set/remove a site PIN
public/                Static pages served by Express
  scan.html            Mobile punch page (no framework, vanilla JS)
  asl.html             ASL inspector read-only view
pos-html-generator.js  POS document HTML builder (CSS + template)
pdf-renderer.js        Puppeteer PDF renderer with shared browser pool
```

---

## Security model

| Concern | Implementation |
|---|---|
| Authentication | Supabase JWT — verified on every protected route via `verifyJwt` middleware |
| Multi-tenancy | `company_id` is always derived from the DB, never trusted from client headers |
| Punch integrity | `punch_atomic()` PostgreSQL function with advisory lock — race-condition safe |
| Presence immutability | DB-level trigger blocks UPDATE/DELETE on `presence_logs` — survives `service_role` |
| QR signing | HMAC-SHA256 with `QR_SIGNING_SECRET` — configurable TTL, verified server-side |
| PIN hashing | bcrypt (bcryptjs, async) — `PIN_SIGNING_SECRET` env var required |
| Geofence | Haversine distance calculated on server, never on client device |
| Session limits | Max 2 active sessions per worker — oldest revoked on new login |
| Rate limiting | Scan: 20/min · API: 120/min · Identify: 10/min · Welcome email: 5/10min |

---

## Database schema

Migrations are in `migrations/` and must be run manually in Supabase SQL Editor in order.

| Migration | Description |
|---|---|
| `001_badge_tables.sql` | Initial schema: companies, sites, workers, presence_logs |
| `002_multi_tenant.sql` | Multi-tenant: company_users, RLS policies, worker_device_sessions |
| `003_append_only.sql` | Append-only trigger on presence_logs + pin_hash column |
| `004_gps_accuracy.sql` | GPS accuracy columns on presence_logs |
| `005_punch_atomic.sql` | `punch_atomic()` RPC function with advisory lock |
| `006_asl_audit.sql` | ASL access tokens + admin audit log tables |
| `007_sites_frontend_columns.sql` | Extra site metadata columns for frontend |
| `008_bcrypt_pin_cleanup.sql` | DROP legacy pin_code column (replaced by pin_hash) |
| `009_drop_hmac_fallback.sql` | Remove HMAC PIN fallback after full bcrypt migration |
| `010_legal_versioning.sql` | legal_acceptances v2 + cookie_consents table |

---

## Local development

**Prerequisites:** Node.js ≥ 20, npm

```bash
git clone https://github.com/palladiaofficial-debug/palladia-backend.git
cd palladia-backend
npm install
cp .env.example .env
# Fill in the required values in .env (see below)
node server.js
# Server running at http://localhost:3001
```

Run smoke tests:

```bash
node scripts/selftest_scan.js
```

---

## Environment variables

Copy `.env.example` to `.env` and fill in the values. See `.env.example` for descriptions and generation commands.

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Service role key (secret — not the anon key) |
| `QR_SIGNING_SECRET` | Yes | Random 32-byte hex — signs QR tokens |
| `PIN_SIGNING_SECRET` | Yes | Random 32-byte hex — used by bcrypt PIN flow |
| `APP_BASE_URL` | Yes | Frontend URL (e.g. `https://palladia-kappa.vercel.app`) — used in QR links |
| `RESEND_API_KEY` | No | Transactional email. If absent, emails are silently skipped |
| `ANTHROPIC_API_KEY` | No | POS AI generation. If absent, AI endpoints return 503 |
| `QR_TOKEN_TTL_SECS` | No | Default `604800` (7 days) |
| `GPS_MAX_ACCURACY_M` | No | Default `80` (metres) |
| `PDF_DEBUG` | No | `true` to log PDF overflow elements — development only |
| `PORT` | No | Railway sets this automatically |

Generate secret values:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Run twice — one value for QR_SIGNING_SECRET, one for PIN_SIGNING_SECRET
```

---

## Key API endpoints

All routes under `/api/v1/` require `Authorization: Bearer <supabase-jwt>` and `X-Company-Id: <uuid>` headers unless marked public.

### Public (no auth)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/scan/worksites/:id` | Site info for punch page |
| `POST` | `/api/v1/scan/identify` | Fiscal code → session token |
| `POST` | `/api/v1/scan/punch` | Record ENTRY or EXIT |
| `GET` | `/api/v1/scan/verify-qr` | Verify HMAC QR token |
| `GET` | `/asl/:token` | ASL inspector public view |

### Authenticated
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/dashboard` | KPIs: sites, workers, today's punches |
| `GET/POST` | `/api/v1/workers` | List / create workers |
| `GET/POST/DELETE` | `/api/v1/sites/:id/workers` | Assign workers to site |
| `GET` | `/api/v1/presence` | Presence log queries |
| `GET` | `/api/v1/reports/sites/:id/presenze` | Presence report PDF/CSV |
| `GET` | `/api/v1/reports/worker-hours` | Hours report PDF/Excel |
| `GET` | `/api/v1/sites/:id/qr-pdf` | Printable A4 QR PDF |
| `GET` | `/api/v1/sites/:id/qr-link` | Signed QR URL |
| `POST` | `/api/v1/sites/:id/asl-token` | Generate ASL inspector link |
| `GET` | `/api/v1/audit-log` | Admin audit trail |
| `GET` | `/api/pdf-smoke` | PDF render health check |

---

## Deploy (Railway)

The repo includes a `Procfile` (`web: node server.js`) and `nixpacks.toml` for Railway auto-detection.

Push to `main` triggers automatic redeploy. Required env vars must be configured in the Railway dashboard under **Variables**.

See `docs/GO_LIVE.md` for the full go-live checklist including Supabase migration steps, smoke tests, and rollback procedures.

---

## Legal and compliance

- Presence logs are **append-only** at the database level (PostgreSQL trigger) — compliant with D.Lgs. 81/2008 traceability requirements
- GDPR: `legal_acceptances` and `cookie_consents` tables track consent with timestamp, IP, and version
- Data processing agreement (DPA) is available to customers at `/dpa` on the frontend
- All data remains within EU infrastructure (Supabase EU region, Railway US-East with EU option available)
