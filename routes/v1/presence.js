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
      worker:workers (id, full_name, fiscal_code)
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

module.exports = router;
