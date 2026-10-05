'use strict';
// ── Timbratura senza internet (F-284, mockup approvato il 2026-10-05) ─────────
//   GET  /api/v1/badge/:code/offline-kit    → quello che serve al telefono per timbrare senza rete
//   POST /api/v1/badge/:code/offline-punch  → la timbratura salvata sul telefono, inviata al ritorno della rete
//   POST /api/v1/presence/offline-punches/:id/dismiss  "È giusta" (titolare)
//   POST /api/v1/presence/offline-punches/:id/apply    "Registra" una timbratura da decidere (titolare)
//
// File separato da badgePunch.js: la timbratura normale non cambia. Stessa
// identità di /punch: il badge_code è la prova di chi timbra.
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { badgePunchLimiter } = require('../../middleware/rateLimit');
const { hasValidConsent }   = require('../../lib/workerPrivacyConsent');
const { receiveOfflinePunch, confirmOfflinePunch, applyOfflinePunch, MAX_AGE_MS } = require('../../lib/offlinePunch');

const isValidBadgeCode = (code) => typeof code === 'string' && /^[A-Fa-f0-9]{18}$/.test(code);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function workerByBadge(code) {
  return supabase.from('workers')
    .select('id, full_name, is_active, company_id, privacy_consent_accepted_at, privacy_consent_version')
    .eq('badge_code', code.toUpperCase()).maybeSingle();
}

// Il telefono lo chiede (con la rete) ogni volta che apre la scheda Timbra e
// lo tiene da parte: cantieri con le coordinate, stato aperto/chiuso e l'ora
// del server, per capire poi se l'orologio del telefono è stato cambiato.
router.get('/badge/:code/offline-kit', badgePunchLimiter, async (req, res) => {
  try {
    const { code } = req.params;
    if (!isValidBadgeCode(code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
    const { data: worker, error } = await workerByBadge(code);
    if (error) return res.status(500).json({ error: 'DB_ERROR' });
    if (!worker) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
    if (!worker.is_active) return res.status(403).json({ error: 'BADGE_REVOKED' });
    // Senza consenso privacy/GPS non si timbra, nemmeno senza rete (F-178)
    if (!hasValidConsent(worker)) return res.status(403).json({ error: 'PRIVACY_CONSENT_REQUIRED' });

    const [sitesRes, lastRes] = await Promise.all([
      supabase.from('sites').select('id, name, address, latitude, longitude, geofence_radius_m')
        .eq('company_id', worker.company_id).not('status', 'in', '(chiuso,eliminato)'),
      supabase.from('presence_logs').select('event_type, timestamp_server, site_id')
        .eq('worker_id', worker.id).eq('company_id', worker.company_id)
        .order('timestamp_server', { ascending: false }).limit(1),
    ]);
    if (sitesRes.error || lastRes.error) return res.status(500).json({ error: 'DB_ERROR' });
    const last = lastRes.data?.[0] || null;
    const open = last?.event_type === 'ENTRY';

    res.set('Cache-Control', 'no-store');
    res.json({
      server_now:   Date.now(),
      max_age_ms:   MAX_AGE_MS,
      next_action:  open ? 'EXIT' : 'ENTRY',
      open_since:   open ? last.timestamp_server : null,
      open_site_id: open ? last.site_id : null,
      sites: (sitesRes.data || []).map(s => ({
        site_id: s.id, site_name: s.name, address: s.address || null,
        latitude: s.latitude, longitude: s.longitude, geofence_radius_m: s.geofence_radius_m,
      })),
    });
  } catch (err) {
    console.error('[offline-kit] unexpected error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.post('/badge/:code/offline-punch', badgePunchLimiter, async (req, res) => {
  try {
    const { code } = req.params;
    const body = req.body || {};
    if (!isValidBadgeCode(code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
    if (!UUID_RE.test(body.client_request_id || '')) return res.status(400).json({ error: 'MISSING_CLIENT_REQUEST_ID' });
    if (!body.site_id || !UUID_RE.test(body.site_id)) return res.status(400).json({ error: 'MISSING_FIELDS', required: ['site_id'] });

    const { data: worker, error } = await workerByBadge(code);
    if (error) return res.status(500).json({ error: 'DB_ERROR' });
    if (!worker) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
    if (!worker.is_active) return res.status(403).json({ error: 'BADGE_REVOKED' });
    if (!hasValidConsent(worker)) return res.status(403).json({ error: 'PRIVACY_CONSENT_REQUIRED' });

    const { data: site, error: siteErr } = await supabase.from('sites')
      .select('id, name, company_id, latitude, longitude, geofence_radius_m').eq('id', body.site_id).maybeSingle();
    if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
    if (!site) return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });
    if (site.company_id !== worker.company_id) return res.status(403).json({ error: 'COMPANY_MISMATCH' });

    const r = await receiveOfflinePunch({ worker, site, body, userAgent: req.headers['user-agent'] });
    if (!r.ok) return res.status(r.http).json({ error: r.error });
    res.json({ ok: true, status: r.status, event_type: r.event_type, punched_at: r.punched_at, replayed: r.replayed });
  } catch (err) {
    console.error('[offline-punch] unexpected error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── Da fare del titolare ──────────────────────────────────────────────────────
const STATUS = { NOT_FOUND: 404, ALREADY_DONE: 409, INVALID_TIME: 400, DB_ERROR: 500 };
function ownerAdmin(req, res) {
  if (['owner', 'admin'].includes(req.userRole)) return true;
  res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  return false;
}

router.post('/presence/offline-punches/:id/dismiss', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const r = await confirmOfflinePunch({ id: req.params.id, companyId: req.companyId, userId: req.user.id });
  if (!r.ok) return res.status(STATUS[r.code] || 400).json({ error: r.code, message: r.message });
  res.json({ ok: true });
});

router.post('/presence/offline-punches/:id/apply', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const r = await applyOfflinePunch({ id: req.params.id, companyId: req.companyId, userId: req.user.id, userRole: req.userRole, at: req.body?.at ?? null });
  if (!r.ok) return res.status(STATUS[r.code] || 400).json({ error: r.code, message: r.message });
  res.json({ ok: true, written: r.written });
});

module.exports = router;
