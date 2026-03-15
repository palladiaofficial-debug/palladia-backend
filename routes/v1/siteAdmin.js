'use strict';
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog }          = require('../../lib/audit');

// Tutti gli endpoint richiedono JWT + membership verificata
// req.companyId è già stato verificato da verifySupabaseJwt

// ── GET /api/v1/sites — lista cantieri della company ─────────────────────────
router.get('/sites', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('sites')
    .select('id, name, address, status, client, start_date, latitude, longitude, geofence_radius_m')
    .eq('company_id', req.companyId)
    .order('name');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json(data.map(s => ({
    id:                s.id,
    name:              s.name,
    address:           s.address,
    status:            s.status ?? 'attivo',
    client:            s.client,
    startDate:         s.start_date,
    latitude:          s.latitude,
    longitude:         s.longitude,
    geofence_radius_m: s.geofence_radius_m,
    has_geofence:      s.latitude != null && s.longitude != null
  })));
});

// ── PATCH /api/v1/sites/:siteId/coords ───────────────────────────────────────
// Imposta lat/lon e raggio geofence di un cantiere.
// SECURITY: .eq('company_id', req.companyId) garantisce che solo un membro
// della company possa modificare il proprio cantiere.
router.patch('/sites/:siteId/coords', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { latitude, longitude, geofence_radius_m } = req.body;

  if (latitude == null || longitude == null) {
    return res.status(400).json({
      error:    'MISSING_FIELDS',
      required: ['latitude', 'longitude']
    });
  }

  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90  || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'INVALID_COORDS' });
  }

  // Default 100m se non specificato
  const radius = geofence_radius_m != null ? Number(geofence_radius_m) : 100;
  if (!Number.isFinite(radius) || radius < 10 || radius > 50000) {
    return res.status(400).json({
      error:   'INVALID_RADIUS',
      message: 'geofence_radius_m deve essere compreso tra 10 e 50000 metri'
    });
  }

  const { data, error } = await supabase
    .from('sites')
    .update({ latitude: lat, longitude: lon, geofence_radius_m: radius })
    .eq('id', siteId)
    .eq('company_id', req.companyId)   // ownership check
    .select('id, name, latitude, longitude, geofence_radius_m')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'site.coords_set',
    targetType: 'site',
    targetId:   siteId,
    payload:    { latitude: lat, longitude: lon, geofence_radius_m: radius },
    req
  });

  res.json({ ok: true, site: data });
});

// ── POST /api/v1/sites — crea cantiere ───────────────────────────────────────
router.post('/sites', verifySupabaseJwt, async (req, res) => {
  const { name, address, client, start_date, status } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 200) {
    return res.status(400).json({
      error:   'INVALID_NAME',
      message: 'name è obbligatorio (min 2, max 200 caratteri)'
    });
  }

  const allowedStatuses = ['attivo', 'sospeso', 'chiuso'];
  const siteStatus = allowedStatuses.includes(status) ? status : 'attivo';

  const { data, error } = await supabase
    .from('sites')
    .insert({
      name:       name.trim(),
      address:    address ? String(address).trim() : null,
      client:     client  ? String(client).trim()  : null,
      start_date: start_date || null,
      status:     siteStatus,
      company_id: req.companyId
    })
    .select('id, name, address, status, client, start_date, latitude, longitude, geofence_radius_m')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'site.create',
    targetType: 'site',
    targetId:   data.id,
    payload:    { name: data.name, address: data.address },
    req
  });

  res.status(201).json({
    id:                data.id,
    name:              data.name,
    address:           data.address,
    status:            data.status,
    client:            data.client,
    startDate:         data.start_date,
    latitude:          data.latitude,
    longitude:         data.longitude,
    geofence_radius_m: data.geofence_radius_m,
    has_geofence:      data.latitude != null && data.longitude != null
  });
});

// ── DELETE /api/v1/sites/:siteId — elimina cantiere (solo se nessun log) ─────
router.delete('/sites/:siteId', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  // Verifica ownership
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  // Controlla se esistono log di presenza
  const { count, error: logErr } = await supabase
    .from('presence_logs')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .eq('company_id', req.companyId);

  if (logErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (count > 0) {
    return res.status(409).json({
      error:   'SITE_HAS_LOGS',
      message: `Impossibile eliminare: il cantiere ha ${count} timbrature registrate`
    });
  }

  const { error: delErr } = await supabase
    .from('sites')
    .delete()
    .eq('id', siteId)
    .eq('company_id', req.companyId);

  if (delErr) return res.status(500).json({ error: 'DB_ERROR', message: delErr.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'site.delete',
    targetType: 'site',
    targetId:   siteId,
    payload:    { name: site.name },
    req
  });

  res.json({ ok: true });
});

module.exports = router;
