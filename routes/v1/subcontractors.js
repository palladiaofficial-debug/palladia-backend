'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// ── Helpers ───────────────────────────────────────────────────────────────────

const SELECT_COLS =
  'id, company_name, piva, legal_address, contact_person, phone, email, ' +
  'durc_expiry, visura_date, insurance_expiry, soa_expiry, f24_quarter, ' +
  'notify_expiry, is_active, notes, created_at, updated_at';

// Stato compliance calcolato lato backend in base alle scadenze
function computeStatus(sub) {
  const today = Date.now();
  const daysUntil = (d) => d ? Math.floor((new Date(d) - today) / 86_400_000) : null;
  const days = [
    daysUntil(sub.durc_expiry),
    daysUntil(sub.insurance_expiry),
    daysUntil(sub.soa_expiry),
  ].filter((d) => d !== null);

  if (days.some((d) => d < 0))   return 'non_compliant';
  if (days.some((d) => d <= 30)) return 'expiring';
  return 'compliant';
}

function format(sub) {
  return { ...sub, status: computeStatus(sub) };
}

function isValidDate(v) {
  if (!v || v === '') return true; // vuoto = cancella
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// ── GET /api/v1/subcontractors ────────────────────────────────────────────────
router.get('/subcontractors', verifySupabaseJwt, async (req, res) => {
  const includeArchived = req.query.archived === 'true';
  let query = supabase
    .from('subcontractors')
    .select(SELECT_COLS)
    .eq('company_id', req.companyId)
    .order('company_name', { ascending: true });

  if (!includeArchived) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json((data || []).map(format));
});

// ── POST /api/v1/subcontractors ───────────────────────────────────────────────
router.post('/subcontractors', verifySupabaseJwt, async (req, res) => {
  const {
    company_name, piva, legal_address, contact_person,
    phone, email, durc_expiry, visura_date, insurance_expiry,
    soa_expiry, f24_quarter, notify_expiry, notes,
  } = req.body;

  if (!company_name || !String(company_name).trim())
    return res.status(400).json({ error: 'COMPANY_NAME_REQUIRED' });

  const dateFields = { durc_expiry, visura_date, insurance_expiry, soa_expiry };
  for (const [k, v] of Object.entries(dateFields)) {
    if (!isValidDate(v)) return res.status(400).json({ error: `INVALID_DATE_${k.toUpperCase()}` });
  }

  const { data, error } = await supabase
    .from('subcontractors')
    .insert([{
      company_id:      req.companyId,
      company_name:    String(company_name).trim().slice(0, 200),
      piva:            piva            ? String(piva).trim().slice(0, 20)  : null,
      legal_address:   legal_address  ? String(legal_address).trim().slice(0, 300) : null,
      contact_person:  contact_person ? String(contact_person).trim().slice(0, 150) : null,
      phone:           phone          ? String(phone).trim().slice(0, 30)  : null,
      email:           email          ? String(email).trim().slice(0, 150) : null,
      durc_expiry:     durc_expiry     || null,
      visura_date:     visura_date     || null,
      insurance_expiry: insurance_expiry || null,
      soa_expiry:      soa_expiry      || null,
      f24_quarter:     f24_quarter    ? String(f24_quarter).trim().slice(0, 20) : null,
      notify_expiry:   notify_expiry !== false,
      notes:           notes          ? String(notes).trim().slice(0, 1000) : null,
    }])
    .select(SELECT_COLS)
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json(format(data));
});

// ── PATCH /api/v1/subcontractors/:id ─────────────────────────────────────────
router.patch('/subcontractors/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('subcontractors')
    .select('id')
    .eq('id', id).eq('company_id', req.companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const allowed = [
    'company_name', 'piva', 'legal_address', 'contact_person',
    'phone', 'email', 'durc_expiry', 'visura_date', 'insurance_expiry',
    'soa_expiry', 'f24_quarter', 'notify_expiry', 'notes', 'is_active',
  ];
  const patch = {};
  for (const k of allowed) {
    if (k in req.body) patch[k] = req.body[k] ?? null;
  }
  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: 'NO_FIELDS' });

  const dateFields = ['durc_expiry', 'visura_date', 'insurance_expiry', 'soa_expiry'];
  for (const k of dateFields) {
    if (k in patch && !isValidDate(patch[k]))
      return res.status(400).json({ error: `INVALID_DATE_${k.toUpperCase()}` });
  }

  const { data, error } = await supabase
    .from('subcontractors')
    .update(patch)
    .eq('id', id).eq('company_id', req.companyId)
    .select(SELECT_COLS)
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json(format(data));
});

// ── DELETE /api/v1/subcontractors/:id — soft delete (archivia) ───────────────
router.delete('/subcontractors/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('subcontractors')
    .select('id')
    .eq('id', id).eq('company_id', req.companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const { error } = await supabase
    .from('subcontractors')
    .update({ is_active: false })
    .eq('id', id).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

module.exports = router;
