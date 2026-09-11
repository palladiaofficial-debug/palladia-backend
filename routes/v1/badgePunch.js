'use strict';
// ── Badge Punch Routes ─────────────────────────────────────────────────────────
// Timbratura tramite badge personale del lavoratore.
//
// Il badge QR punta a /timbratura/{badge_code} → badge-punch.html.
// Il lavoratore non deve identificarsi con il CF: il badge_code è la sua identità.
//
// Endpoint PUBBLICI (autenticati via badge_code):
//   GET  /api/v1/badge/:code/punch-context     → lavoratore + cantieri disponibili + GPS match
//   POST /api/v1/badge/:code/punch             → registra ENTRY/EXIT (worker_self_punch)
//   POST /api/v1/badge/:code/help-request      → avvisa l'amministratore, un tap (F-171)
//
// Endpoint PRIVATI (JWT):
//   POST /api/v1/badge/:code/revoke            → disattiva lavoratore (badge inutilizzabile)
//   POST /api/v1/badge/:code/regenerate        → genera nuovo badge_code (vecchio link invalido)
//   POST /api/v1/badge/capocantiere-punch      → capocantiere registra per conto di un lavoratore
// ──────────────────────────────────────────────────────────────────────────────

const crypto    = require('crypto');
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt }  = require('../../middleware/verifyJwt');
const { notifyPunch, notifyRejectedGeofencePunch, notifyExpiredComplianceAtPunch, notifyPunchHelpRequest } = require('../../services/telegramNotifications');
const { badgePunchLimiter }  = require('../../middleware/rateLimit');
const { complianceStatus }   = require('../../lib/compliance');

// F-145 (AUDIT.md): limiter dedicato, chiave IP+badge_code (non solo IP come
// il publicScanLimiter che riusava prima) — vedi middleware/rateLimit.js.

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversineM(lat1, lon1, lat2, lon2) {
  const R     = 6_371_000;
  const toRad = d => d * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isValidCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90  && lat <= 90
      && lon >= -180 && lon <= 180;
}

function isValidBadgeCode(code) {
  return typeof code === 'string' && /^[A-Fa-f0-9]{18}$/.test(code);
}

