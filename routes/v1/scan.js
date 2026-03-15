'use strict';
const crypto      = require('crypto');
const router      = require('express').Router();
const supabase    = require('../../lib/supabase');
const { verifyPin } = require('../../lib/pinHash');
const { scanLimiter, identifyLimiter } = require('../../middleware/rateLimit');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Haversine: distanza in metri tra due punti GPS
function haversineM(lat1, lon1, lat2, lon2) {
  const R     = 6_371_000;
  const toRad = d => d * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// SHA-256 hex del session token raw (mai salvare il raw in DB)
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// CF italiano: 16 char alfanumerici (uppercase)
function isValidFiscalCode(cf) {
  return typeof cf === 'string' && /^[A-Z0-9]{16}$/i.test(cf.trim());
}

// Range coordinate GPS
function isValidCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90  && lat <= 90
      && lon >= -180 && lon <= 180;
}

// ── Costanti GPS accuracy (modulo-scope) ─────────────────────────────────────
// GPS_MAX_ACCURACY_M: soglia max (m) — punch rifiutato se accuracy > soglia.
// Configurabile via ENV GPS_MAX_ACCURACY_M (default 80).
const GPS_MAX_ACCURACY_M = (() => {
  const v = Number(process.env.GPS_MAX_ACCURACY_M);
  return Number.isFinite(v) && v > 0 ? v : 80;
})();

// GPS_ACCURACY_REQUIRE_MODE: 'strict' (default) | 'compat'
//   strict — gps_accuracy_m obbligatorio; 422 se mancante
//   compat — se mancante, accetta la timbratura con gps_accuracy_m=NULL e
//            aggiunge { warning: 'GPS_ACCURACY_MISSING' } nella response.
//            Usare SOLO durante rollout (FE vecchio + BE nuovo); poi tornare strict.
const GPS_ACCURACY_REQUIRE_MODE = process.env.GPS_ACCURACY_REQUIRE_MODE === 'compat'
  ? 'compat'
  : 'strict';

// ── GET /api/v1/scan/verify-qr — PUBBLICO ────────────────────────────────────
// Verifica la firma HMAC di un link QR.
// Chiamato da scan.html al boot: se il QR è invalido o scaduto → blocca l'accesso.
// Query params: site, t (token), exp (unix timestamp scadenza)
router.get('/scan/verify-qr', async (req, res) => {
  const { site, t, exp } = req.query;
  if (!site || !t || !exp) {
    return res.status(400).json({ valid: false, error: 'MISSING_PARAMS' });
  }

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0) {
    return res.status(400).json({ valid: false, error: 'INVALID_EXP' });
  }

  // Scadenza
  if (Date.now() / 1000 > expNum) {
    return res.json({ valid: false, error: 'QR_EXPIRED', expired_at: new Date(expNum * 1000).toISOString() });
  }

  // Verifica firma HMAC (riusa la logica di qr.js)
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
// Info non sensibili del cantiere per la schermata di scan.
// NON espone: company_id, pin_hash, latitude, longitude.
// Espone max_gps_accuracy_m così il frontend usa la soglia del backend senza hardcode.
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
    max_gps_accuracy_m: GPS_MAX_ACCURACY_M   // soglia condivisa col frontend
    // latitude e longitude NON esposte: calcolo distance è server-side
  });
});

