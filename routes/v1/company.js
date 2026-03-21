'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// GET /api/v1/company — restituisce profilo azienda
router.get('/company', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, piva, address, phone, contact_email, safety_manager')
    .eq('id', req.companyId)
    .single();

  if (error || !data) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data);
});

// PATCH /api/v1/company — aggiorna profilo azienda (solo owner/admin)
router.patch('/company', verifySupabaseJwt, async (req, res) => {
  // Verifica che l'utente sia owner o admin
  const { data: member } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', req.companyId)
    .eq('user_id', req.userId)
    .maybeSingle();

  if (!member || !['owner', 'admin'].includes(member.role)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const allowed = ['name', 'piva', 'address', 'phone', 'contact_email', 'safety_manager'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = typeof req.body[key] === 'string' ? req.body[key].trim() : req.body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'NO_FIELDS' });
  }

  const { error } = await supabase
    .from('companies')
    .update(updates)
    .eq('id', req.companyId);

  if (error) {
    console.error('[company] update error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  res.json({ ok: true });
});

module.exports = router;
