'use strict';
const crypto  = require('crypto');
const router  = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog }          = require('../../lib/audit');

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Genera codice badge univoco: 9 byte → 18 char hex uppercase
// Spazio 2^72 — praticamente non enumerabile
function generateBadgeCode() {
  return crypto.randomBytes(9).toString('hex').toUpperCase();
}

// Campi badge opzionali accettati in POST e PATCH
const BADGE_FIELDS = [
  'photo_url',
  'hire_date',
  'qualification',
  'role',
  'employer_name',
  'subcontracting_auth',
  'safety_training_expiry',
  'health_fitness_expiry',
  'birth_place',
];

// Validazione date YYYY-MM-DD (o null/undefined per cancellare)
function isValidDate(val) {
  if (val === null || val === undefined || val === '') return true; // accettato come "cancella"
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

// Colonne restituite nelle query GET
const WORKER_SELECT =
  'id, full_name, fiscal_code, is_active, created_at, badge_code, ' +
  'photo_url, hire_date, qualification, role, employer_name, ' +
  'subcontracting_auth, safety_training_expiry, health_fitness_expiry, birth_place';

// ── POST /api/v1/workers — crea lavoratore (PRIVATO) ─────────────────────────
router.post('/workers', verifySupabaseJwt, async (req, res) => {
  const {
    full_name, fiscal_code,
    photo_url, hire_date, qualification, role,
    employer_name, subcontracting_auth,
    safety_training_expiry, health_fitness_expiry,
  } = req.body;

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
  for (const f of ['hire_date', 'safety_training_expiry', 'health_fitness_expiry']) {
    if (req.body[f] !== undefined && !isValidDate(req.body[f])) {
      return res.status(400).json({ error: `${f} deve essere YYYY-MM-DD` });
    }
  }

  const nameParts  = parseFullName(full_name);
  const badge_code = generateBadgeCode();

  const record = {
    company_id:  req.companyId,
    full_name:   nameParts.full_name,
    fiscal_code: fiscal_code.toUpperCase().trim(),
    badge_code,
  };

  // Aggiungi campi badge opzionali se presenti
  if (photo_url              !== undefined) record.photo_url              = photo_url              || null;
  if (hire_date              !== undefined) record.hire_date              = hire_date              || null;
  if (qualification          !== undefined) record.qualification          = qualification          ? String(qualification).trim() : null;
  if (role                   !== undefined) record.role                   = role                   ? String(role).trim()          : null;
  if (employer_name          !== undefined) record.employer_name          = employer_name          ? String(employer_name).trim() : null;
  if (subcontracting_auth    !== undefined) record.subcontracting_auth    = Boolean(subcontracting_auth);
  if (safety_training_expiry !== undefined) record.safety_training_expiry = safety_training_expiry || null;
  if (health_fitness_expiry  !== undefined) record.health_fitness_expiry  = health_fitness_expiry  || null;

  const { data, error } = await supabase
    .from('workers')
    .insert([record])
    .select(WORKER_SELECT)
    .single();

  // Duplicate fiscal_code nella stessa company
  if (error?.code === '23505' && error.message.includes('fiscal')) {
    return res.status(409).json({ error: 'WORKER_ALREADY_EXISTS' });
  }
  // Duplicate badge_code (collisione crittografica — probabilità trascurabile, ma gestiamo)
  if (error?.code === '23505' && error.message.includes('badge_code')) {
    // Retry automatico con un nuovo codice
    record.badge_code = generateBadgeCode();
    const retry = await supabase.from('workers').insert([record]).select(WORKER_SELECT).single();
    if (retry.error) return res.status(400).json({ error: retry.error.message });
    auditLog({ companyId: req.companyId, userId: req.user?.id, userRole: req.userRole,
      action: 'worker.create', targetType: 'worker', targetId: retry.data.id,
      payload: { full_name: retry.data.full_name, fiscal_code: retry.data.fiscal_code }, req });
    return res.status(201).json(retry.data);
  }
  if (error) return res.status(400).json({ error: error.message });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.create',
    targetType: 'worker',
    targetId:   data.id,
    payload:    { full_name: data.full_name, fiscal_code: data.fiscal_code, badge_code: data.badge_code },
    req,
  });

  res.status(201).json(data);
});

// ── GET /api/v1/workers?siteId= — lista lavoratori (PRIVATO) ─────────────────
// Con siteId: solo i lavoratori associati a quel cantiere (stessa company).
// Senza siteId: tutti i lavoratori attivi dell'azienda.
router.get('/workers', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.query;

  if (siteId) {
    const { data, error } = await supabase
      .from('worksite_workers')
      .select(`
        id, status, start_date, end_date,
        worker:workers (${WORKER_SELECT})
      `)
      .eq('site_id', siteId)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  const { data, error } = await supabase
    .from('workers')
    .select(WORKER_SELECT)
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('full_name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/v1/workers/:workerId — dettaglio singolo lavoratore (PRIVATO) ────
router.get('/workers/:workerId', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;

  const { data, error } = await supabase
    .from('workers')
    .select(WORKER_SELECT)
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  res.json(data);
});

// ── POST /api/v1/sites/:siteId/workers — autorizza lavoratore su cantiere ─────
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
        end_date:   end_date   || null,
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
    req,
  });

  res.status(201).json(data);
});

// ── DELETE /api/v1/sites/:siteId/workers/:workerId — rimuovi lavoratore ───────
router.delete('/sites/:siteId/workers/:workerId', verifySupabaseJwt, async (req, res) => {
  const { siteId, workerId } = req.params;

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
    req,
  });

  res.status(204).end();
});

// ── PATCH /api/v1/workers/:workerId — aggiorna lavoratore ────────────────────
router.patch('/workers/:workerId', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;

  const ALLOWED = [
    'full_name', 'is_active',
    ...BADGE_FIELDS,
  ];

  const updates = {};
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'NO_FIELDS' });
  }

  // Validazione campi data
  for (const f of ['hire_date', 'safety_training_expiry', 'health_fitness_expiry']) {
    if (updates[f] !== undefined && !isValidDate(updates[f])) {
      return res.status(400).json({ error: `${f} deve essere YYYY-MM-DD o null` });
    }
    // Converti stringa vuota in null
    if (updates[f] === '') updates[f] = null;
  }

  // Normalizza stringhe testuali
  for (const f of ['qualification', 'role', 'employer_name', 'birth_place']) {
    if (updates[f] !== undefined) {
      updates[f] = updates[f] ? String(updates[f]).trim() : null;
    }
  }

  const { data, error } = await supabase
    .from('workers')
    .update(updates)
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .select(WORKER_SELECT)
    .single();

  if (error || !data) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'worker.update',
    targetType: 'worker',
    targetId:   workerId,
    payload:    updates,
    req,
  });

  res.json(data);
});

module.exports = router;
