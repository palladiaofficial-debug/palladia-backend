'use strict';
// ── Alert uscite mancanti ─────────────────────────────────────────────────────
// POST /api/v1/alerts/check-missing-exits
//   Trova lavoratori con ENTRY come ultima timbratura nella data indicata.
//   Invia email agli admin della company e risponde con il riepilogo.
//
// Chiamabile da:
//   - Cron job esterno (con JWT service o chiave API interna)
//   - Frontend admin (fine giornata)
// ─────────────────────────────────────────────────────────────────────────────
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendMissingExitAlert } = require('../../services/email');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/v1/alerts/missing-exits?siteId=&date= — controlla uscite mancanti
// Risponde senza inviare email (read-only check).
router.get('/alerts/missing-exits', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.query;

  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date obbligatorio (YYYY-MM-DD)' });
  }

  const missing = await findMissingExits(req.companyId, siteId || null, date);
  if (missing.error) return res.status(500).json({ error: missing.error });

  res.json({ date, missing_exits: missing.data });
});

// POST /api/v1/alerts/check-missing-exits — controlla e invia email
// body: { siteId?, date, notify? }  (notify=false → solo check, no email)
router.post('/alerts/check-missing-exits', verifySupabaseJwt, async (req, res) => {
  const { siteId, date, notify = true } = req.body;

  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date obbligatorio (YYYY-MM-DD)' });
  }

  const missing = await findMissingExits(req.companyId, siteId || null, date);
  if (missing.error) return res.status(500).json({ error: missing.error });

  const missingList = missing.data;

  // Invia email se richiesto e ci sono uscite mancanti
  let emailSent = false;
  let emailError = null;

  if (notify && missingList.length > 0) {
    try {
      await sendMissingExitAlert({
        companyId: req.companyId,
        date,
        missingList
      });
      emailSent = true;
    } catch (e) {
      console.error('[alerts] email error:', e.message);
      emailError = e.message;
    }
  }

  res.json({
    date,
    missing_count: missingList.length,
    missing_exits: missingList,
    email_sent:    emailSent,
    email_error:   emailError || undefined
  });
});

// ── Helper: trova lavoratori con ENTRY come ultimo evento nel giorno ──────────
async function findMissingExits(companyId, siteId, date) {
  // Prende tutti i log del giorno per la company (+ eventuale filtro cantiere)
  let query = supabase
    .from('presence_logs')
    .select(`
      worker_id, event_type, timestamp_server, site_id,
      worker:workers (id, full_name, fiscal_code),
      site:sites (id, name, address)
    `)
    .eq('company_id', companyId)
    .gte('timestamp_server', `${date}T00:00:00.000Z`)
    .lte('timestamp_server', `${date}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: true })
    .limit(10000);

  if (siteId) query = query.eq('site_id', siteId);

  const { data: logs, error } = await query;
  if (error) return { error: error.message };

  // Raggruppa per worker_id + site_id → trova l'ultimo evento
  // Se l'ultimo è ENTRY → uscita mancante
  const lastByWorkerSite = new Map();

  for (const log of (logs || [])) {
    const key = `${log.worker_id}::${log.site_id}`;
    lastByWorkerSite.set(key, log);  // sovrascrive → last wins (logs ordinati asc)
  }

  const missing = [];
  for (const [, log] of lastByWorkerSite) {
    if (log.event_type === 'ENTRY') {
      missing.push({
        worker_id:       log.worker?.id,
        worker_name:     log.worker?.full_name,
        fiscal_code:     log.worker?.fiscal_code,
        site_id:         log.site_id,
        site_name:       log.site?.name,
        site_address:    log.site?.address,
        last_entry_time: log.timestamp_server
      });
    }
  }

  return { data: missing };
}

module.exports = router;
