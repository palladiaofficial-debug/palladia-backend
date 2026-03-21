'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// GET /api/v1/my-company — JWT only, NO X-Company-Id richiesto
// Header opzionale X-Hint-Company-Id: se fornito e valido per l'utente, lo preferisce.
// Questo evita che un utente con più company (es. proprietario + membro invitato)
// venga messo nella company sbagliata dopo un login.
router.get('/my-company', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const jwt = auth.slice(7);

  const { data: authData, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !authData?.user) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const userId = authData.user.id;

  // Se il client ha già un company_id in localStorage, validalo prima
  const hint = req.headers['x-hint-company-id'];
  if (hint) {
    const { data: hinted } = await supabase
      .from('company_users')
      .select('company_id, role')
      .eq('user_id', userId)
      .eq('company_id', hint)
      .maybeSingle();
    if (hinted) {
      return res.json({ company_id: hinted.company_id, role: hinted.role });
    }
    // hint non valido → continua con fallback
  }

  // Fallback: restituisce la prima company trovata ordinata per ruolo
  // (owner > admin > tech > viewer) così il proprietario vede sempre la sua company
  const { data: memberships } = await supabase
    .from('company_users')
    .select('company_id, role')
    .eq('user_id', userId);

  if (!memberships || memberships.length === 0) {
    return res.status(404).json({ error: 'NO_COMPANY' });
  }

  const ROLE_ORDER = { owner: 0, admin: 1, tech: 2, viewer: 3 };
  memberships.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
  const best = memberships[0];

  res.json({ company_id: best.company_id, role: best.role });
});

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
