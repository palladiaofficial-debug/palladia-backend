'use strict';
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog }          = require('../../lib/audit');
const { getSiteLimit }      = require('../../services/stripe');
const { calcEndDate }       = require('../../lib/calcEndDate');

// Tutti gli endpoint richiedono JWT + membership verificata
// req.companyId è già stato verificato da verifySupabaseJwt

function formatSite(s) {
  return {
    id:                        s.id,
    name:                      s.name,
    address:                   s.address,
    comune:                    s.comune ?? null,
    status:                    s.status ?? 'attivo',
    client:                    s.client,
    startDate:                 s.start_date,
    endDate:                   s.end_date,
    contractDays:              s.contract_days,
    daysType:                  s.days_type ?? 'solari',
    referenteTecnicoId:        s.referente_tecnico_id,
    referenteTecnicoName:      s.referente_tecnico_name,
    suoloOccupazione:          s.suolo_occupazione ?? false,
    suoloOccupazioneStart:     s.suolo_occupazione_start,
    suoloOccupazioneEnd:       s.suolo_occupazione_end,
    suoloOccupazioneNotes:     s.suolo_occupazione_notes,
    latitude:                  s.latitude,
    longitude:                 s.longitude,
    geofence_radius_m:         s.geofence_radius_m,
    has_geofence:              s.latitude != null && s.longitude != null,
  };
}

// Status operativi (visibili in dashboard, pesano sul limite piano)
const ACTIVE_STATUSES   = ['attivo', 'sospeso'];
// Status che contano nel limite abbonamento
const BILLABLE_STATUSES = ['attivo', 'sospeso'];
// Tutti i valori ammessi (escluso 'eliminato' — solo via DELETE)
const ALLOWED_STATUSES  = ['attivo', 'sospeso', 'ultimato', 'chiuso'];

// ── GET /api/v1/sites — lista cantieri della company ─────────────────────────
// Esclude sempre i cantieri con status 'eliminato' (soft-deleted)
router.get('/sites', verifySupabaseJwt, async (req, res) => {
  const SELECT_COLS = 'id, name, address, comune, status, client, start_date, end_date, latitude, longitude, geofence_radius_m, contract_days, days_type, referente_tecnico_id, referente_tecnico_name, suolo_occupazione, suolo_occupazione_start, suolo_occupazione_end, suolo_occupazione_notes';

  const { data, error } = await supabase
    .from('sites')
    .select(SELECT_COLS)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .order('name');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json(data.map(formatSite));
});

// ── GET /api/v1/sites/deleted — lista cantieri eliminati (cestino) ────────────
router.get('/sites/deleted', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('sites')
    .select('id, name, address, status, client, start_date')
    .eq('company_id', req.companyId)
    .eq('status', 'eliminato')
    .order('name');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json(data.map(s => ({
    id:        s.id,
    name:      s.name,
    address:   s.address ?? '',
    status:    'eliminato',
    client:    s.client,
    startDate: s.start_date,
  })));
});

// ── POST /api/v1/sites/:siteId/restore — ripristina cantiere eliminato ────────
router.post('/sites/:siteId/restore', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, status')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .eq('status', 'eliminato')
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_NOT_DELETED' });

  // Ripristina a 'chiuso' (stato neutro, non pesa sul limite piano)
  const { data, error } = await supabase
    .from('sites')
    .update({ status: 'chiuso' })
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .select('id, name, address, status, client, start_date')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'site.restore',
    targetType: 'site',
    targetId:   siteId,
    payload:    { name: site.name, restored_to: 'chiuso' },
    req,
  });

  res.json({
    id:        data.id,
    name:      data.name,
    address:   data.address ?? '',
    status:    data.status,
    client:    data.client,
    startDate: data.start_date,
  });
});

