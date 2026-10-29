'use strict';
// ── Timbratura senza internet dal QR del cantiere (F-406, AUDIT.md del frontend) ──
//   GET  /api/v1/scan/offline-kit?worksite_id=&session_token=  → l'ora del server e cosa aspettarsi
//   POST /api/v1/scan/offline-punch                            → la timbratura salvata sul telefono
//
// Prima la pagina del QR rimandava /scan/punch quando tornava la rete, e la
// timbratura prendeva l'ora del ritorno della rete (in cantiere anche ore dopo).
// Qui si usa lo stesso sistema del badge (F-284, lib/offlinePunch.js): l'ora è
// quella del tocco, corretta con l'orologio del server, e i casi dubbi li
// decide il titolare in Da fare. File separato da scan.js: la timbratura
// normale non cambia. Stessa identità di /scan/punch: la sessione del telefono.
const crypto = require('crypto');
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { scanLimiter } = require('../../middleware/rateLimit');
const { hasValidConsent } = require('../../lib/workerPrivacyConsent');
const { receiveOfflinePunch, MAX_AGE_MS } = require('../../lib/offlinePunch');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Sessione del telefono valida, come in POST /scan/punch. { worker } oppure { http, error }. */
async function sessione(token) {
  if (typeof token !== 'string' || token.length !== 64) return { http: 401, error: 'INVALID_SESSION_TOKEN' };
  const { data: s, error } = await supabase.from('worker_device_sessions')
    .select('id, worker_id, company_id, expires_at, revoked_at, worker:workers(full_name, is_active, privacy_consent_accepted_at, privacy_consent_version)')
    .eq('token_hash', hashToken(token)).maybeSingle();
  if (error) return { http: 500, error: 'DB_ERROR' };
  if (!s) return { http: 401, error: 'INVALID_SESSION_TOKEN' };
  if (s.revoked_at) return { http: 401, error: 'SESSION_REVOKED' };
  if (new Date(s.expires_at) < new Date()) return { http: 401, error: 'SESSION_EXPIRED' };
  if (!s.worker?.is_active) return { http: 403, error: 'WORKER_DEACTIVATED' };
  if (!hasValidConsent(s.worker)) return { http: 403, error: 'PRIVACY_CONSENT_REQUIRED' };
  return { worker: { id: s.worker_id, company_id: s.company_id, full_name: s.worker.full_name } };
}

async function cantiere(id, companyId) {
  if (!UUID_RE.test(id || '')) return { http: 400, error: 'MISSING_FIELDS' };
  const { data: site, error } = await supabase.from('sites')
    .select('id, name, company_id, latitude, longitude, geofence_radius_m, status').eq('id', id).maybeSingle();
  if (error) return { http: 500, error: 'DB_ERROR' };
  if (!site || site.status === 'eliminato') return { http: 404, error: 'WORKSITE_NOT_FOUND' };
  if (site.company_id !== companyId) return { http: 403, error: 'COMPANY_MISMATCH' };
  return { site };
}

// Il telefono lo chiede (con la rete) ogni volta che apre la pagina del QR e
// lo tiene da parte: l'ora del server serve poi a capire se l'orologio del
// telefono è stato cambiato.
router.get('/scan/offline-kit', scanLimiter, async (req, res) => {
  try {
    const s = await sessione(req.query.session_token);
    if (s.error) return res.status(s.http).json({ error: s.error });
    const c = await cantiere(req.query.worksite_id, s.worker.company_id);
    if (c.error) return res.status(c.http).json({ error: c.error });
    const { data: last, error } = await supabase.from('presence_logs').select('event_type, timestamp_server, site_id')
      .eq('worker_id', s.worker.id).eq('company_id', s.worker.company_id).order('timestamp_server', { ascending: false }).limit(1);
    if (error) return res.status(500).json({ error: 'DB_ERROR' });
    const open = last?.[0]?.event_type === 'ENTRY';
    res.set('Cache-Control', 'no-store');
    res.json({
      server_now:  Date.now(),
      max_age_ms:  MAX_AGE_MS,
      next_action: open ? 'EXIT' : 'ENTRY',
      open_since:  open ? last[0].timestamp_server : null,
    });
  } catch (err) {
    console.error('[scan-offline-kit] unexpected error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.post('/scan/offline-punch', scanLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    if (!UUID_RE.test(body.client_request_id || '')) return res.status(400).json({ error: 'MISSING_CLIENT_REQUEST_ID' });
    const s = await sessione(body.session_token);
    if (s.error) return res.status(s.http).json({ error: s.error });
    const c = await cantiere(body.worksite_id, s.worker.company_id);
    if (c.error) return res.status(c.http).json({ error: c.error });
    const r = await receiveOfflinePunch({ worker: s.worker, site: c.site, body: { ...body, site_id: c.site.id }, userAgent: req.headers['user-agent'] });
    if (!r.ok) return res.status(r.http).json({ error: r.error });
    res.json({ ok: true, status: r.status, event_type: r.event_type, punched_at: r.punched_at, replayed: r.replayed });
  } catch (err) {
    console.error('[scan-offline-punch] unexpected error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
