'use strict';
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog }          = require('../../lib/audit');
const { getSiteLimit }      = require('../../services/stripe');

// Tutti gli endpoint richiedono JWT + membership verificata
// req.companyId è già stato verificato da verifySupabaseJwt

// Status operativi (visibili in dashboard, pesano sul limite piano)
const ACTIVE_STATUSES   = ['attivo', 'sospeso'];
// Status che contano nel limite abbonamento
const BILLABLE_STATUSES = ['attivo', 'sospeso'];
// Tutti i valori ammessi (escluso 'eliminato' — solo via DELETE)
const ALLOWED_STATUSES  = ['attivo', 'sospeso', 'ultimato', 'chiuso'];

// ── GET /api/v1/sites — lista cantieri della company ─────────────────────────
// Esclude sempre i cantieri con status 'eliminato' (soft-deleted)
router.get('/sites', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('sites')
    .select('id, name, address, status, client, start_date, latitude, longitude, geofence_radius_m')
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
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

// ── PATCH /api/v1/sites/:siteId — aggiorna campi e/o stato del cantiere ───────
router.patch('/sites/:siteId', verifySupabaseJwt, async (req, res) => {
  const { siteId }    = req.params;
  const { name, address, client, start_date, status } = req.body || {};

  // Verifica ownership + non eliminato
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, status')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  const updates = {};

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (trimmed.length < 2 || trimmed.length > 200) {
      return res.status(400).json({ error: 'INVALID_NAME', message: 'name: min 2, max 200 caratteri.' });
    }
    updates.name = trimmed;
  }
  if (address    !== undefined) updates.address    = address    ? String(address).trim()    : null;
  if (client     !== undefined) updates.client     = client     ? String(client).trim()     : null;
  if (start_date !== undefined) updates.start_date = start_date || null;

  if (status !== undefined) {
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        error:   'INVALID_STATUS',
        allowed: ALLOWED_STATUSES,
      });
    }

    // Se si sta riattivando un cantiere (es. da sospeso → attivo), ri-controlla il limite
    const wasNotBillable = !BILLABLE_STATUSES.includes(site.status);
    const becomingBillable = BILLABLE_STATUSES.includes(status);

    if (wasNotBillable && becomingBillable) {
      const { data: company } = await supabase
        .from('companies')
        .select('subscription_plan, subscription_status, trial_ends_at')
        .eq('id', req.companyId)
        .single();

      if (company) {
        const now = Date.now();
        const trialExpired = company.subscription_status === 'trial' &&
          company.trial_ends_at && new Date(company.trial_ends_at).getTime() < now;
        const effectivePlan = trialExpired ? 'trial' : company.subscription_plan;
        const siteLimit = getSiteLimit(effectivePlan);

        if (siteLimit !== null) {
          const { count } = await supabase
            .from('sites')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', req.companyId)
            .in('status', BILLABLE_STATUSES)
            .neq('id', siteId); // escludi il cantiere corrente dal conteggio

          if (count >= siteLimit) {
            return res.status(403).json({
              error:      'SITE_LIMIT_REACHED',
              message:    `Il tuo piano consente massimo ${siteLimit} cantieri attivi. Aggiorna il piano.`,
              site_limit: siteLimit,
              current:    count,
            });
          }
        }
      }
    }

    updates.status = status;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'NO_FIELDS', message: 'Nessun campo da aggiornare.' });
  }

  const { data, error } = await supabase
    .from('sites')
    .update(updates)
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .select('id, name, address, status, client, start_date, latitude, longitude, geofence_radius_m')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'site.update',
    targetType: 'site',
    targetId:   siteId,
    payload:    updates,
    req,
  });

  res.json({
    id:                data.id,
    name:              data.name,
    address:           data.address,
    status:            data.status,
    client:            data.client,
    startDate:         data.start_date,
    latitude:          data.latitude,
    longitude:         data.longitude,
    geofence_radius_m: data.geofence_radius_m,
    has_geofence:      data.latitude != null && data.longitude != null,
  });
});

// ── PATCH /api/v1/sites/:siteId/coords ───────────────────────────────────────
// Imposta lat/lon e raggio geofence di un cantiere.
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
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
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

  // ── Controllo limite cantieri per piano ──────────────────────────────────
  const { data: company, error: compErr } = await supabase
    .from('companies')
    .select('subscription_plan, subscription_status, trial_ends_at')
    .eq('id', req.companyId)
    .single();

  if (compErr || !company) return res.status(500).json({ error: 'DB_ERROR' });

  const now = Date.now();
  const trialExpired = company.subscription_status === 'trial' &&
    company.trial_ends_at && new Date(company.trial_ends_at).getTime() < now;
  const effectivePlan = trialExpired ? 'trial' : company.subscription_plan;
  const siteLimit = getSiteLimit(effectivePlan);

  if (siteLimit !== null) {
    const { count, error: cntErr } = await supabase
      .from('sites')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', req.companyId)
      .in('status', BILLABLE_STATUSES);  // solo attivo + sospeso pesano sul limite

    if (cntErr) return res.status(500).json({ error: 'DB_ERROR' });

    if (count >= siteLimit) {
      return res.status(403).json({
        error:      'SITE_LIMIT_REACHED',
        message:    `Il tuo piano (${effectivePlan}) consente massimo ${siteLimit} cantieri attivi. Archivia o ultime un cantiere, oppure aggiorna il piano.`,
        site_limit: siteLimit,
        current:    count,
      });
    }
  }

  const siteStatus = ALLOWED_STATUSES.includes(status) ? status : 'attivo';

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

// ── DELETE /api/v1/sites/:siteId ──────────────────────────────────────────────
// • Nessun log di presenza → hard delete (rimuove tutto dal DB)
// • Ha log di presenza    → soft delete (status = 'eliminato', dati storici preservati)
//   Questo rispetta il vincolo append-only su presence_logs.
router.delete('/sites/:siteId', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  // Verifica ownership
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, status')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  if (site.status === 'eliminato') {
    return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });
  }

  // Controlla se esistono log di presenza
  const { count, error: logErr } = await supabase
    .from('presence_logs')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .eq('company_id', req.companyId);

  if (logErr) return res.status(500).json({ error: 'DB_ERROR' });

  if (count > 0) {
    // Soft delete — preserva dati storici
    const { error: softErr } = await supabase
      .from('sites')
      .update({ status: 'eliminato' })
      .eq('id', siteId)
      .eq('company_id', req.companyId);

    if (softErr) return res.status(500).json({ error: 'DB_ERROR', message: softErr.message });

    auditLog({
      companyId:  req.companyId,
      userId:     req.user?.id,
      userRole:   req.userRole,
      action:     'site.soft_delete',
      targetType: 'site',
      targetId:   siteId,
      payload:    { name: site.name, presence_logs: count },
      req,
    });

    return res.json({ ok: true, method: 'soft_delete', message: `Il cantiere aveva ${count} timbrature: i dati storici sono stati preservati.` });
  }

  // Hard delete — nessun log, rimuove tutto
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
    req,
  });

  res.json({ ok: true, method: 'hard_delete' });
});

module.exports = router;
