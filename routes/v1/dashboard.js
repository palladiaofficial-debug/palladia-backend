'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

/**
 * GET /api/v1/dashboard
 * Restituisce tutti i KPI della dashboard in un'unica chiamata:
 *   - conteggio cantieri (totale + attivi) + lista top-4 attivi
 *   - conteggio lavoratori attivi
 *   - timbrature di oggi (Roma tz) + chi è presente adesso
 */
router.get('/dashboard', verifySupabaseJwt, async (req, res) => {
  // Data di oggi nel fuso orario Italia
  const todayRome = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' }); // "YYYY-MM-DD"
  // Finestra di 30h per coprire DST e mezzanotte
  const fromUtc = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

  const [sitesResult, workersResult, presenceResult] = await Promise.all([
    supabase
      .from('sites')
      .select('id, name, status')
      .eq('company_id', req.companyId)
      .limit(500),

    supabase
      .from('workers')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', req.companyId)
      .eq('is_active', true),

    supabase
      .from('presence_logs')
      .select(`
        worker_id, event_type, timestamp_server,
        worker:workers (full_name),
        site:sites (name)
      `)
      .eq('company_id', req.companyId)
      .gte('timestamp_server', fromUtc)
      .order('timestamp_server', { ascending: false })
      .limit(500),
  ]);

  if (sitesResult.error)   return res.status(500).json({ error: sitesResult.error.message });
  if (workersResult.error) return res.status(500).json({ error: workersResult.error.message });
  // presenceResult.error non blocca: dashboard graceful degradation

  const sites     = sitesResult.data  || [];
  const allLogs   = presenceResult.data || [];

  // Filtra solo le timbrature di oggi nel fuso Roma
  const todayLogs = allLogs.filter(p => {
    const d = new Date(p.timestamp_server).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
    return d === todayRome;
  });

  // Ultimo evento per worker (ordine DESC già garantito dalla query)
  const lastByWorker = new Map();
  for (const p of todayLogs) {
    if (!lastByWorker.has(p.worker_id)) lastByWorker.set(p.worker_id, p);
  }

  const presentNow = [...lastByWorker.values()]
    .filter(p => p.event_type === 'ENTRY')
    .map(p => ({
      worker_id: p.worker_id,
      name:      p.worker?.full_name ?? '—',
      site:      p.site?.name        ?? '—',
      entrata:   new Date(p.timestamp_server).toLocaleTimeString('it-IT', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
      }),
    }));

  const activeSites = sites.filter(s => s.status === 'attivo');

  res.json({
    sites: {
      total:  sites.length,
      active: activeSites.length,
      top:    activeSites.slice(0, 4).map(s => ({ id: s.id, name: s.name })),
    },
    workers: {
      total: workersResult.count ?? 0,
    },
    today: {
      punches:       todayLogs.length,
      present_count: presentNow.length,
      present:       presentNow.slice(0, 10),
    },
  });
});

module.exports = router;
