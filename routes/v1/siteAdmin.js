'use strict';
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { hashPin }           = require('../../lib/pinHash');

// Tutti gli endpoint richiedono JWT + membership verificata
// req.companyId è già stato verificato da verifySupabaseJwt

// ── GET /api/v1/sites — lista cantieri della company ─────────────────────────
router.get('/sites', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('sites')
    .select('id, name, address, latitude, longitude, geofence_radius_m, pin_hash')
    .eq('company_id', req.companyId)
    .order('name');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json(data.map(s => ({
    id:                s.id,
    name:              s.name,
    address:           s.address,
    latitude:          s.latitude,
    longitude:         s.longitude,
    geofence_radius_m: s.geofence_radius_m,
    has_pin:           !!s.pin_hash,
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

  res.json({ ok: true, site: data });
});

// ── PATCH /api/v1/sites/:siteId/pin ──────────────────────────────────────────
// Imposta (o rimuove) il PIN di accesso al cantiere.
// body.pin_code = stringa non vuota → imposta PIN (salvato come HMAC-SHA256)
// body.pin_code = '' o null        → rimuove il PIN (cantiere senza PIN)
router.patch('/sites/:siteId/pin', verifySupabaseJwt, async (req, res) => {
  const { siteId }  = req.params;
  const { pin_code } = req.body;

  let pin_hash = null;
  if (pin_code != null && String(pin_code).trim().length > 0) {
    try {
      pin_hash = hashPin(String(pin_code));
    } catch (e) {
      return res.status(500).json({ error: 'PIN_HASH_ERROR', message: e.message });
    }
  }

  const { data, error } = await supabase
    .from('sites')
    .update({ pin_hash })
    .eq('id', siteId)
    .eq('company_id', req.companyId)   // ownership check
    .select('id, name')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  res.json({
    ok:      true,
    has_pin: pin_hash !== null,
    site:    { id: data.id, name: data.name }
  });
});

module.exports = router;
