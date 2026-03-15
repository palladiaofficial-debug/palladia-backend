'use strict';
const crypto      = require('crypto');
const router      = require('express').Router();
const supabase    = require('../../lib/supabase');
const { scanLimiter, identifyLimiter } = require('../../middleware/rateLimit');

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

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isValidFiscalCode(cf) {
  return typeof cf === 'string' && /^[A-Z0-9]{16}$/i.test(cf.trim());
}

function parseFullName(fullName) {
  const trimmed  = String(fullName).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const firstName = spaceIdx > -1 ? trimmed.slice(0, spaceIdx) : trimmed;
  const lastName  = spaceIdx > -1 ? trimmed.slice(spaceIdx + 1).trim() || null : null;
  return { first_name: firstName, last_name: lastName, full_name: trimmed };
}

function workerDisplayName(w) {
  return w.full_name
    || [w.first_name, w.last_name].filter(Boolean).join(' ')
    || '';
}

function isValidCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90  && lat <= 90
      && lon >= -180 && lon <= 180;
}

const GPS_MAX_ACCURACY_M = (() => {
  const v = Number(process.env.GPS_MAX_ACCURACY_M);
  return Number.isFinite(v) && v > 0 ? v : 80;
})();

const GPS_ACCURACY_REQUIRE_MODE = process.env.GPS_ACCURACY_REQUIRE_MODE === 'compat'
  ? 'compat'
  : 'strict';

// ── GET /api/v1/scan/verify-qr — PUBBLICO ────────────────────────────────────
router.get('/scan/verify-qr', async (req, res) => {
  const { site, t, exp } = req.query;
  if (!site || !t || !exp) {
    return res.status(400).json({ valid: false, error: 'MISSING_PARAMS' });
  }

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0) {
    return res.status(400).json({ valid: false, error: 'INVALID_EXP' });
  }

  if (Date.now() / 1000 > expNum) {
    return res.json({ valid: false, error: 'QR_EXPIRED', expired_at: new Date(expNum * 1000).toISOString() });
  }

  const { verifyQrToken } = require('./qr');
  let valid = false;
  try {
    valid = verifyQrToken(site, t, expNum);
  } catch (e) {
    return res.status(500).json({ valid: false, error: 'SIGNING_NOT_CONFIGURED' });
  }

  if (!valid) {
    return res.json({ valid: false, error: 'INVALID_SIGNATURE' });
  }

  res.json({ valid: true, site_id: site, expires_at: new Date(expNum * 1000).toISOString() });
});

// ── GET /api/v1/scan/worksites/:worksiteId — PUBBLICO ─────────────────────────
router.get('/scan/worksites/:worksiteId', async (req, res) => {
  const { worksiteId } = req.params;

  const { data: site, error } = await supabase
    .from('sites')
    .select('id, name, address, geofence_radius_m, latitude, longitude')
    .eq('id', worksiteId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)  return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });

  res.json({
    id:                 site.id,
    name:               site.name,
    address:            site.address,
    geofence_radius_m:  site.geofence_radius_m,
    has_geofence:       site.latitude != null && site.longitude != null,
    max_gps_accuracy_m: GPS_MAX_ACCURACY_M
  });
});