// ── POST /api/v1/scan/identify — PUBBLICO ────────────────────────────────────
// Identifica (o registra) un lavoratore e restituisce un session token
// da conservare in localStorage sul telefono.
//
// Flusso:
//   1. Worker già noto + già associato al cantiere → crea sessione, ritorna token
//   2. Worker noto ma non associato al cantiere   → richiede PIN → associa → crea sessione
//   3. Worker sconosciuto                          → richiede PIN + full_name → crea worker + sessione
//
// SECURITY: company_id derivato SEMPRE dal cantiere in DB, mai dal body.
// SECURITY: PIN confrontato con bcrypt.
router.post('/scan/identify', identifyLimiter, async (req, res) => {
  const { worksite_id, fiscal_code, full_name, pin_code } = req.body;

  // 1. Input validation
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

  // 2. Carica cantiere — company_id e pin_hash sono confidenziali, non ritornati mai
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, company_id, pin_hash')
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

  // company_id è derivato dal DB — il client non lo controlla
  const companyId = site.company_id;

  // 3. Validazione PIN (bcrypt)
  const pinRequired = !!site.pin_hash;
  const pinProvided = pin_code != null && String(pin_code).length > 0;

  async function isPinValid() {
    if (!pinRequired) return true;
    if (!pinProvided) return false;
    return verifyPin(pin_code, site.pin_hash);
  }

  // 4. Cerca worker per CF nella company del cantiere
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .select('id, full_name, is_active')
    .eq('company_id', companyId)
    .eq('fiscal_code', fc)
    .maybeSingle();

  if (wErr) return res.status(500).json({ error: 'DB_ERROR' });

  let workerId, workerName;

  if (!worker) {
    // Worker sconosciuto → registrazione self-service (richiede PIN + nome)
    if (!await isPinValid()) {
      return res.status(403).json({ error: 'INVALID_PIN' });
    }
    if (!full_name || String(full_name).trim().length < 2) {
      return res.status(400).json({
        error:   'FULL_NAME_REQUIRED',
        message: 'Lavoratore non trovato. Inserire il nome completo per registrarsi.'
      });
    }

    const { data: newWorker, error: createErr } = await supabase
      .from('workers')
      .insert([{ company_id: companyId, full_name: String(full_name).trim(), fiscal_code: fc }])
      .select('id, full_name')
      .single();

    if (createErr) {
      // Constraint violation: worker con stesso CF già creato in race (409 invece di 500)
      if (createErr.code === '23505') {
        return res.status(409).json({ error: 'WORKER_ALREADY_EXISTS' });
      }
      return res.status(500).json({ error: 'WORKER_CREATE_ERROR' });
    }
    workerId   = newWorker.id;
    workerName = newWorker.full_name;

  } else {
    if (!worker.is_active) {
      return res.status(403).json({ error: 'WORKER_INACTIVE' });
    }
    workerId   = worker.id;
    workerName = worker.full_name;
  }

  // 5. Verifica o crea associazione worker ↔ cantiere
  const { data: assoc, error: assocSelErr } = await supabase
    .from('worksite_workers')
    .select('id, status')
    .eq('site_id', worksite_id)
    .eq('worker_id', workerId)
    .maybeSingle();

  if (assocSelErr) return res.status(500).json({ error: 'DB_ERROR' });

  if (!assoc) {
    // Worker non associato al cantiere → PIN obbligatorio
    if (!await isPinValid()) {
      return res.status(403).json({ error: 'INVALID_PIN' });
    }
    const { error: assocErr } = await supabase
      .from('worksite_workers')
      .insert([{ company_id: companyId, site_id: worksite_id, worker_id: workerId, status: 'active' }]);

    if (assocErr) return res.status(500).json({ error: 'ASSOCIATION_ERROR' });

  } else if (assoc.status !== 'active') {
    return res.status(403).json({ error: 'WORKER_NOT_ACTIVE_ON_SITE' });
  }

  // 6. Max 2 sessioni attive per worker — revoca la più vecchia se necessario
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
      // Revoca la sessione più vecchia
      const oldest = activeSessions[0];
      await supabase
        .from('worker_device_sessions')
        .update({ revoked_at: now })
        .eq('id', oldest.id);
    }
  }

  // 7. Genera session token (32 bytes = 64 hex chars, salvato SOLO come hash)
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const tokenHash    = hashToken(sessionToken);

  const { data: session, error: sessErr } = await supabase
    .from('worker_device_sessions')
    .insert([{ company_id: companyId, worker_id: workerId, token_hash: tokenHash }])
    .select('id')
    .single();

  if (sessErr) return res.status(500).json({ error: 'SESSION_CREATE_ERROR' });

  res.json({
    session_token:   sessionToken,   // client → localStorage; non viene mai restituito di nuovo
    worker_name:     workerName,
    worker_id:       workerId,
    session_id:      session.id,
    expires_in_days: 60
    // company_id NON esposto
  });
});