// ── PATCH /api/v1/sites/:siteId — aggiorna campi e/o stato del cantiere ───────
router.patch('/sites/:siteId', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const {
    name, address, comune, client, status,
    start_date, end_date,
    contract_days, days_type,
    referente_tecnico_id, referente_tecnico_name,
    suolo_occupazione, suolo_occupazione_start, suolo_occupazione_end, suolo_occupazione_notes,
  } = req.body || {};

  // Verifica ownership + recupera valori esistenti come fallback per il calcolo end_date
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, status, start_date, contract_days, days_type, comune')
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
  if (address !== undefined) updates.address = address ? String(address).trim() : null;
  if (comune  !== undefined) updates.comune  = comune  ? String(comune).trim()  : null;
  if (client  !== undefined) updates.client  = client  ? String(client).trim()  : null;

  if (contract_days !== undefined) updates.contract_days = contract_days ? Number(contract_days) : null;
  if (days_type     !== undefined) updates.days_type     = days_type === 'lavorativi' ? 'lavorativi' : 'solari';

  if (referente_tecnico_id !== undefined) {
    if (referente_tecnico_id) {
      const { data: member } = await supabase
        .from('company_users')
        .select('user_id')
        .eq('company_id', req.companyId)
        .eq('user_id', referente_tecnico_id)
        .maybeSingle();
      if (!member) return res.status(400).json({ error: 'INVALID_REFERENTE', message: 'referente_tecnico_id non appartiene al team.' });
      // Nome derivato automaticamente dal profilo auth — non accettato dal client
      const { data: authData } = await supabase.auth.admin.getUserById(referente_tecnico_id);
      const u = authData?.user;
      updates.referente_tecnico_name = u?.user_metadata?.full_name || u?.email || null;
    } else {
      updates.referente_tecnico_name = null;
    }
    updates.referente_tecnico_id = referente_tecnico_id || null;
  }

  if (suolo_occupazione       !== undefined) updates.suolo_occupazione       = Boolean(suolo_occupazione);
  if (suolo_occupazione_start !== undefined) updates.suolo_occupazione_start = suolo_occupazione_start || null;
  if (suolo_occupazione_end   !== undefined) updates.suolo_occupazione_end   = suolo_occupazione_end   || null;
  if (suolo_occupazione_notes !== undefined) updates.suolo_occupazione_notes = suolo_occupazione_notes || null;

  if (start_date !== undefined) updates.start_date = start_date || null;

  // Calcola end_date dai giorni contratto con fallback ai valori già salvati nel DB
  const effectiveStartDate    = updates.start_date    ?? site.start_date    ?? null;
  const effectiveContractDays = updates.contract_days ?? site.contract_days ?? null;
  const effectiveDaysType     = updates.days_type     ?? site.days_type     ?? 'solari';
  const effectiveComune       = updates.comune        ?? site.comune        ?? null;

  if (effectiveStartDate && effectiveContractDays) {
    const { data: suspRows } = await supabase
      .from('site_suspension_days')
      .select('day')
      .eq('site_id', siteId);
    const suspDays = (suspRows || []).map(r => r.day);
    updates.end_date = calcEndDate(effectiveStartDate, effectiveContractDays, effectiveDaysType, suspDays, effectiveComune);
  } else if (end_date !== undefined) {
    updates.end_date = end_date || null;
  }

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

  const SELECT_COLS_PATCH = 'id, name, address, status, client, start_date, end_date, latitude, longitude, geofence_radius_m, contract_days, days_type, referente_tecnico_id, referente_tecnico_name, suolo_occupazione, suolo_occupazione_start, suolo_occupazione_end, suolo_occupazione_notes';

  const { data, error } = await supabase
    .from('sites')
    .update(updates)
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .select(SELECT_COLS_PATCH)
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

  res.json(formatSite(data));
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
  const {
    name, address, comune, client, status,
    start_date, end_date,
    contract_days, days_type,
    referente_tecnico_id,
    suolo_occupazione, suolo_occupazione_start, suolo_occupazione_end, suolo_occupazione_notes,
  } = req.body || {};

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

  const siteStatus   = ALLOWED_STATUSES.includes(status) ? status : 'attivo';
  const contractDays = contract_days ? Number(contract_days) : null;
  const daysTypeVal  = days_type === 'lavorativi' ? 'lavorativi' : 'solari';

  // Valida referente e deriva il nome dal profilo auth
  let referenteName = null;
  if (referente_tecnico_id) {
    const { data: member } = await supabase
      .from('company_users')
      .select('user_id')
      .eq('company_id', req.companyId)
      .eq('user_id', referente_tecnico_id)
      .maybeSingle();
    if (!member) return res.status(400).json({ error: 'INVALID_REFERENTE', message: 'referente_tecnico_id non appartiene al team.' });
    const { data: authData } = await supabase.auth.admin.getUserById(referente_tecnico_id);
    const u = authData?.user;
    referenteName = u?.user_metadata?.full_name || u?.email || null;
  }

  // Calcola end_date dai giorni contratto se non passata esplicitamente
  const comuneVal = comune ? String(comune).trim() : null;
  let computedEndDate = end_date || null;
  if (!computedEndDate && start_date && contractDays) {
    computedEndDate = calcEndDate(start_date, contractDays, daysTypeVal, [], comuneVal);
  }

  const { data, error } = await supabase
    .from('sites')
    .insert({
      name:       name.trim(),
      address:    address ? String(address).trim() : null,
      comune:     comuneVal,
      client:     client  ? String(client).trim()  : null,
      start_date: start_date || null,
      end_date:   computedEndDate,
      status:     siteStatus,
      company_id: req.companyId,
      contract_days:             contractDays,
      days_type:                 daysTypeVal,
      referente_tecnico_id:      referente_tecnico_id || null,
      referente_tecnico_name:    referenteName,
      suolo_occupazione:         suolo_occupazione         ?? false,
      suolo_occupazione_start:   suolo_occupazione_start   || null,
      suolo_occupazione_end:     suolo_occupazione_end     || null,
      suolo_occupazione_notes:   suolo_occupazione_notes   || null,
    })
    .select('id, name, address, comune, status, client, start_date, end_date, latitude, longitude, geofence_radius_m, contract_days, days_type, referente_tecnico_id, referente_tecnico_name, suolo_occupazione, suolo_occupazione_start, suolo_occupazione_end, suolo_occupazione_notes')
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

  res.status(201).json(formatSite(data));
});