// ── POST /api/v1/scan/identify — PUBBLICO ────────────────────────────────────
// Identifica (o registra) un lavoratore e restituisce un session token.
// Nessun PIN richiesto: chiunque con il proprio CF può identificarsi.
// La prima volta viene richiesto il nome completo per la registrazione.
router.post('/scan/identify', identifyLimiter, async (req, res) => {
  const { worksite_id, fiscal_code, full_name } = req.body;

  if (!worksite_id || !fiscal_code) {
    return res.status(400).json({
      error:    'MISSING_FIELDS',
      required: ['worksite_id', 'fiscal_code']
    });
  }
  if (!isValidFiscalCode(fiscal_code)) {
    return res.status(400).json({ error: 'INVALID_FISCAL_CODE' });
  }
  const fc = fiscal_code.toUpperCase().trim();

  // Carica cantiere
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, company_id')
    .eq('id', worksite_id)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });
  if (!site.company_id) {
    return res.status(503).json({
      error:   'WORKSITE_NOT_CONFIGURED',
      message: 'Cantiere non collegato a nessuna azienda. Contattare l\'amministratore.'
    });
  }

  const companyId = site.company_id;

  // Cerca worker per CF nella company del cantiere
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .select('id, full_name, first_name, last_name, is_active')
    .eq('company_id', companyId)
    .eq('fiscal_code', fc)
    .maybeSingle();

  if (wErr) return res.status(500).json({ error: 'DB_ERROR' });

  let workerId, workerName;

  if (!worker) {
    // Worker sconosciuto — prima registrazione: richiede nome completo
    if (!full_name || String(full_name).trim().length < 2) {
      return res.status(400).json({
        error:        'FULL_NAME_REQUIRED',
        pin_required: false,
        message:      'Prima registrazione: inserire il nome completo.'
      });
    }

    const nameParts = parseFullName(full_name);
    const { data: newWorker, error: createErr } = await supabase
      .from('workers')
      .insert([{ company_id: companyId, ...nameParts, fiscal_code: fc }])
      .select('id, full_name, first_name, last_name')
      .single();

    if (createErr) {
      console.error('[identify] worker create error:', createErr.code, createErr.message);
      if (createErr.code === '23505') {
        return res.status(409).json({ error: 'WORKER_ALREADY_EXISTS' });
      }
      return res.status(500).json({ error: 'WORKER_CREATE_ERROR' });
    }
    workerId   = newWorker.id;
    workerName = workerDisplayName(newWorker);

  } else {
    if (!worker.is_active) {
      return res.status(403).json({ error: 'WORKER_INACTIVE' });
    }
    workerId   = worker.id;
    workerName = workerDisplayName(worker);
  }

  // Verifica o crea associazione worker ↔ cantiere (automatica, senza PIN)
  const { data: assoc, error: assocSelErr } = await supabase
    .from('worksite_workers')
    .select('id, status')
    .eq('site_id', worksite_id)
    .eq('worker_id', workerId)
    .maybeSingle();

  if (assocSelErr) return res.status(500).json({ error: 'DB_ERROR' });

  if (!assoc) {
    // Auto-associa il worker al cantiere
    const { error: assocErr } = await supabase
      .from('worksite_workers')
      .insert([{ company_id: companyId, site_id: worksite_id, worker_id: workerId, status: 'active' }]);

    if (assocErr) return res.status(500).json({ error: 'ASSOCIATION_ERROR' });

  } else if (assoc.status !== 'active') {
    return res.status(403).json({ error: 'WORKER_NOT_ACTIVE_ON_SITE' });
  }

  // Max 2 sessioni attive per worker — revoca la più vecchia se necessario
  {
    const now = new Date().toISOString();
    const { data: activeSessions, error: sessListErr } = await supabase
      .from('worker_device_sessions')
      .select('id, created_at')
      .eq('worker_id', workerId)
      .is('revoked_at', null)
      .gt('expires_at', now)
      .order('created_at', { ascending: true });

    if (!sessListErr && activeSessions && activeSessions.length >= 2) {
      const oldest = activeSessions[0];
      await supabase
        .from('worker_device_sessions')
        .update({ revoked_at: now })
        .eq('id', oldest.id);
    }
  }

  // Genera session token
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const tokenHash    = hashToken(sessionToken);

  const { data: session, error: sessErr } = await supabase
    .from('worker_device_sessions')
    .insert([{ company_id: companyId, worker_id: workerId, token_hash: tokenHash }])
    .select('id')
    .single();

  if (sessErr) return res.status(500).json({ error: 'SESSION_CREATE_ERROR' });

  res.json({
    session_token:   sessionToken,
    worker_name:     workerName,
    worker_id:       workerId,
    session_id:      session.id,
    expires_in_days: 60
  });
});