// ── POST /api/v1/scan/punch — PUBBLICO (auth via session token) ───────────────
// Registra ENTRATA o USCITA.
// event_type determinato SERVER-SIDE: mai accettato dal client.
// Geofence OBBLIGATORIA: il cantiere deve avere lat/lon configurate.
// GPS accuracy: obbligatoria in strict, opzionale in compat (vedi GPS_ACCURACY_REQUIRE_MODE).
router.post('/scan/punch', scanLimiter, async (req, res) => {
  const { worksite_id, session_token, latitude, longitude, gps_accuracy_m } = req.body;

  // 1. Campi obbligatori
  if (!worksite_id || !session_token) {
    return res.status(400).json({
      error:    'MISSING_FIELDS',
      required: ['worksite_id', 'session_token']
    });
  }
  if (typeof session_token !== 'string' || session_token.length !== 64) {
    return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  }

  // 2. GPS obbligatorio (il cantiere richiede sempre coordinate)
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

  // 2b. Accuratezza GPS
  //   strict (default): obbligatoria — 422 se mancante o non valida
  //   compat:           se mancante, pone un flag; il 202 viene emesso DOPO aver
  //                     verificato sessione e cantiere (anti-spam minimale)
  //   In entrambe le modalità: 422 se il valore fornito è fuori range o > soglia.
  let accuracyM              = null;
  let compatMissingAccuracy  = false;

  if (gps_accuracy_m == null) {
    if (GPS_ACCURACY_REQUIRE_MODE === 'strict') {
      return res.status(422).json({
        error:          'GPS_ACCURACY_REQUIRED',
        message:        'Precisione GPS mancante. Aggiorna la pagina e riprova.',
        max_accuracy_m: GPS_MAX_ACCURACY_M
      });
    }
    // compat: differisce il 202 — prima verifica sessione e cantiere per bloccare spam
    compatMissingAccuracy = true;
  } else {
    const parsed = Number(gps_accuracy_m);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 5000) {
      return res.status(422).json({
        error:          'INVALID_GPS_ACCURACY',
        message:        'Valore precisione GPS non valido (deve essere compreso tra 0 e 5000 m).',
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

  // 3. Valida session token (SHA-256 hash → lookup in DB)
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

  // 4. Carica cantiere (geofence + company ownership)
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, company_id, latitude, longitude, geofence_radius_m')
    .eq('id', worksite_id)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });

  // 5. Cross-company: sessione e cantiere devono appartenere alla stessa company
  if (session.company_id !== site.company_id) {
    return res.status(403).json({ error: 'COMPANY_MISMATCH' });
  }

  // compat shortcut: sessione e cantiere validi, accuracy mancante → nessun INSERT
  if (compatMissingAccuracy) {
    return res.status(202).json({
      warning:        'GPS_ACCURACY_MISSING',
      action:         'REFRESH_REQUIRED',
      message:        'Aggiorna la pagina per completare l\'aggiornamento e riprova a timbrare.',
      max_accuracy_m: GPS_MAX_ACCURACY_M
    });
  }

  // 6. Worker autorizzato e attivo su questo cantiere
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

  // 7. Geofence OBBLIGATORIA
  //    Se il cantiere non ha coordinate configurate: blocca (non accettiamo timbri senza geofence).
  if (site.latitude == null || site.longitude == null) {
    return res.status(422).json({
      error:   'GEOFENCE_NOT_CONFIGURED',
      message: 'Cantiere senza coordinate GPS: configurare lat/lon prima di abilitare le timbrature.'
    });
  }

  const distanceM = Math.round(haversineM(lat, lon, site.latitude, site.longitude));
  if (distanceM > site.geofence_radius_m) {
    return res.status(403).json({
      error:          'OUTSIDE_GEOFENCE',
      distance_m:     distanceM,
      max_allowed_m:  site.geofence_radius_m
    });
  }

  // 8-10. Rate limit + event_type + INSERT — ATOMICI via RPC PostgreSQL.
  //   punch_atomic() acquisisce pg_advisory_xact_lock(worker_hash, site_hash)
  //   che serializza punch simultanei per lo stesso worker+cantiere,
  //   eliminando la race condition read-then-write.
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

  // 11. Aggiorna last_seen_at (best-effort, non blocca la risposta)
  supabase
    .from('worker_device_sessions')
    .update({ last_seen_at: tsServer })
    .eq('id', session.id)
    .then(({ error: e }) => { if (e) console.error('[punch] last_seen update error:', e.message); });

  res.json({
    event_type:         eventType,
    timestamp_server:   tsServer,
    distance_m:         distanceM,
    gps_accuracy_m:     Math.round(accuracyM),  // per UI (arrotondato)
    gps_accuracy_m_raw: accuracyM               // per audit/debug (con decimali)
  });
});

// ── POST /api/v1/scan/logout-device — PUBBLICO (auth via session token) ────────
// Il lavoratore revoca la propria sessione (es. cambio telefono, logout volontario).
// Non richiede JWT admin — autentica tramite lo stesso session_token del punch.
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