// ── POST /api/v1/sites/:siteId/duplicate — duplica cantiere ──────────────────
router.post('/sites/:siteId/duplicate', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { name } = req.body || {};

  const { data: orig, error: origErr } = await supabase
    .from('sites')
    .select('*')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .neq('status', 'eliminato')
    .maybeSingle();

  if (origErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!orig)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  // Controllo limite piano
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
      .in('status', BILLABLE_STATUSES);
    if (cntErr) return res.status(500).json({ error: 'DB_ERROR' });
    if (count >= siteLimit) {
      return res.status(403).json({
        error:      'SITE_LIMIT_REACHED',
        message:    `Il tuo piano consente massimo ${siteLimit} cantieri attivi.`,
        site_limit: siteLimit,
        current:    count,
      });
    }
  }

  const newName = name?.trim() || `${orig.name} (copia)`;

  const { data, error } = await supabase
    .from('sites')
    .insert({
      company_id:                req.companyId,
      name:                      newName,
      address:                   orig.address,
      client:                    orig.client,
      status:                    'attivo',
      start_date:                orig.start_date,
      end_date:                  orig.end_date,
      contract_days:             orig.contract_days,
      days_type:                 orig.days_type,
      referente_tecnico_id:      orig.referente_tecnico_id,
      referente_tecnico_name:    orig.referente_tecnico_name,
      latitude:                  orig.latitude,
      longitude:                 orig.longitude,
      geofence_radius_m:         orig.geofence_radius_m,
      suolo_occupazione:         orig.suolo_occupazione,
      suolo_occupazione_start:   orig.suolo_occupazione_start,
      suolo_occupazione_end:     orig.suolo_occupazione_end,
      suolo_occupazione_notes:   orig.suolo_occupazione_notes,
    })
    .select('id, name, address, status, client, start_date, end_date, latitude, longitude, geofence_radius_m, contract_days, days_type, referente_tecnico_id, referente_tecnico_name, suolo_occupazione, suolo_occupazione_start, suolo_occupazione_end, suolo_occupazione_notes')
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'site.duplicate',
    targetType: 'site',
    targetId:   data.id,
    payload:    { source_id: siteId, name: data.name },
    req,
  });

  res.status(201).json(formatSite(data));
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