// ── POST /api/v1/scan/punch — PUBBLICO ────────────────────────────────────────
router.post('/scan/punch', scanLimiter, async (req, res) => {
  const { worksite_id, session_token, latitude, longitude, gps_accuracy_m } = req.body;

  if (!worksite_id || !session_token) {
    return res.status(400).json({
      error:    'MISSING_FIELDS',
      required: ['worksite_id', 'session_token']
    });
  }
  if (typeof session_token !== 'string' || session_token.length !== 64) {
    return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  }

  if (latitude == null || longitude == null) {
    return res.status(422).json({
      error:   'GPS_REQUIRED',
      message: 'Posizione GPS obbligatoria. Concedere il permesso di geolocalizzazione.'
    });
  }
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!isValidCoords(lat, lon)) {
    return res.status(400).json({ error: 'INVALID_COORDS' });
  }

  let accuracyM             = null;
  let compatMissingAccuracy = false;

  if (gps_accuracy_m == null) {
    if (GPS_ACCURACY_REQUIRE_MODE === 'strict') {
      return res.status(422).json({
        error:          'GPS_ACCURACY_REQUIRED',
        message:        'Precisione GPS mancante. Aggiorna la pagina e riprova.',
        max_accuracy_m: GPS_MAX_ACCURACY_M
      });
    }
    compatMissingAccuracy = true;
  } else {
    const parsed = Number(gps_accuracy_m);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 5000) {
      return res.status(422).json({
        error:          'INVALID_GPS_ACCURACY',
        message:        'Valore precisione GPS non valido.',
        accuracy_m:     gps_accuracy_m,
        max_accuracy_m: GPS_MAX_ACCURACY_M
      });
    }
    if (parsed > GPS_MAX_ACCURACY_M) {
      return res.status(422).json({
        error:          'GPS_ACCURACY_TOO_LOW',
        message:        'Precisione GPS insufficiente. Spostati all\'aperto e riprova.',
        accuracy_m:     Math.round(parsed),
        max_accuracy_m: GPS_MAX_ACCURACY_M
      });
    }
    accuracyM = parsed;
  }

  const tokenHash = hashToken(session_token);
  const now       = new Date();

  const { data: session, error: sessErr } = await supabase
    .from('worker_device_sessions')
    .select('id, worker_id, company_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (sessErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!session)                            return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  if (session.revoked_at)                  return res.status(401).json({ error: 'SESSION_REVOKED' });
  if (new Date(session.expires_at) < now)  return res.status(401).json({ error: 'SESSION_EXPIRED' });

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, company_id, latitude, longitude, geofence_radius_m')
    .eq('id', worksite_id)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });

  if (session.company_id !== site.company_id) {
    return res.status(403).json({ error: 'COMPANY_MISMATCH' });
  }

  if (compatMissingAccuracy) {
    return res.status(202).json({
      warning:        'GPS_ACCURACY_MISSING',
      action:         'REFRESH_REQUIRED',
      message:        'Aggiorna la pagina per completare l\'aggiornamento e riprova a timbrare.',
      max_accuracy_m: GPS_MAX_ACCURACY_M
    });
  }

  const { data: assoc, error: assocErr } = await supabase
    .from('worksite_workers')
    .select('status')
    .eq('site_id', worksite_id)
    .eq('worker_id', session.worker_id)
    .maybeSingle();

  if (assocErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!assoc || assoc.status !== 'active') {
    return res.status(403).json({ error: 'WORKER_NOT_AUTHORIZED_ON_SITE' });
  }

  // Se il cantiere non ha coordinate GPS la geofence è disabilitata (log senza validazione)
  let distanceM = null;
  if (site.latitude != null && site.longitude != null) {
    distanceM = Math.round(haversineM(lat, lon, site.latitude, site.longitude));
    if (distanceM > site.geofence_radius_m) {
      return res.status(403).json({
        error:         'OUTSIDE_GEOFENCE',
        distance_m:    distanceM,
        max_allowed_m: site.geofence_radius_m
      });
    }
  }

  const ipAddress = (req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '').slice(0, 45) || null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500) || null;

  const { data: punchResult, error: punchErr } = await supabase.rpc('punch_atomic', {
    p_site_id:    worksite_id,
    p_worker_id:  session.worker_id,
    p_company_id: site.company_id,
    p_session_id: session.id,
    p_lat:        lat,
    p_lon:        lon,
    p_distance_m: distanceM,
    p_accuracy_m: accuracyM,
    p_ip:         ipAddress,
    p_ua:         userAgent
  });

  if (punchErr) {
    console.error('[punch] rpc error:', punchErr.message);
    return res.status(500).json({ error: 'LOG_WRITE_ERROR' });
  }

  if (!punchResult.ok) {
    if (punchResult.error === 'PUNCH_TOO_SOON') {
      return res.status(429).json({
        error:            'PUNCH_TOO_SOON',
        retry_after_secs: punchResult.retry_after_secs
      });
    }
    return res.status(500).json({ error: 'PUNCH_ERROR' });
  }

  const eventType = punchResult.event_type;
  const tsServer  = punchResult.timestamp_server;

  supabase
    .from('worker_device_sessions')
    .update({ last_seen_at: tsServer })
    .eq('id', session.id)
    .then(({ error: e }) => { if (e) console.error('[punch] last_seen update error:', e.message); });

  res.json({
    event_type:         eventType,
    timestamp_server:   tsServer,
    distance_m:         distanceM,
    gps_accuracy_m:     Math.round(accuracyM),
    gps_accuracy_m_raw: accuracyM
  });
});

