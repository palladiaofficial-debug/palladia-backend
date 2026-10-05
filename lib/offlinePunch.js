'use strict';
// ── Timbratura senza internet (F-284, mockup approvato il 2026-10-05) ─────────
// L'operaio senza rete timbra lo stesso: il telefono salva ora e posizione e
// le manda appena torna internet (routes/v1/badgeOfflinePunch.js). Qui si
// decide se la timbratura entra subito nelle ore ("registrata") o se la
// decide il titolare da Da fare ("da_decidere", motivi in `flags`).
//
// Percorso separato da punch_atomic/badgePunch.js: la timbratura normale non
// cambia. offline_punch_atomic (migrations/239) prende lo stesso blocco per
// lavoratore di punch_atomic, quindi le due non si incrociano mai.
const supabase = require('./supabase');

// Oltre questo tempo la timbratura arriva comunque, ma la decide il titolare
const MAX_AGE_MS = 12 * 3600e3;
// Scarto tollerato tra l'orologio del telefono all'ultimo contatto col server
// e al momento dell'invio: oltre, l'ora è stata cambiata a mano
const CLOCK_DRIFT_MAX_MS = 2 * 60e3;

const GPS_MAX_ACCURACY_M = (() => {
  const v = Number(process.env.GPS_MAX_ACCURACY_M);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();
const GEOFENCE_ACCURACY_TOLERANCE_CAP_M = (() => {
  const v = Number(process.env.GEOFENCE_ACCURACY_TOLERANCE_CAP_M);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

// Testi per Da fare (uno per motivo)
const FLAG_LABELS = {
  orologio_cambiato:      "L'ora del telefono era stata cambiata: controlla l'orario",
  troppo_vecchia:         'Arrivata dopo più di 12 ore',
  senza_posizione:        'Senza posizione GPS',
  gps_impreciso:          'Posizione GPS troppo imprecisa',
  lontano:                'Lontano dal cantiere',
  non_autorizzato:        'Non abilitato su questo cantiere',
  dopo_altre:             'Arrivata dopo altre timbrature dello stesso giorno',
  entrata_vecchia_aperta: "C'era un'entrata ancora aperta da più di 16 ore",
  tipo_diverso:           "Il telefono pensava a un'entrata/uscita diversa",
  uscita_breve:           "Uscita a pochi minuti dall'entrata",
};

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/**
 * Ora vera della timbratura e controllo dell'orologio. Puro, testabile.
 *   deviceAt     ms, Date.now() del telefono quando l'operaio ha toccato
 *   deviceNow    ms, Date.now() del telefono all'invio
 *   kitOffsetMs  ms, (ora server − ora telefono) all'ultimo contatto col server, se noto
 */
function resolvePunchTime({ deviceAt, deviceNow, kitOffsetMs, now = Date.now() }) {
  const flags = [];
  const offsetNow = deviceNow != null ? now - deviceNow : null;
  let offset = offsetNow ?? kitOffsetMs ?? 0;
  if (kitOffsetMs != null && offsetNow != null && Math.abs(offsetNow - kitOffsetMs) > CLOCK_DRIFT_MAX_MS) {
    // L'orologio è cambiato tra l'ultimo contatto e l'invio: non si sa se
    // prima o dopo il tocco, l'ora resta quella scritta col vecchio scarto
    flags.push('orologio_cambiato');
    offset = kitOffsetMs;
  }
  const punchedAt = deviceAt + offset;
  if (punchedAt > now + CLOCK_DRIFT_MAX_MS) flags.push('orologio_cambiato');
  if (punchedAt < now - MAX_AGE_MS) flags.push('troppo_vecchia');
  return { punchedAt: Math.min(punchedAt, now), flags: [...new Set(flags)] };
}

/** Distanza e motivi legati alla posizione. Puro, testabile. */
function checkPosition({ lat, lon, accuracyM, site }) {
  if (lat == null || lon == null) return { distanceM: null, flags: ['senza_posizione'] };
  const flags = [];
  if (accuracyM != null && accuracyM > GPS_MAX_ACCURACY_M) flags.push('gps_impreciso');
  let distanceM = null;
  if (site.latitude != null && site.longitude != null) {
    distanceM = Math.round(haversineM(lat, lon, site.latitude, site.longitude));
    const toleranceM = accuracyM != null ? Math.min(accuracyM, GEOFENCE_ACCURACY_TOLERANCE_CAP_M) : 0;
    if (site.geofence_radius_m != null && distanceM > site.geofence_radius_m + toleranceM) flags.push('lontano');
  }
  return { distanceM, flags };
}

/**
 * Registra una timbratura arrivata dal telefono.
 * @returns {{ ok: true, status, event_type, punched_at, flags, replayed } | { ok: false, http, error }}
 */
async function receiveOfflinePunch({ worker, site, body, userAgent, now = Date.now() }) {
  const lat = num(body.latitude), lon = num(body.longitude);
  const validCoords = lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  const accuracyM = num(body.gps_accuracy_m);
  const deviceAt = num(body.device_at);
  if (deviceAt == null) return { ok: false, http: 400, error: 'MISSING_DEVICE_AT' };

  const time = resolvePunchTime({ deviceAt, deviceNow: num(body.device_now), kitOffsetMs: num(body.kit_offset_ms), now });
  const pos = checkPosition({ lat: validCoords ? lat : null, lon: validCoords ? lon : null, accuracyM, site });
  const flags = [...time.flags, ...pos.flags];

  const { data: assoc } = await supabase.from('worksite_workers').select('status')
    .eq('site_id', site.id).eq('worker_id', worker.id).maybeSingle();
  if (assoc && assoc.status !== 'active') flags.push('non_autorizzato');

  const expected = ['ENTRY', 'EXIT'].includes(body.expected_type) ? body.expected_type : null;
  const { data, error } = await supabase.rpc('offline_punch_atomic', {
    p_company_id:        worker.company_id,
    p_worker_id:         worker.id,
    p_site_id:           site.id,
    p_client_request_id: body.client_request_id,
    p_expected_type:     expected,
    p_punched_at:        new Date(time.punchedAt).toISOString(),
    p_device_at:         new Date(deviceAt).toISOString(),
    p_lat:               validCoords ? lat : null,
    p_lon:               validCoords ? lon : null,
    p_accuracy_m:        accuracyM,
    p_distance_m:        pos.distanceM,
    p_flags:             flags,
    p_confirmed:         body.confirmed === true,
    p_ua:                (userAgent || '').slice(0, 500) || null,
  });
  if (error) {
    console.error('[offline-punch] rpc error:', error.message);
    return { ok: false, http: 500, error: 'LOG_WRITE_ERROR' };
  }

  // Per un'entrata scritta senza dubbi, come la timbratura normale: chi entra
  // nel pomeriggio di solito la mattina finisce in Da fare (fire-and-forget)
  if (data.status === 'registrata' && data.event_type === 'ENTRY' && !data.replayed) {
    try {
      const { noteLateFirstEntry } = require('./punchGuard');
      noteLateFirstEntry({ workerId: worker.id, companyId: worker.company_id, siteId: site.id, entryAt: data.punched_at });
    } catch (e) { console.error('[offline-punch] late entry note error:', e.message); }
  }
  return { ok: true, status: data.status, event_type: data.event_type, punched_at: data.punched_at, flags: data.flags || [], replayed: !!data.replayed };
}

/** "È giusta": chiude una timbratura già registrata. */
async function confirmOfflinePunch({ id, companyId, userId }) {
  const { data, error } = await supabase.from('presence_offline_punches')
    .update({ status: 'confermata', resolved_by: userId, resolved_at: new Date().toISOString(), resolution: { action: 'confirm' } })
    .eq('id', id).eq('company_id', companyId).eq('status', 'registrata').select('id');
  if (error) return { ok: false, code: 'DB_ERROR', message: error.message };
  if (!data?.length) return { ok: false, code: 'ALREADY_DONE', message: 'Questa timbratura è già stata sistemata.' };
  return { ok: true };
}

/**
 * "Registra" una timbratura da decidere, all'ora del telefono o a un altro
 * orario ("HH:MM" dello stesso giorno). Riga admin_manual_correction, come la
 * Correzione manuale di Presenze: la decisione è del titolare.
 */
async function applyOfflinePunch({ id, companyId, userId, userRole, at = null, now = new Date() }) {
  const { data: op, error } = await supabase.from('presence_offline_punches').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (error) return { ok: false, code: 'DB_ERROR', message: error.message };
  if (!op) return { ok: false, code: 'NOT_FOUND', message: 'Timbratura non trovata.' };
  if (op.status !== 'da_decidere') return { ok: false, code: 'ALREADY_DONE', message: 'Questa timbratura è già stata sistemata.' };

  let ts = op.punched_at;
  if (at != null) {
    if (typeof at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return { ok: false, code: 'INVALID_TIME', message: 'Orario non valido (HH:MM).' };
    const { romeDay, romeAt } = require('./usualTimes');
    const [h, m] = at.split(':').map(Number);
    ts = romeAt(romeDay(op.punched_at), h * 60 + m);
  }
  if (new Date(ts) > now) return { ok: false, code: 'INVALID_TIME', message: "L'orario non può essere nel futuro." };

  const { data: claimed } = await supabase.from('presence_offline_punches')
    .update({ status: 'corretta', resolved_by: userId, resolved_at: now.toISOString() })
    .eq('id', id).eq('status', 'da_decidere').select('id');
  if (!claimed?.length) return { ok: false, code: 'ALREADY_DONE', message: 'Questa timbratura è già stata sistemata.' };

  const { data: log, error: insErr } = await supabase.from('presence_logs').insert([{
    company_id: companyId, site_id: op.site_id, worker_id: op.worker_id, event_type: op.event_type,
    timestamp_server: new Date(ts).toISOString(), method: 'admin_manual_correction',
    latitude: op.latitude, longitude: op.longitude, distance_m: op.distance_m, gps_accuracy_m: op.gps_accuracy_m,
    ip_address: null, user_agent: 'da-fare:timbratura-senza-internet',
  }]).select('id').single();
  if (insErr) {
    await supabase.from('presence_offline_punches').update({ status: 'da_decidere', resolved_by: null, resolved_at: null }).eq('id', id);
    return { ok: false, code: 'DB_ERROR', message: insErr.message };
  }
  await supabase.from('presence_offline_punches').update({ log_id: log.id, resolution: { action: 'apply', at: at || null } }).eq('id', id);
  supabase.from('admin_audit_log').insert([{
    company_id: companyId, user_id: userId, user_role: userRole, action: 'presence.manual_correction',
    target_type: 'presence_offline_punch', target_id: id,
    payload: { worker_id: op.worker_id, site_id: op.site_id, event_type: op.event_type, timestamp: new Date(ts).toISOString(), note: `Timbratura senza internet: ${(op.flags || []).join(', ')}` },
  }]).then(({ error: e }) => { if (e) console.error('[offline-punch] audit error:', e.message); });
  return { ok: true, written: [log.id] };
}

module.exports = {
  receiveOfflinePunch, confirmOfflinePunch, applyOfflinePunch,
  resolvePunchTime, checkPosition, FLAG_LABELS, MAX_AGE_MS, CLOCK_DRIFT_MAX_MS,
};
