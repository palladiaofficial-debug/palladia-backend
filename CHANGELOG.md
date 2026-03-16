# Changelog — Palladia Backend

All notable changes to this project are documented here.
Format: [Semantic versioning](https://semver.org/) — `MAJOR.MINOR.PATCH`

---

## [1.5.0] — 2026-03-15

### Added
- Welcome email: configurable sender, dynamic URL, premium template via Resend

### Fixed
- `scan.html` input font-size set to 16px — prevents auto-zoom on iOS Safari

---

## [1.4.0] — 2026-03-12

### Added
- `GET /api/v1/reports/worker-hours` — worked hours report (PDF + Excel) per site and date range
- `GET /api/v1/dashboard` — single-call KPI endpoint (sites, workers, today's punches, active presence)

### Fixed
- Note save on punch; contextual ENTRY/EXIT punch logic; `/api/v1/scan/status` endpoint
- Geofence made optional — punch page adapts messaging based on site configuration
- Redesigned `scan.html` to match Palladia design system

---

## [1.3.0] — 2026-03-09

### Added
- **Migration 006** — `asl_access_tokens` and `admin_audit_log` tables (append-only trigger)
- `GET/POST /api/v1/sites/:id/asl-token` — generate temporary ASL inspector access links
- `GET/DELETE /api/v1/asl-tokens/:id` and `GET /api/v1/asl/:token` — ASL token management and public view
- `GET/POST /api/v1/alerts/missing-exits` — detect ENTRY without EXIT, send admin alert email
- `GET /api/v1/audit-log` — admin-only audit trail viewer
- `GET/DELETE /api/v1/workers/:id/sessions` and `DELETE /api/v1/sessions/:id` — remote session revocation
- `GET /api/v1/scan/verify-qr` — public endpoint for QR HMAC signature verification
- `GET /api/v1/reports/presence-range` — CSV export with no 90-day limit (up to 200k rows)
- `POST /api/v1/scan/logout-device` — worker device logout
- `lib/audit.js` — non-blocking audit log writer
- `services/missingExitCron.js` — daily cron for missing-exit detection
- `public/asl.html` — public read-only view for ASL inspectors
- Audit logging on worker create/assign and site PIN/coords changes

### Changed
- QR URL format: `/scan/<siteId>?t=<hmac>&exp=<unix>` (moved token to query params)

---

## [1.2.0] — 2026-03-03 — Security Audit

### Fixed (security)
- **CORS**: added `X-Company-Id` to `allowedHeaders` — was blocking all authenticated API calls
- **Rate limit**: added `welcomeLimiter` (5/10min) on `/api/send-welcome` — was unauthenticated and unlimited
- **QR cross-company**: `qr.js` now verifies `site.company_id === req.companyId` before signing
- **Race condition on punch**: replaced JS read-then-insert with `supabase.rpc('punch_atomic')` backed by `pg_advisory_xact_lock`
- **Input validation**: fiscal code regex, full_name min/max length, 409 on duplicate worker
- **Query limits**: 5,000 records cap on presence/reports queries; 50,000 on annual reports with `logs_limit_reached` flag

### Added
- **Migration 005** — `punch_atomic()` PostgreSQL function (SECURITY DEFINER + advisory lock)
- `middleware/rateLimit.js` — `identifyLimiter` per IP+worksite on `/scan/identify`

---

## [1.1.0] — 2026-02-26 — Multi-tenant v2 + Badge system

### Added
- **Migration 002** — full multi-tenant schema: `company_users`, RLS policies, `worker_device_sessions`
- **Migration 003** — append-only trigger on `presence_logs` + `pin_hash` column
- **Migration 004** — GPS accuracy columns on `presence_logs`
- `middleware/verifyJwt.js` — JWT verification with real `company_users` membership check
- `routes/v1/scan.js` — public punch endpoints: `identify`, `punch` (with geofence haversine), `verify-qr`
- `routes/v1/qr.js` — HMAC-SHA256 QR token signing
- `routes/v1/qrPdf.js` — printable A4 QR PDF with site info, 270×270 QR, worker instructions
- `routes/v1/presence.js` — presence log queries with date filtering
- `routes/v1/reports.js` — PDF/CSV presence reports
- `routes/v1/workers.js` — worker CRUD + site assignment
- `routes/v1/siteAdmin.js` — site geofence and PIN configuration
- `lib/pinHash.js` — bcrypt PIN hashing (bcryptjs async)
- `scripts/selftest_scan.js` — 10 automated smoke test scenarios
- `scripts/set-site-pin.js` — CLI utility for site PIN management
- `public/scan.html` — mobile punch page (vanilla JS, no framework)
- Server-side event_type logic: last log ENTRY → EXIT, else ENTRY (never trusted from client)
- Session revocation: `revoked_at` + `expires_at` checked on every punch
- Max 2 active sessions per worker — oldest revoked on new identify

---

## [1.0.0] — 2026-02-13 — Initial release

### Added
- Express server with CORS, rate limiting, Puppeteer PDF renderer
- POS (Piano Operativo Sicurezza) AI generation via Anthropic Claude — SSE streaming
- PDF generation: POS documents with header/footer, multi-page layout, cover page
- Initial site/worker management endpoints
- Railway deploy configuration (Procfile, nixpacks.toml)
- Supabase integration with service-role client
