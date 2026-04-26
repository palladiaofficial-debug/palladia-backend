'use strict';
/**
 * routes/v1/sitesOverview.js
 * Vista 360° cantieri — cruscotto con tutti i KPI in una sola chiamata.
 *
 * GET /api/v1/sites/overview
 *   Restituisce tutti i cantieri attivi/sospesi con:
 *   - presenze live (chi è in cantiere ora)
 *   - SAL% e budget
 *   - countdown scadenza (giorni rimanenti)
 *   - NC aperte
 *   - CSE collegato
 *   - stato documenti (aziendali + specifici)
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// Documenti obbligatori per cantiere
const REQUIRED_SITE_DOCS    = ['pos', 'notifica_asl'];
// Documenti aziendali fondamentali
const REQUIRED_COMPANY_DOCS = ['durc', 'visura', 'dvr'];

function daysRemaining(endDateStr) {
  if (!endDateStr) return null;
  const end  = new Date(endDateStr);
  const now  = new Date();
  now.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.ceil((end - now) / 86400000);
}

function todayUtcStart() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function safetyLevel(openNc, hasActiveCse, totalWorkers) {
  if (openNc === 0 && hasActiveCse && totalWorkers > 0) return 'conforme';
  if (openNc === 0 && !hasActiveCse) return 'attenzione';
  if (openNc >= 1 && openNc <= 2)   return 'attenzione';
  if (openNc >= 3)                   return 'critico';
  return 'attenzione';
}

// ── GET /api/v1/sites/overview ────────────────────────────────────────────────
router.get('/sites/overview', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;

  // 1. Tutti i cantieri non eliminati
  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, name, address, status, client, start_date, end_date, budget_totale, sal_percentuale')
    .eq('company_id', companyId)
    .neq('status', 'eliminato')
    .order('name');

  if (sitesErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!sites || sites.length === 0) return res.json([]);

  const siteIds = sites.map(s => s.id);
  const today   = todayUtcStart();

  // 2. Query batch parallele
  const [presRes, ncRes, cseRes, siteDocsRes, companyDocsRes, workersRes] = await Promise.all([
    // Timbrature di oggi (per live presences)
    supabase
      .from('presence_logs')
      .select('site_id, worker_id, event_type, timestamp_server')
      .eq('company_id', companyId)
      .in('site_id', siteIds)
      .gte('timestamp_server', today)
      .order('timestamp_server', { ascending: false }),

    // NC non chiuse
    supabase
      .from('site_nonconformities')
      .select('site_id, status, severity')
      .eq('company_id', companyId)
      .in('site_id', siteIds)
      .neq('status', 'chiusa'),

    // Inviti coordinatori attivi
    supabase
      .from('site_coordinator_invites')
      .select('site_id, coordinator_name, coordinator_email')
      .eq('company_id', companyId)
      .in('site_id', siteIds)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString()),

    // Documenti specifici del cantiere
    supabase
      .from('site_documents')
      .select('site_id, category')
      .eq('company_id', companyId)
      .in('site_id', siteIds),

    // Documenti aziendali (una volta per company)
    supabase
      .from('company_documents')
      .select('category')
      .eq('company_id', companyId),

    // Lavoratori assegnati per cantiere
    supabase
      .from('worksite_workers')
      .select('site_id, worker_id, status, workers(full_name)')
      .eq('company_id', companyId)
      .in('site_id', siteIds)
      .eq('status', 'active'),
  ]);

  // 3. Indicizza i risultati per siteId
  const presenceLogs   = presRes.data   || [];
  const allNc          = ncRes.data     || [];
  const cseInvites     = cseRes.data    || [];
  const siteDocs       = siteDocsRes.data || [];
  const companyDocs    = companyDocsRes.data || [];
  const siteWorkers    = workersRes.data || [];

  // Categorie aziendali presenti
  const companyDocCategories = new Set(companyDocs.map(d => d.category));

  // Live presences: per ogni (site_id, worker_id) l'ultimo log di oggi
  const latestByWorker = new Map(); // key: `${siteId}:${workerId}`
  for (const log of presenceLogs) {
    const key = `${log.site_id}:${log.worker_id}`;
    if (!latestByWorker.has(key)) latestByWorker.set(key, log); // già ordinati DESC
  }

  // 4. Assembla per ogni cantiere
  const overview = sites.map(site => {
    // Live presences
    const onSite = [];
    for (const [key, log] of latestByWorker) {
      if (log.site_id === site.id && log.event_type === 'ENTRY') {
        onSite.push(log.worker_id);
      }
    }

    // Nomi lavoratori on-site (da worksite_workers join workers)
    const assignedWorkers = siteWorkers.filter(w => w.site_id === site.id);
    const onSiteSet       = new Set(onSite);
    const onSiteNames     = assignedWorkers
      .filter(w => onSiteSet.has(w.worker_id))
      .map(w => w.workers?.full_name)
      .filter(Boolean)
      .slice(0, 5);

    // NC aperte
    const siteNc   = allNc.filter(nc => nc.site_id === site.id);
    const openNc   = siteNc.length;
    const hasHigh  = siteNc.some(nc => nc.severity === 'alta' || nc.severity === 'critica');

    // CSE
    const cse          = cseInvites.find(c => c.site_id === site.id) || null;
    const hasActiveCse = !!cse;

    // Documenti cantiere: categorie presenti
    const siteDocCats = new Set(
      siteDocs.filter(d => d.site_id === site.id).map(d => d.category)
    );
    const missingSiteDocs    = REQUIRED_SITE_DOCS.filter(c => !siteDocCats.has(c));
    const missingCompanyDocs = REQUIRED_COMPANY_DOCS.filter(c => !companyDocCategories.has(c));
    const missingDocs        = [...missingCompanyDocs, ...missingSiteDocs];

    // Sicurezza
    const safety = hasHigh ? 'critico' : safetyLevel(openNc, hasActiveCse, assignedWorkers.length);

    return {
      id:              site.id,
      name:            site.name,
      address:         site.address,
      status:          site.status,
      client:          site.client,
      startDate:       site.start_date,
      endDate:         site.end_date,
      daysRemaining:   daysRemaining(site.end_date),
      sal:             site.sal_percentuale ?? 0,
      budget:          site.budget_totale,
      liveCount:       onSite.length,
      onSiteNames,
      totalWorkers:    assignedWorkers.length,
      openNc,
      hasActiveCse,
      cseName:         cse?.coordinator_name ?? null,
      safetyStatus:    safety,
      missingDocs,
    };
  });

  res.json(overview);
});

module.exports = router;
