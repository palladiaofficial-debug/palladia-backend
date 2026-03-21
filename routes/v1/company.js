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
  if (!['owner', 'admin'].includes(req.userRole)) {
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

// GET /api/v1/team-members — lista utenti della company con info auth
router.get('/team-members', verifySupabaseJwt, async (req, res) => {
  const { data: members, error } = await supabase
    .from('company_users')
    .select('user_id, role')
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const result = await Promise.all(members.map(async (m) => {
    const { data: authData } = await supabase.auth.admin.getUserById(m.user_id);
    const u = authData?.user;
    return {
      user_id: m.user_id,
      role:    m.role,
      email:   u?.email || '—',
      name:    u?.user_metadata?.full_name || u?.email || '—',
    };
  }));

  res.json(result);
});

module.exports = router;