// ── POST /api/v1/scan/note — PUBBLICO ─────────────────────────────────────────
// Salva una nota di lavorazione al termine di una timbratura EXIT.
// Autenticato tramite session_token (stesso meccanismo del punch).
// Le note sono salvate in admin_audit_log con action='worker.exit_note'.
router.post('/scan/note', scanLimiter, async (req, res) => {
  const { worksite_id, session_token, note_text } = req.body;

  if (!worksite_id || !session_token) {
    return res.status(400).json({ error: 'MISSING_FIELDS', required: ['worksite_id', 'session_token'] });
  }
  if (typeof session_token !== 'string' || session_token.length !== 64) {
    return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  }

  const text = typeof note_text === 'string' ? note_text.trim().slice(0, 500) : '';
  if (!text) return res.status(400).json({ error: 'NOTE_EMPTY' });

  const tokenHash = hashToken(session_token);
  const now       = new Date();

  const { data: session, error: sessErr } = await supabase
    .from('worker_device_sessions')
    .select('id, worker_id, company_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (sessErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!session)                            return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  if (session.revoked_at)                  return res.status(401).json({ error: 'SESSION_REVOKED' });
  if (new Date(session.expires_at) < now)  return res.status(401).json({ error: 'SESSION_EXPIRED' });

  // Verifica che il cantiere appartenga alla stessa company della sessione
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, company_id, name')
    .eq('id', worksite_id)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });
  if (session.company_id !== site.company_id) return res.status(403).json({ error: 'COMPANY_MISMATCH' });

  // Recupera nome lavoratore per payload leggibile
  const { data: worker } = await supabase
    .from('workers')
    .select('full_name, first_name, last_name')
    .eq('id', session.worker_id)
    .maybeSingle();

  const { error: insertErr } = await supabase
    .from('admin_audit_log')
    .insert([{
      company_id:  session.company_id,
      user_id:     null,  // worker non è auth user — info worker nel payload
      user_role:   'worker',
      action:      'worker.exit_note',
      target_type: 'worksite',
      target_id:   worksite_id,
      payload: {
        note:         text,
        worker_id:    session.worker_id,
        worker_name:  worker ? workerDisplayName(worker) : null,
        worksite_id,
        worksite_name: site.name,
        session_id:   session.id
      },
      ip_address: (req.ip || '').slice(0, 45) || null,
      user_agent: (req.headers['user-agent'] || '').slice(0, 500) || null
    }]);

  if (insertErr) {
    console.error('[note] insert error:', insertErr.message);
    return res.status(500).json({ error: 'NOTE_SAVE_ERROR' });
  }

  res.json({ ok: true });
});

// ── GET /api/v1/scan/punch-status — PUBBLICO ─────────────────────────────────
// Restituisce l'ultimo evento del lavoratore su questo cantiere.
// Usato dalla UI per mostrare il bottone contestuale (entrata/uscita/completato).
router.get('/scan/punch-status', async (req, res) => {
  const { worksite_id, session_token } = req.query;

  if (!worksite_id || !session_token) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }
  if (typeof session_token !== 'string' || session_token.length !== 64) {
    return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  }

  const tokenHash = hashToken(session_token);
  const now       = new Date();

  const { data: session, error: sessErr } = await supabase
    .from('worker_device_sessions')
    .select('id, worker_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (sessErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!session)                            return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  if (session.revoked_at)                  return res.status(401).json({ error: 'SESSION_REVOKED' });
  if (new Date(session.expires_at) < now)  return res.status(401).json({ error: 'SESSION_EXPIRED' });

  const { data: lastLog, error: logErr } = await supabase
    .from('presence_logs')
    .select('event_type, timestamp_server')
    .eq('worker_id', session.worker_id)
    .eq('site_id', worksite_id)
    .order('timestamp_server', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (logErr) return res.status(500).json({ error: 'DB_ERROR' });

  res.json({
    last_event_type: lastLog?.event_type  || null,
    last_timestamp:  lastLog?.timestamp_server || null
  });
});

// ── POST /api/v1/scan/logout-device — PUBBLICO ────────────────────────────────
router.post('/scan/logout-device', scanLimiter, async (req, res) => {
  const { session_token } = req.body;

  if (!session_token || typeof session_token !== 'string' || session_token.length !== 64) {
    return res.status(400).json({ error: 'INVALID_SESSION_TOKEN' });
  }

  const tokenHash = hashToken(session_token);
  const now       = new Date().toISOString();

  const { data: session, error: findErr } = await supabase
    .from('worker_device_sessions')
    .select('id, revoked_at, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (findErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!session) return res.status(401).json({ error: 'SESSION_NOT_FOUND' });
  if (session.revoked_at || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: 'SESSION_ALREADY_EXPIRED' });
  }

  const { error: revokeErr } = await supabase
    .from('worker_device_sessions')
    .update({ revoked_at: now })
    .eq('id', session.id);

  if (revokeErr) return res.status(500).json({ error: 'REVOKE_ERROR' });

  res.json({ ok: true, message: 'Sessione revocata.' });
});

module.exports = router;
