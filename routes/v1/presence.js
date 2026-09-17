'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendDbError } = require('../../lib/httpErrors');
const { tagPresenceLogReason, latestReasonsByLogId, VALID_REASONS } = require('../../lib/presenceLogReasons');

// GET /api/v1/presence?siteId=&date= — registro presenze giornaliero (PRIVATO)
// date format: YYYY-MM-DD
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Limite massimo record per risposta: protegge da query runaway
const PRESENCE_MAX_ROWS = 5000;

router.get('/presence', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.query;
  if (!siteId || !date) {
    return res.status(400).json({ error: 'siteId e date obbligatori (YYYY-MM-DD)' });
  }
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date deve essere YYYY-MM-DD' });
  }

  // Calcola la finestra UTC per il giorno Rome richiesto.
  // Italy = UTC+1 (CET) o UTC+2 (CEST). Allargare di 2h per coprire entrambi i casi,
  // poi filtrare in JS per precisione.
  const fromUtc = new Date(`${date}T00:00:00Z`);
  fromUtc.setUTCHours(fromUtc.getUTCHours() - 2); // mezzanotte Rome ≥ 22:00 UTC giorno precedente
  const toUtc = new Date(`${date}T23:59:59Z`);
  toUtc.setUTCHours(toUtc.getUTCHours() + 2);     // 23:59 Rome ≤ 01:59 UTC giorno seguente

  const { data: rawData, error } = await supabase
    .from('presence_logs')
    .select(`
      id, event_type, timestamp_server, distance_m, method,
      worker:workers (id, full_name, first_name, last_name, fiscal_code)
    `)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .gte('timestamp_server', fromUtc.toISOString())
    .lte('timestamp_server', toUtc.toISOString())
    .order('timestamp_server', { ascending: true })
    .limit(PRESENCE_MAX_ROWS);

  if (error) return sendDbError(res, error);

  // Filtra precisamente per giorno Roma (gestisce CET/CEST correttamente)
  const data = (rawData || []).filter(log => {
    const d = new Date(log.timestamp_server).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
    return d === date;
  });

  // F-184 (AUDIT.md): presence_logs è append-only per design (migrations/003,
  // blocca UPDATE/DELETE per qualunque ruolo) — un evento anomalo (es. un
  // retry di rete che ha capovolto entrata/uscita) resta nello storico per
  // sempre, come deve essere per un registro presenze. Un admin può però
  // annotarlo (senza alterare la riga originale) con POST
  // /presence/:logId/annotate — l'annotazione arriva qui allegata alla riga.
  const logIds = data.map(l => l.id);
  if (logIds.length > 0) {
    const { data: notes } = await supabase
      .from('admin_audit_log')
      .select('target_id, payload, created_at')
      .eq('company_id', req.companyId)
      .eq('action', 'presence.log_annotation')
      .in('target_id', logIds);
    const noteByLogId = {};
    for (const n of (notes || [])) noteByLogId[n.target_id] = { text: n.payload?.note || '', annotated_at: n.created_at };
    for (const log of data) log.annotation = noteByLogId[log.id] || null;

    // Motivo uscita (maltempo/malattia/permesso, migrations/217) — campo
    // SEPARATO da `annotation` sopra: quello alimenta lib/presencePairing.js
    // per fondere un glitch tecnico, questo è solo un'etichetta informativa,
    // mai letta dal calcolo ore.
    const reasonByLogId = await latestReasonsByLogId(req.companyId, logIds);
    for (const log of data) log.reason = reasonByLogId.get(log.id) || null;
  }

  res.json(data);
});

// POST /api/v1/presence/:logId/reason — motivo uscita (PRIVATO — owner/admin)
//
// presence_logs resta append-only: questa API non tocca la riga originale,
// aggiunge solo un'etichetta consultabile (presence_log_reasons,
// migrations/217) — MAI letta dal calcolo ore (lib/presencePairing.js),
// a differenza di /annotate qui sopra che invece lo è (glitch tecnici).
router.post('/presence/:logId/reason', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  }

  const { logId }       = req.params;
  const { reason, note } = req.body || {};

  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'INVALID_REASON', allowed: VALID_REASONS });
  }

  const result = await tagPresenceLogReason({ companyId: req.companyId, logId, reason, note, userId: req.user?.id });
  if (!result.ok) {
    const status = result.code === 'PRESENCE_LOG_NOT_FOUND' ? 404 : result.code === 'NOT_AN_EXIT' ? 400 : 500;
    return res.status(status).json({ error: result.code, message: result.error });
  }

  res.json({ ok: true });
});

// POST /api/v1/presence/:logId/annotate — annota un evento anomalo (PRIVATO — owner/admin)
//
// presence_logs è append-only: questa API NON tocca la riga originale, aggiunge
// solo una nota consultabile (admin_audit_log) — usata per spiegare eventi
// tecnici (es. un retry di rete che ha generato un'uscita mentre il lavoratore
// non si è mai mosso) senza alterare lo storico ufficiale.
router.post('/presence/:logId/annotate', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  }

  const { logId } = req.params;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
  if (!note) return res.status(400).json({ error: 'NOTE_EMPTY' });

  const { data: log, error: logErr } = await supabase
    .from('presence_logs')
    .select('id, worker_id, event_type, timestamp_server')
    .eq('id', logId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (logErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!log)   return res.status(404).json({ error: 'PRESENCE_LOG_NOT_FOUND' });

  const { error: insertErr } = await supabase.from('admin_audit_log').insert([{
    company_id:  req.companyId,
    user_id:     req.user.id,
    user_role:   req.userRole,
    action:      'presence.log_annotation',
    target_type: 'presence_log',
    target_id:   log.id,
    payload:     { note, worker_id: log.worker_id, event_type: log.event_type, timestamp_server: log.timestamp_server },
    ip:          (req.ip || '').slice(0, 45) || null,
    user_agent:  (req.headers['user-agent'] || '').slice(0, 500) || null,
  }]);

  if (insertErr) {
    console.error('[presence/annotate] insert error:', insertErr.message);
    return res.status(500).json({ error: 'INSERT_ERROR' });
  }

  res.json({ ok: true, log_id: log.id, note });
});

