'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog }          = require('../../lib/audit');

// CF italiano: 16 char alfanumerici (uppercase)
function isValidFiscalCode(cf) {
  return typeof cf === 'string' && /^[A-Z0-9]{16}$/i.test(cf.trim());
}

function parseFullName(fullName) {
  const trimmed  = String(fullName).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const firstName = spaceIdx > -1 ? trimmed.slice(0, spaceIdx) : trimmed;
  const lastName  = spaceIdx > -1 ? trimmed.slice(spaceIdx + 1).trim() || null : null;
  return { first_name: firstName, last_name: lastName, full_name: trimmed };
}

// POST /api/v1/workers — crea lavoratore (PRIVATO)
router.post('/workers', verifySupabaseJwt, async (req, res) => {
  const { full_name, fiscal_code } = req.body;

  if (!full_name || String(full_name).trim().length < 2) {
    return res.status(400).json({ error: 'full_name obbligatorio (min 2 caratteri)' });
  }
  if (String(full_name).trim().length > 200) {
    return res.status(400).json({ error: 'full_name troppo lungo (max 200 caratteri)' });
  }
  if (!fiscal_code) {
    return res.status(400).json({ error: 'fiscal_code obbligatorio' });
  }
  if (!isValidFiscalCode(fiscal_code)) {
    return res.status(400).json({ error: 'INVALID_FISCAL_CODE' });
  }

  const nameParts = parseFullName(full_name);
  const { data, error } = await supabase
    .from('workers')
    .insert([{
      company_id:  req.companyId,       // verificato da middleware
      ...nameParts,
      fiscal_code: fiscal_code.toUpperCase().trim()
    }])
    .select('id, full_name, first_name, last_name, fiscal_code, is_active, created_at')
    .single();

  // Duplicate fiscal_code nella stessa company
  if (error?.code === '23505') {
    return res.status(409).json({ error: 'WORKER_ALREADY_EXISTS' });
  }
  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.create',
    targetType: 'worker',
    targetId:   data.id,
    payload:    { full_name: data.full_name, fiscal_code: data.fiscal_code },
    req
  });

  res.status(201).json(data);
});

// GET /api/v1/workers?siteId= — lista lavoratori (PRIVATO)
// Con siteId: solo i lavoratori associati a quel cantiere (stessa company).
// Senza siteId: tutti i lavoratori attivi dell'azienda.
router.get('/workers', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.query;

  if (siteId) {
    const { data, error } = await supabase
      .from('worksite_workers')
      .select(`
        id, status, start_date, end_date,
        worker:workers (id, full_name, fiscal_code, is_active)
      `)
      .eq('site_id', siteId)
      .eq('company_id', req.companyId);   // isola sulla company verificata

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  const { data, error } = await supabase
    .from('workers')
    .select('id, full_name, fiscal_code, is_active, created_at')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('full_name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/v1/sites/:siteId/workers — autorizza lavoratore su cantiere (PRIVATO)
router.post('/sites/:siteId/workers', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { worker_id, start_date, end_date } = req.body;

  if (!worker_id) return res.status(400).json({ error: 'worker_id obbligatorio' });

  // Verifica che il worker appartenga alla company dell'utente autenticato
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .select('id')
    .eq('id', worker_id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (wErr || !worker) {
    return res.status(403).json({ error: 'Worker non trovato o non appartiene alla tua azienda' });
  }

  const { data, error } = await supabase
    .from('worksite_workers')
    .upsert(
      [{
        company_id: req.companyId,
        site_id:    siteId,
        worker_id,
        status:     'active',
        start_date: start_date || null,
        end_date:   end_date   || null
      }],
      { onConflict: 'site_id,worker_id' }
    )
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.assign_site',
    targetType: 'worker',
    targetId:   worker_id,
    payload:    { site_id: siteId, start_date, end_date },
    req
  });

  res.status(201).json(data);
});

// DELETE /api/v1/sites/:siteId/workers/:workerId — rimuovi lavoratore dal cantiere (PRIVATO)
router.delete('/sites/:siteId/workers/:workerId', verifySupabaseJwt, async (req, res) => {
  const { siteId, workerId } = req.params;

  // Verifica che il cantiere appartenga alla company dell'utente
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr || !site) {
    return res.status(403).json({ error: 'Cantiere non trovato o non appartiene alla tua azienda' });
  }

  const { error } = await supabase
    .from('worksite_workers')
    .delete()
    .eq('site_id', siteId)
    .eq('worker_id', workerId)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.remove_from_site',
    targetType: 'worker',
    targetId:   workerId,
    payload:    { site_id: siteId },
    req
  });

  res.status(204).end();
});

module.exports = router;
