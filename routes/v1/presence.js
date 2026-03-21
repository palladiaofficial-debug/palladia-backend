'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

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

  const { data, error } = await supabase
    .from('presence_logs')
    .select(`
      id, event_type, timestamp_server, distance_m, method,
      worker:workers (id, full_name, first_name, last_name, fiscal_code)
    `)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)                     // isola sulla company verificata
    .gte('timestamp_server', `${date}T00:00:00.000Z`)
    .lte('timestamp_server', `${date}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: true })
    .limit(PRESENCE_MAX_ROWS);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    .gte('created_at', `${date}T00:00:00.000Z`)
    .lte('created_at', `${date}T23:59:59.999Z`)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) return res.status(500).json({ error: error.message });

  res.json(data.map(n => ({
    id:           n.id,
    created_at:   n.created_at,
    worker_id:    n.payload?.worker_id   || n.user_id,
    worker_name:  n.payload?.worker_name || null,
    note:         n.payload?.note        || '',
    worksite_id:  n.payload?.worksite_id || siteId
  })));
});

// GET /api/v1/presence/history?from=&to= — storico presenze azienda (tutti i cantieri)
router.get('/presence/history', verifySupabaseJwt, async (req, res) => {
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const fromDate = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    return res.status(400).json({ error: 'from e to devono essere YYYY-MM-DD' });
  }

  // 1. Carica i log di presenza (senza join embedded — più robusto)
  const { data: logs, error: logsErr } = await supabase
    .from('presence_logs')
    .select('id, event_type, timestamp_server, worker_id, site_id')
    .eq('company_id', req.companyId)
    .gte('timestamp_server', `${fromDate}T00:00:00.000Z`)
    .lte('timestamp_server', `${toDate}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: false })
    .limit(2000);

  if (logsErr) {
    console.error('[presence/history] logs error:', logsErr.message);
    return res.status(500).json({ error: logsErr.message });
  }
  if (!logs || logs.length === 0) return res.json([]);

  // 2. Recupera worker e site in parallelo (solo quelli effettivamente presenti nei log)
  const workerIds = [...new Set(logs.map(l => l.worker_id).filter(Boolean))];
  const siteIds   = [...new Set(logs.map(l => l.site_id).filter(Boolean))];

  const [workersRes, sitesRes] = await Promise.all([
    supabase
      .from('workers')
      .select('id, full_name, first_name, last_name')
      .in('id', workerIds),
    supabase
      .from('sites')
      .select('id, name')
      .in('id', siteIds),
  ]);

  // Mappa id → oggetto per lookup O(1)
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

  // 3. Arricchisci i log con i dati di worker e site
  const result = logs.map(l => ({
    id:               l.id,
    event_type:       l.event_type,
    timestamp_server: l.timestamp_server,
    worker:           workerMap[l.worker_id] || { id: l.worker_id, full_name: '—' },
    site:             siteMap[l.site_id]     || { id: l.site_id,   name: '—'       },
  }));

  res.json(result);
});

module.exports = router;
