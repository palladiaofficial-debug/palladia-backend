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
const { apiLimiter } = require('../../middleware/rateLimit');
const { sendMissingExitAlert } = require('../../services/email');
const { validate } = require('../../middleware/validate');
const { checkMissingExitsSchema } = require('../../lib/schemas/alerts');

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
router.post('/alerts/check-missing-exits', verifySupabaseJwt, apiLimiter, validate(checkMissingExitsSchema), async (req, res) => {
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
// Raggruppa per worker_id GLOBALE (non per worker+cantiere) — evita di segnalare
// due volte un lavoratore che si è spostato tra cantieri nella stessa giornata.
// Un lavoratore è "missing exit" solo se il suo ULTIMO evento del giorno (su
// qualsiasi cantiere) è un ENTRY.
async function findMissingExits(companyId, siteId, date) {
  // Range allargato di 2h per coprire CET/CEST; filtro preciso in-memory
  const fromUtc = new Date(`${date}T00:00:00Z`);
  fromUtc.setUTCHours(fromUtc.getUTCHours() - 2);
  const toUtc = new Date(`${date}T23:59:59Z`);
  toUtc.setUTCHours(toUtc.getUTCHours() + 2);

  let query = supabase
    .from('presence_logs')
    .select(`
      worker_id, event_type, timestamp_server, site_id,
      worker:workers (id, full_name, fiscal_code)
    `)
    .eq('company_id', companyId)
    .gte('timestamp_server', fromUtc.toISOString())
    .lte('timestamp_server', toUtc.toISOString())
    .order('timestamp_server', { ascending: true })
    .limit(5000);

  if (siteId) query = query.eq('site_id', siteId);

  const { data: rawLogs, error } = await query;
  if (error) return { error: error.message };

  // Filtra precisamente per giorno Roma
  const logs = (rawLogs || []).filter(log => {
    const d = new Date(log.timestamp_server).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
    return d === date;
  });

  // Ultimo evento PER LAVORATORE (globale, non per cantiere)
  const lastByWorker = new Map();
  const siteIds      = new Set();

  for (const log of (logs || [])) {
    lastByWorker.set(log.worker_id, log); // logs ordinati asc → l'ultimo sovrascrive
    siteIds.add(log.site_id);
  }

  const siteMap = {};
  if (siteIds.size > 0) {
    const { data: sitesData } = await supabase
      .from('sites')
      .select('id, name, address')
      .in('id', Array.from(siteIds));
    for (const s of (sitesData || [])) siteMap[s.id] = s;
  }

  const missing = [];
  for (const [, log] of lastByWorker) {
    if (log.event_type === 'ENTRY') {
      const site = siteMap[log.site_id];
      missing.push({
        worker_id:       log.worker?.id,
        worker_name:     log.worker?.full_name,
        fiscal_code:     log.worker?.fiscal_code,
        site_id:         log.site_id,
        site_name:       site?.name,
        site_address:    site?.address,
        last_entry_time: log.timestamp_server
      });
    }
  }

  return { data: missing };
}

module.exports = router;