const GPS_MAX_ACCURACY_M = (() => {
  const v = Number(process.env.GPS_MAX_ACCURACY_M);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();

// ── GET /api/v1/badge/:code/punch-context — PUBBLICO ─────────────────────────
// Risolve il badge_code → lavoratore + lista cantieri assegnati + match GPS.
// Usato dal frontend badge-punch.html per capire quale cantiere mostrare.
//
// Query params opzionali:
//   lat, lon  — posizione GPS del lavoratore (per auto-select cantiere in geofence)
router.get('/badge/:code/punch-context', badgePunchLimiter, async (req, res) => {
  try {
  const { code } = req.params;

  if (!isValidBadgeCode(code)) {
    return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  }

  const lat = req.query.lat ? Number(req.query.lat) : null;
  const lon = req.query.lon ? Number(req.query.lon) : null;
  const hasGps = lat !== null && lon !== null && isValidCoords(lat, lon);

  // Risolvi badge → lavoratore
  const { data: worker, error: workerErr } = await supabase
    .from('workers')
    .select('id, full_name, is_active, company_id, photo_url')
    .eq('badge_code', code.toUpperCase())
    .maybeSingle();

  if (workerErr) {
    console.error('[badge-punch-context] worker query error:', workerErr.message, workerErr.details);
    return res.status(500).json({ error: 'DB_ERROR', hint: workerErr.message });
  }
  if (!worker) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
  if (!worker.is_active) return res.status(403).json({ error: 'BADGE_REVOKED' });

  // Tutti i cantieri attivi (non chiusi/eliminati) della company del
  // lavoratore — sempre, indipendentemente da eventuali righe in
  // `worksite_workers`. F-16x (AUDIT.md, 2026-09-11): prima di questo fix la
  // lista veniva filtrata alle sole assegnazioni quando il lavoratore ne
  // aveva almeno una valida, col fallback alla lista intera solo a ZERO
  // assegnazioni valide (introdotto da F-150 per il solo caso di riga stale
  // cross-company/eliminata) — un lavoratore con 2 assegnazioni legittime ma
  // che si sposta su un terzo cantiere restava bloccato, non vedendo mai il
  // fallback. Richiesta esplicita e ripetuta dell'utente: ogni lavoratore
  // deve vedere e poter timbrare su QUALSIASI cantiere attivo dell'azienda,
  // ingresso e uscita anche su cantieri diversi nello stesso giorno —
  // `worksite_workers` non deve mai restringere questa lista.
  const { data: sitesRows, error: sitesErr } = await supabase
    .from('sites')
    .select('id, name, address, latitude, longitude, geofence_radius_m, status')
    .eq('company_id', worker.company_id)
    .not('status', 'in', '(chiuso,eliminato)');

  if (sitesErr) {
    console.error('[badge-punch-context] sites error:', sitesErr.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }
  const activeSites = sitesRows || [];

  // F-172 (AUDIT.md): stesso worker, stesso stato "aperto/chiuso" GLOBALE
  // (migrations/201, punch_atomic) — next_action non è più deciso guardando
  // l'ultimo evento per-singolo-cantiere (portava a mostrare "ENTRATA" su un
  // cantiere mai toccato anche quando il lavoratore era già aperto altrove,
  // es. entrato al cantiere e in uscita dal magazzino). Un solo evento
  // globale decide il next_action per TUTTI i cantieri della lista.
  const { data: globalLastLog } = await supabase
    .from('presence_logs')
    .select('event_type, timestamp_server, site_id')
    .eq('worker_id', worker.id)
    .eq('company_id', worker.company_id)
    .order('timestamp_server', { ascending: false })
    .limit(1)
    .maybeSingle();

  const isOpenGlobally = globalLastLog?.event_type === 'ENTRY';
  const openSiteId     = isOpenGlobally ? globalLastLog.site_id : null;
  const nextActionGlobal = isOpenGlobally ? 'EXIT' : 'ENTRY';

  // Per ogni cantiere: distanza GPS + ultimo evento SU QUEL cantiere (solo
  // informativo, per lo storico — non decide più next_action)
  let siteData;
  try {
  siteData = await Promise.all(activeSites.map(async (site) => {
    let distanceM   = null;
    let inGeofence  = false;

    if (hasGps && site.latitude != null && site.longitude != null) {
      distanceM  = Math.round(haversineM(lat, lon, site.latitude, site.longitude));
      // Se geofence_radius_m è null il cantiere non ha enforcement → sempre "in geofence"
      inGeofence = site.geofence_radius_m == null || distanceM <= site.geofence_radius_m;
    } else if (hasGps) {
      // Cantiere senza coordinate GPS → nessun check possibile → includi nell'auto-select
      inGeofence = true;
    }

    const { data: lastLog } = await supabase
      .from('presence_logs')
      .select('event_type, timestamp_server')
      .eq('worker_id', worker.id)
      .eq('site_id', site.id)
      .order('timestamp_server', { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      site_id:           site.id,
      site_name:         site.name,
      address:           site.address || null,
      distance_m:        distanceM,
      in_geofence:       inGeofence,
      has_geofence:      site.latitude != null,
      geofence_radius_m: site.geofence_radius_m,
      last_event_type:   lastLog?.event_type || null,
      last_timestamp:    lastLog?.timestamp_server || null,
      next_action:       nextActionGlobal,
      is_open_here:      isOpenGlobally && site.id === openSiteId,
    };
  }));
  } catch (e) {
    console.error('[badge-punch-context] parallel query error:', e.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  // Ordina per distanza: prima i più vicini, null in fondo
  siteData.sort((a, b) => {
    if (a.distance_m === null && b.distance_m === null) return 0;
    if (a.distance_m === null) return 1;
    if (b.distance_m === null) return -1;
    return a.distance_m - b.distance_m;
  });

  // Auto-select logic:
  // 1. Un solo cantiere in geofence → auto-select
  // 2. Nessun GPS ma un solo cantiere assegnato → auto-select
  let autoSelectedSiteId = null;
  const inGeofenceSites  = siteData.filter(s => s.in_geofence);

  if (inGeofenceSites.length === 1) {
    autoSelectedSiteId = inGeofenceSites[0].site_id;
  } else if (!hasGps && siteData.length === 1) {
    autoSelectedSiteId = siteData[0].site_id;
  } else if (siteData.length === 1) {
    autoSelectedSiteId = siteData[0].site_id;
  }

  res.json({
    worker_id:             worker.id,
    worker_name:           worker.full_name,
    worker_initial:        (worker.full_name || '?').trim().charAt(0).toUpperCase(),
    photo_url:             worker.photo_url || null,
    is_active:             worker.is_active,
    sites:                 siteData,
    auto_selected_site_id: autoSelectedSiteId,
    max_gps_accuracy_m:    GPS_MAX_ACCURACY_M,
    open_site_id:          openSiteId,
    open_since:            isOpenGlobally ? globalLastLog.timestamp_server : null,
  });

  } catch (err) {
    console.error('[badge-punch-context] unexpected error:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── POST /api/v1/badge/:code/punch — PUBBLICO ─────────────────────────────────
// Registra ENTRY/EXIT tramite badge personale del lavoratore.
// Nessun session token: il badge_code è la prova di identità.
router.post('/badge/:code/punch', badgePunchLimiter, async (req, res) => {
  try {
  const { code }                                    = req.params;
  const { site_id, latitude, longitude, gps_accuracy_m } = req.body;

  if (!isValidBadgeCode(code)) {
    return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  }
  if (!site_id) {
    return res.status(400).json({ error: 'MISSING_FIELDS', required: ['site_id'] });
  }

  // GPS obbligatorio
  if (latitude == null || longitude == null) {
    return res.status(422).json({ error: 'GPS_REQUIRED' });
  }
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!isValidCoords(lat, lon)) {
    return res.status(400).json({ error: 'INVALID_COORDS' });
  }

  // GPS accuracy (soft check — il server rifiuta se troppo bassa)
  let accuracyM = null;
  if (gps_accuracy_m != null) {
    const parsed = Number(gps_accuracy_m);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 5000) {
      if (parsed > GPS_MAX_ACCURACY_M) {
        return res.status(422).json({
          error:          'GPS_ACCURACY_TOO_LOW',
          accuracy_m:     Math.round(parsed),
          max_accuracy_m: GPS_MAX_ACCURACY_M,
        });
      }
      accuracyM = parsed;
    }
  }

  // Risolvi badge → lavoratore
  const { data: worker, error: workerErr } = await supabase
    .from('workers')
    .select('id, full_name, is_active, company_id, safety_training_expiry, health_fitness_expiry')
    .eq('badge_code', code.toUpperCase())
    .maybeSingle();

  if (workerErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker)          return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
  if (!worker.is_active) return res.status(403).json({ error: 'BADGE_REVOKED' });

  // Carica cantiere + verifica stessa company
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, company_id, latitude, longitude, geofence_radius_m')
    .eq('id', site_id)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });
  if (site.company_id !== worker.company_id) {
    return res.status(403).json({ error: 'COMPANY_MISMATCH' });
  }

  // Verifica o auto-crea associazione worker ↔ cantiere
  // Coerente con il flusso QR scan (identify auto-assegna).
  // Blocca solo se l'associazione esiste ma è esplicitamente inactive.
  const { data: assoc } = await supabase
    .from('worksite_workers')
    .select('status')
    .eq('site_id', site_id)
    .eq('worker_id', worker.id)
    .maybeSingle();

  if (assoc && assoc.status !== 'active') {
    return res.status(403).json({ error: 'WORKER_NOT_AUTHORIZED_ON_SITE' });
  }
  if (!assoc) {
    const { error: assocErr } = await supabase
      .from('worksite_workers')
      .insert([{ company_id: worker.company_id, site_id, worker_id: worker.id, status: 'active' }]);
    if (assocErr && assocErr.code !== '23505') {
      console.error('[badge-punch] auto-assoc error:', assocErr.message);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  }

  // Geofence check — se il cantiere non ha coordinate, segnalato con
  // geofenceActive:false invece di restare silenzioso (vedi routes/v1/scan.js)
  let distanceM = null;
  const geofenceActive = site.latitude != null && site.longitude != null;
  if (geofenceActive) {
    distanceM = Math.round(haversineM(lat, lon, site.latitude, site.longitude));
    if (site.geofence_radius_m != null && distanceM > site.geofence_radius_m) {
      // F-138 (AUDIT.md): il tentativo viene rifiutato ma non deve restare
      // invisibile all'amministratore — audit trail + notifica, stesso canale
      // già usato per le timbrature riuscite.
      supabase.from('admin_audit_log').insert([{
        company_id:  worker.company_id,
        user_id:     null,
        user_role:   'worker_badge',
        action:      'punch.rejected_geofence',
        target_type: 'worker',
        target_id:   worker.id,
        payload:     { site_id, site_name: site.name, distance_m: distanceM, max_allowed_m: site.geofence_radius_m },
        ip:          (req.ip || '').slice(0, 45) || null,
        user_agent:  (req.headers['user-agent'] || '').slice(0, 500) || null,
      }]).then(({ error }) => { if (error) console.error('[badge-punch] audit log rejected_geofence error:', error.message); });

      notifyRejectedGeofencePunch(worker.company_id, site_id, site.name, worker.full_name, distanceM, site.geofence_radius_m)
        .catch(e => console.error('[badge-punch] notifyRejectedGeofencePunch error:', e.message));

      return res.status(403).json({
        error:         'OUTSIDE_GEOFENCE',
        distance_m:    distanceM,
        max_allowed_m: site.geofence_radius_m,
      });
    }
  }

  const ipAddress = (req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '').slice(0, 45) || null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500) || null;

  // Punch atomico — method = worker_self_punch, session_id = null
  const { data: punchResult, error: punchErr } = await supabase.rpc('punch_atomic', {
    p_site_id:    site_id,
    p_worker_id:  worker.id,
    p_company_id: worker.company_id,
    p_session_id: null,
    p_lat:        lat,
    p_lon:        lon,
    p_distance_m: distanceM,
    p_accuracy_m: accuracyM,
    p_ip:         ipAddress,
    p_ua:         userAgent,
    p_method:     'worker_self_punch',
  });

  if (punchErr) {
    console.error('[badge-punch] rpc error:', punchErr.message);
    return res.status(500).json({ error: 'LOG_WRITE_ERROR' });
  }

  if (!punchResult || !punchResult.ok) {
    if (punchResult?.error === 'PUNCH_TOO_SOON') {
      return res.status(429).json({
        error:            'PUNCH_TOO_SOON',
        retry_after_secs: punchResult.retry_after_secs,
      });
    }
    return res.status(500).json({ error: 'PUNCH_ERROR' });
  }

  const eventType = punchResult.event_type;
  const tsServer  = punchResult.timestamp_server;

  // F-172 (AUDIT.md): con la decisione ENTRY/EXIT ora globale per lavoratore
  // (non più per singolo cantiere), un'uscita può chiudere un'apertura su un
  // cantiere DIVERSO da quello toccato (es. entrato al cantiere, esce dal
  // magazzino) — punch_atomic (migrations/201) restituisce esplicitamente
  // closed_site_id in quel caso: mai far credere che la timbratura sia
  // avvenuta sul cantiere toccato quando in realtà ha chiuso quello originale.
  let effectiveSiteId   = site_id;
  let effectiveSiteName = site.name;
  if (punchResult.closed_site_id && punchResult.closed_site_id !== site_id) {
    const { data: closedSite } = await supabase
      .from('sites').select('name').eq('id', punchResult.closed_site_id).maybeSingle();
    effectiveSiteId   = punchResult.closed_site_id;
    effectiveSiteName = closedSite?.name || effectiveSiteName;
  }

  // F-139 (AUDIT.md): la timbratura non viene bloccata da un documento scaduto
  // (policy scelta) — ma su un'ENTRY lo segnaliamo all'operaio nella risposta
  // stessa e all'amministratore via notifica, invece di lasciarlo passare in
  // silenzio come accadeva prima di questo fix.
  let complianceWarning = null;
  if (eventType === 'ENTRY') {
    const expiredFields = [];
    if (complianceStatus(worker.safety_training_expiry) === 'expired') expiredFields.push('safety_training');
    if (complianceStatus(worker.health_fitness_expiry)  === 'expired') expiredFields.push('health_fitness');

    if (expiredFields.length > 0) {
      complianceWarning = { expired: expiredFields };

      supabase.from('admin_audit_log').insert([{
        company_id:  worker.company_id,
        user_id:     null,
        user_role:   'worker_badge',
        action:      'punch.expired_compliance',
        target_type: 'worker',
        target_id:   worker.id,
        payload:     { site_id, site_name: site.name, expired: expiredFields },
        ip:          ipAddress,
        user_agent:  userAgent,
      }]).then(({ error }) => { if (error) console.error('[badge-punch] audit log expired_compliance error:', error.message); });

      notifyExpiredComplianceAtPunch(worker.company_id, site_id, site.name, worker.full_name, expiredFields)
        .catch(e => console.error('[badge-punch] notifyExpiredComplianceAtPunch error:', e.message));
    }
  }

  res.json({
    event_type:         eventType,
    timestamp_server:   tsServer,
    distance_m:         distanceM,
    geofence_active:    geofenceActive,
    gps_accuracy_m:     accuracyM ? Math.round(accuracyM) : null,
    worker_name:        worker.full_name,
    site_name:          effectiveSiteName,
    closed_elsewhere:   effectiveSiteId !== site_id,
    compliance_warning: complianceWarning,
  });

  // Telegram punch notification (fire-and-forget) — riferita al cantiere
  // effettivo (quello chiuso), non a quello toccato se sono diversi.
  notifyPunch(
    worker.company_id,
    effectiveSiteId,
    effectiveSiteName,
    worker.full_name,
    eventType,
    tsServer
  ).catch(e => console.error('[badge-punch] notifyPunch error:', e.message));

  } catch (err) {
    console.error('[badge-punch] unexpected error:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── POST /api/v1/badge/:code/help-request — PUBBLICO ─────────────────────────
// F-171 (AUDIT.md): il lavoratore non riesce a timbrare (GPS impreciso/non
// disponibile, fuori zona, o altro) e non deve dover risolvere un problema
// tecnico sul proprio telefono (es. permesso "posizione precisa") per poter
// segnalarlo — un tap qui avvisa subito l'amministratore, che registra lui la
// timbratura da Correzione manuale. Nessuna scrittura in presence_logs.
const HELP_REQUEST_REASONS = ['GPS_ACCURACY_TOO_LOW', 'OUTSIDE_GEOFENCE', 'OTHER'];

router.post('/badge/:code/help-request', badgePunchLimiter, async (req, res) => {
  try {
    const { code } = req.params;
    const { site_id, reason } = req.body || {};

    if (!isValidBadgeCode(code)) {
      return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
    }
    if (!site_id) {
      return res.status(400).json({ error: 'MISSING_FIELDS', required: ['site_id'] });
    }
    const safeReason = HELP_REQUEST_REASONS.includes(reason) ? reason : 'OTHER';

    const { data: worker, error: workerErr } = await supabase
      .from('workers')
      .select('id, full_name, company_id, is_active')
      .eq('badge_code', code.toUpperCase())
      .maybeSingle();

    if (workerErr) return res.status(500).json({ error: 'DB_ERROR' });
    if (!worker) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
    if (!worker.is_active) return res.status(403).json({ error: 'BADGE_REVOKED' });

    const { data: site, error: siteErr } = await supabase
      .from('sites')
      .select('id, name, company_id')
      .eq('id', site_id)
      .maybeSingle();

    if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
    if (!site) return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });
    if (site.company_id !== worker.company_id) {
      return res.status(403).json({ error: 'COMPANY_MISMATCH' });
    }

    supabase.from('admin_audit_log').insert([{
      company_id:  worker.company_id,
      user_id:     null,
      user_role:   'worker_badge',
      action:      'punch.help_requested',
      target_type: 'worker',
      target_id:   worker.id,
      payload:     { site_id, site_name: site.name, reason: safeReason },
      ip:          (req.ip || '').slice(0, 45) || null,
      user_agent:  (req.headers['user-agent'] || '').slice(0, 500) || null,
    }]).then(({ error }) => { if (error) console.error('[badge-help-request] audit log error:', error.message); });

    // entity_id univoco per richiesta (non worker.id): la tabella `notifications`
    // ha un UNIQUE su (company_id, entity_type, entity_id, type) — con
    // entity_id=worker.id una seconda richiesta dello stesso lavoratore in un
    // altro giorno andrebbe in conflitto e non genererebbe una nuova notifica.
    supabase.from('notifications').insert({
      company_id:  worker.company_id,
      type:        'punch_help_request',
      severity:    'warning',
      title:       `${worker.full_name} ha bisogno di aiuto per timbrare`,
      body:        `Cantiere: ${site.name}. Registra tu la sua timbratura da Presenze & Report → Correzione manuale.`,
      entity_type: 'punch_help_request',
      entity_id:   crypto.randomUUID(),
    }).then(({ error }) => { if (error) console.error('[badge-help-request] notification insert error:', error.message); });

    notifyPunchHelpRequest(worker.company_id, site_id, site.name, worker.full_name, safeReason)
      .catch(e => console.error('[badge-help-request] notifyPunchHelpRequest error:', e.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[badge-help-request] unexpected error:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── POST /api/v1/badge/:code/revoke — JWT ────────────────────────────────────
// Disattiva il lavoratore → badge non può più essere usato per timbrare.
router.post('/badge/:code/revoke', verifySupabaseJwt, async (req, res) => {
  const { code } = req.params;

  if (!isValidBadgeCode(code)) {
    return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  }

  const { data: worker, error } = await supabase
    .from('workers')
    .select('id, full_name, is_active')
    .eq('badge_code', code.toUpperCase())
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  const { error: updateErr } = await supabase
    .from('workers')
    .update({ is_active: false })
    .eq('id', worker.id);

  if (updateErr) return res.status(500).json({ error: 'DB_ERROR' });

  res.json({ ok: true, worker_name: worker.full_name, message: 'Badge disattivato.' });
});

// ── POST /api/v1/badge/:code/regenerate — JWT ────────────────────────────────
// Genera un nuovo badge_code per il lavoratore.
// Il vecchio QR/link diventa immediatamente invalido.
// Usare quando un lavoratore perde il badge fisico.
router.post('/badge/:code/regenerate', verifySupabaseJwt, async (req, res) => {
  const { code } = req.params;

  if (!isValidBadgeCode(code)) {
    return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  }

  const { data: worker, error } = await supabase
    .from('workers')
    .select('id, full_name')
    .eq('badge_code', code.toUpperCase())
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  const newCode = crypto.randomBytes(9).toString('hex').toUpperCase();

  const { error: updateErr } = await supabase
    .from('workers')
    .update({ badge_code: newCode })
    .eq('id', worker.id);

  if (updateErr) return res.status(500).json({ error: 'DB_ERROR' });

  const appBase  = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const badgeUrl = `${appBase}/timbratura/${newCode}`;

  res.json({
    ok:             true,
    worker_name:    worker.full_name,
    new_badge_code: newCode,
    badge_url:      badgeUrl,
    message:        'Nuovo badge generato. Stampare e distribuire il nuovo badge al lavoratore.',
  });
});

// ── POST /api/v1/badge/capocantiere-punch — JWT ───────────────────────────────
// Il capocantiere registra l'entrata/uscita di un lavoratore tramite il suo badge.
// Scansiona il QR del badge lavoratore → manda badge_code + site_id.
// Registrato in presence_logs con method = 'capocantiere_action'.
router.post('/badge/capocantiere-punch', verifySupabaseJwt, async (req, res) => {
  const { badge_code, site_id, latitude, longitude, gps_accuracy_m } = req.body;

  if (!badge_code || !site_id) {
    return res.status(400).json({ error: 'MISSING_FIELDS', required: ['badge_code', 'site_id'] });
  }
  if (!isValidBadgeCode(badge_code)) {
    return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  }

  // GPS capocantiere (opzionale — usato solo per log, non geofence-bloccante)
  const lat = latitude != null ? Number(latitude) : null;
  const lon = longitude != null ? Number(longitude) : null;
  const validGps = lat !== null && lon !== null && isValidCoords(lat, lon);

  // Risolvi badge → lavoratore (deve essere nella stessa company)
  const { data: worker, error: workerErr } = await supabase
    .from('workers')
    .select('id, full_name, is_active, company_id')
    .eq('badge_code', badge_code.toUpperCase())
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (workerErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker)          return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
  if (!worker.is_active) return res.status(403).json({ error: 'BADGE_REVOKED' });

  // Carica cantiere (deve essere nella stessa company)
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, company_id, latitude, longitude, geofence_radius_m')
    .eq('id', site_id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });

  // Verifica o auto-crea associazione lavoratore ↔ cantiere
  const { data: assoc } = await supabase
    .from('worksite_workers')
    .select('status')
    .eq('site_id', site_id)
    .eq('worker_id', worker.id)
    .maybeSingle();

  if (assoc && assoc.status !== 'active') {
    return res.status(403).json({ error: 'WORKER_NOT_AUTHORIZED_ON_SITE' });
  }
  if (!assoc) {
    const { error: assocErr } = await supabase
      .from('worksite_workers')
      .insert([{ company_id: req.companyId, site_id, worker_id: worker.id, status: 'active' }]);
    if (assocErr && assocErr.code !== '23505') {
      console.error('[capocantiere-punch] auto-assoc error:', assocErr.message);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  }

  // Distanza GPS (solo per log — il capocantiere si muove, non blocchiamo)
  let distanceM = null;
  const accuracyM = gps_accuracy_m && Number.isFinite(Number(gps_accuracy_m)) && Number(gps_accuracy_m) > 0
    ? Number(gps_accuracy_m) : null;

  // Se il capocantiere non ha GPS, usa le coordinate del cantiere come proxy
  // (è fisicamente sul posto, distance_m = 0 per indicare "presunto sul sito")
  const punchLat = validGps ? lat  : (site.latitude  ?? null);
  const punchLon = validGps ? lon  : (site.longitude ?? null);

  if (validGps && site.latitude != null && site.longitude != null) {
    distanceM = Math.round(haversineM(lat, lon, site.latitude, site.longitude));
  }

  const ipAddress = (req.ip || '').slice(0, 45) || null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500) || null;

  const { data: punchResult, error: punchErr } = await supabase.rpc('punch_atomic', {
    p_site_id:    site_id,
    p_worker_id:  worker.id,
    p_company_id: worker.company_id,
    p_session_id: null,
    p_lat:        punchLat,
    p_lon:        punchLon,
    p_distance_m: distanceM,
    p_accuracy_m: accuracyM,
    p_ip:         ipAddress,
    p_ua:         userAgent,
    p_method:     'capocantiere_action',
  });

  if (punchErr) {
    console.error('[capocantiere-punch] rpc error:', punchErr.message);
    return res.status(500).json({ error: 'LOG_WRITE_ERROR' });
  }

  if (!punchResult || !punchResult.ok) {
    if (punchResult?.error === 'PUNCH_TOO_SOON') {
      return res.status(429).json({
        error:            'PUNCH_TOO_SOON',
        retry_after_secs: punchResult.retry_after_secs,
      });
    }
    return res.status(500).json({ error: 'PUNCH_ERROR' });
  }

  const eventType = punchResult.event_type;
  const tsServer  = punchResult.timestamp_server;

  // F-172 (AUDIT.md): vedi commento analogo su POST /badge/:code/punch — la
  // decisione ENTRY/EXIT è globale per lavoratore, l'uscita può chiudere
  // un'apertura su un cantiere diverso da quello selezionato dal capocantiere.
  let effectiveSiteName = site.name;
  if (punchResult.closed_site_id && punchResult.closed_site_id !== site_id) {
    const { data: closedSite } = await supabase
      .from('sites').select('name').eq('id', punchResult.closed_site_id).maybeSingle();
    effectiveSiteName = closedSite?.name || effectiveSiteName;
  }

  res.json({
    event_type:       eventType,
    timestamp_server: tsServer,
    worker_name:      worker.full_name,
    site_name:        effectiveSiteName,
    closed_elsewhere: effectiveSiteName !== site.name,
    method:           'capocantiere_action',
    registered_by:    req.user?.email || 'admin',
  });

  notifyPunch(
    worker.company_id,
    site_id,
    site.name,
    `${worker.full_name} (via capocantiere)`,
    eventType,
    tsServer
  ).catch(e => console.error('[capocantiere-punch] notifyPunch error:', e.message));
});

module.exports = router;