// GET /api/v1/presence/notes?siteId=&date= — note di lavorazione per cantiere e data
router.get('/presence/notes', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.query;
  if (!siteId || !date) {
    return res.status(400).json({ error: 'siteId e date obbligatori (YYYY-MM-DD)' });
  }
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date deve essere YYYY-MM-DD' });
  }

  const { data, error } = await supabase
    .from('admin_audit_log')
    .select('id, created_at, payload, user_id')
    .eq('company_id', req.companyId)
    .eq('target_id', siteId)
    .eq('action', 'worker.exit_note')
    .gte('created_at', `${date}T00:00:00+02:00`)
    .lte('created_at', `${date}T23:59:59.999+01:00`)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) return sendDbError(res, error);

  res.json(data.map(n => ({
    id:           n.id,
    created_at:   n.created_at,
    worker_id:    n.payload?.worker_id   || n.user_id,
    worker_name:  n.payload?.worker_name || null,
    note:         n.payload?.note        || '',
    worksite_id:  n.payload?.worksite_id || siteId
  })));
});

// GET /api/v1/presence/history?from=&to=&siteId=&workerId= — storico presenze azienda
router.get('/presence/history', verifySupabaseJwt, async (req, res) => {
  const HISTORY_MAX = 10000;
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const fromDate = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    return res.status(400).json({ error: 'from e to devono essere YYYY-MM-DD' });
  }

  let query = supabase
    .from('presence_logs')
    .select('id, event_type, timestamp_server, worker_id, site_id')
    .eq('company_id', req.companyId)
    .gte('timestamp_server', `${fromDate}T00:00:00+02:00`)
    .lte('timestamp_server', `${toDate}T23:59:59.999+01:00`)
    .order('timestamp_server', { ascending: false })
    .limit(HISTORY_MAX);

  if (req.query.siteId)   query = query.eq('site_id', req.query.siteId);
  if (req.query.workerId) query = query.eq('worker_id', req.query.workerId);

  const { data: logs, error: logsErr } = await query;

  if (logsErr) {
    console.error('[presence/history] logs error:', logsErr.message);
    return res.status(500).json({ error: logsErr.message });
  }
  if (!logs || logs.length === 0) return res.json([]);

  if (logs.length >= HISTORY_MAX) {
    res.setHeader('X-Palladia-Truncated', 'true');
    res.setHeader('X-Palladia-Limit', String(HISTORY_MAX));
  }

  // 2. Recupera worker e site in parallelo (solo quelli effettivamente presenti nei log)
  const workerIds = [...new Set(logs.map(l => l.worker_id).filter(Boolean))];
  const siteIds   = [...new Set(logs.map(l => l.site_id).filter(Boolean))];

  const [workersRes, sitesRes] = await Promise.all([
    supabase
      .from('workers')
      .select('id, full_name, first_name, last_name')
      .in('id', workerIds)
      .eq('company_id', req.companyId),
    supabase
      .from('sites')
      .select('id, name')
      .in('id', siteIds)
      .eq('company_id', req.companyId),
  ]);

  const workerMap = {};
  for (const w of workersRes.data || []) {
    workerMap[w.id] = {
      id:        w.id,
      full_name: w.full_name || [w.first_name, w.last_name].filter(Boolean).join(' ') || '—',
    };
  }
  const siteMap = {};
  for (const s of sitesRes.data || []) {
    siteMap[s.id] = { id: s.id, name: s.name || '—' };
  }

  // F-184 (AUDIT.md): stessa annotazione di GET /presence — un evento anomalo
  // annotato da un admin (glitch tecnico, presence_logs resta append-only)
  // arriva qui allegato, così lo storico/"Ore Lavorate" può ignorarlo nel
  // pairing (vedi lib/presencePairing.js::stripAnnotatedGlitches) invece di
  // mostrare la sessione spezzata in due. Filtra per company_id, non per
  // target_id IN (...): logs può arrivare a HISTORY_MAX=10000 righe su un
  // range di mesi, un IN così grande rischia il limite di lunghezza URL di
  // PostgREST — le annotazioni sono un'azione admin rara, la tabella filtrata
  // per company resta comunque piccola.
  const { data: notes } = await supabase
    .from('admin_audit_log')
    .select('target_id, payload, created_at')
    .eq('company_id', req.companyId)
    .eq('action', 'presence.log_annotation')
    .limit(1000);
  const noteByLogId = {};
  for (const n of (notes || [])) noteByLogId[n.target_id] = { text: n.payload?.note || '', annotated_at: n.created_at };

  const result = logs.map(l => ({
    id:               l.id,
    event_type:       l.event_type,
    timestamp_server: l.timestamp_server,
    worker:           workerMap[l.worker_id] || { id: l.worker_id, full_name: '—' },
    site:             siteMap[l.site_id]     || { id: l.site_id,   name: '—'       },
    annotation:       noteByLogId[l.id] || null,
  }));

  res.json(result);
});

module.exports = router;
