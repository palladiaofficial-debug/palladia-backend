'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// POST /api/v1/presence/admin-correction — aggiunge manualmente un record ENTRY o EXIT (PRIVATO — owner/admin)
//
// presence_logs è append-only: non è possibile modificare né cancellare record esistenti.
// Questa API inserisce un nuovo record con method='admin_manual_correction' per correggere
// uscite mancanti, ingressi errati o dati anomali.
//
// Caso d'uso principale: aggiungere un EXIT per un lavoratore che non ha timbrato l'uscita,
// oppure compensare un ENTRY errato con un EXIT immediato.
router.post('/presence/admin-correction', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  }

  const { worker_id, site_id, event_type, timestamp, note } = req.body || {};

  if (!worker_id || !site_id || !event_type || !timestamp) {
    return res.status(400).json({
      error:    'MISSING_FIELDS',
      required: ['worker_id', 'site_id', 'event_type', 'timestamp'],
    });
  }

  if (!['ENTRY', 'EXIT'].includes(event_type)) {
    return res.status(400).json({ error: 'INVALID_EVENT_TYPE', allowed: ['ENTRY', 'EXIT'] });
  }

  const ts = new Date(timestamp);
  if (isNaN(ts.getTime())) {
    return res.status(400).json({ error: 'INVALID_TIMESTAMP' });
  }
  if (ts > new Date()) {
    return res.status(400).json({ error: 'FUTURE_TIMESTAMP_NOT_ALLOWED' });
  }

  // Verifica che il lavoratore appartenga alla company dell'amministratore
  const { data: worker, error: workerErr } = await supabase
    .from('workers')
    .select('id, full_name')
    .eq('id', worker_id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (workerErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker)   return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  // Verifica che il cantiere appartenga alla company dell'amministratore
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, company_id')
    .eq('id', site_id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // Inserisce il record correttivo
  const { data: log, error: insertErr } = await supabase
    .from('presence_logs')
    .insert([{
      company_id:       req.companyId,
      site_id,
      worker_id,
      event_type,
      timestamp_server: ts.toISOString(),
      method:           'admin_manual_correction',
      ip_address:       (req.ip || '').slice(0, 45) || null,
      user_agent:       (req.headers['user-agent'] || '').slice(0, 500) || null,
    }])
    .select('id')
    .single();

  if (insertErr) {
    console.error('[presence/admin-correction] insert error:', insertErr.message);
    return res.status(500).json({ error: 'INSERT_ERROR' });
  }

  // Audit log (fire-and-forget — non blocca la risposta)
  supabase.from('admin_audit_log').insert([{
    company_id:  req.companyId,
    user_id:     req.user.id,
    user_role:   req.userRole,
    action:      'presence.manual_correction',
    target_type: 'presence_log',
    target_id:   log.id,
    payload: {
      log_id:      log.id,
      worker_id,
      worker_name: worker.full_name,
      site_id,
      site_name:   site.name,
      event_type,
      timestamp:   ts.toISOString(),
      note:        note || null,
    },
    ip:         (req.ip || '').slice(0, 45) || null,
    user_agent: (req.headers['user-agent'] || '').slice(0, 500) || null,
  }]).then(({ error: e }) => {
    if (e) console.error('[presence/admin-correction] audit log error:', e.message);
  });

  res.json({
    ok:         true,
    log_id:     log.id,
    event_type,
    timestamp:  ts.toISOString(),
    worker:     { id: worker_id, name: worker.full_name },
    site:       { id: site_id,   name: site.name },
  });
});

// GET /api/v1/presence/open-sessions — lavoratori ancora "dentro" il cantiere (PRIVATO — owner/admin/tech)
// Restituisce tutti i worker con ultimo log = ENTRY (senza EXIT successivo) per l'azienda.
// Parametri opzionali: siteId, maxAgeHours (default 48h — oltre sono anomalie storiche)
router.get('/presence/open-sessions', verifySupabaseJwt, async (req, res) => {
  const { siteId, maxAgeHours } = req.query;
  const ageHours = Math.min(Number(maxAgeHours) || 48, 720); // max 30gg

  const since = new Date(Date.now() - ageHours * 3_600_000).toISOString();

  let query = supabase
    .from('presence_logs')
    .select(`
      id, event_type, timestamp_server, site_id, worker_id,
      worker:workers (id, full_name),
      site:sites    (id, name)
    `)
    .eq('company_id', req.companyId)
    .gte('timestamp_server', since)
    .order('timestamp_server', { ascending: true });

  if (siteId) query = query.eq('site_id', siteId);

  const { data: logs, error: logsErr } = await query.limit(5000);
  if (logsErr) return res.status(500).json({ error: logsErr.message });

  // Per ogni worker+site, prende l'ultimo evento
  const lastByKey = new Map();
  for (const log of (logs || [])) {
    const key = `${log.worker_id}::${log.site_id}`;
    lastByKey.set(key, log); // overwrite → ultimo (logs ordinati asc)
  }

  // Filtra solo quelli con ultimo evento = ENTRY
  const openSessions = [];
  for (const log of lastByKey.values()) {
    if (log.event_type === 'ENTRY') {
      const sinceMs  = Date.now() - new Date(log.timestamp_server).getTime();
      const sinceH   = Math.round(sinceMs / 3_600_000 * 10) / 10;
      openSessions.push({
        worker_id:        log.worker_id,
        worker_name:      log.worker?.full_name || '—',
        site_id:          log.site_id,
        site_name:        log.site?.name || '—',
        entry_at:         log.timestamp_server,
        hours_elapsed:    sinceH,
        is_anomalous:     sinceH > 24,
      });
    }
  }

  // Ordina: prima gli anomali (più ore), poi i recenti
  openSessions.sort((a, b) => b.hours_elapsed - a.hours_elapsed);

  res.json({ open_sessions: openSessions, count: openSessions.length });
});

module.exports = router;
