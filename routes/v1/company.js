'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendMemberRemovedEmail } = require('../../services/email');

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

// GET /api/v1/my-companies — lista tutte le membership dell'utente con nome azienda
// JWT only, NO X-Company-Id richiesto. Usato dal company switcher nel frontend.
router.get('/my-companies', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const jwt = auth.slice(7);

  const { data: authData, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !authData?.user) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const { data: memberships, error: memberErr } = await supabase
    .from('company_users')
    .select('company_id, role, companies(name)')
    .eq('user_id', authData.user.id);

  if (memberErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!memberships || memberships.length === 0) return res.json([]);

  const ROLE_ORDER = { owner: 0, admin: 1, tech: 2, viewer: 3 };
  memberships.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

  res.json(memberships.map(m => ({
    company_id:   m.company_id,
    company_name: m.companies?.name ?? '—',
    role:         m.role,
  })));
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

// PATCH /api/v1/company — aggiorna profilo azienda (owner/admin/tech)
router.patch('/company', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin', 'tech'].includes(req.userRole)) {
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

// DELETE /api/v1/team-members/:userId — rimuove un membro dalla company
// Solo owner/admin. Non si può rimuovere l'owner né se stessi.
router.delete('/team-members/:userId', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const { userId } = req.params;

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'CANNOT_REMOVE_SELF' });
  }

  const { data: target, error: fetchErr } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', req.companyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchErr || !target) {
    return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
  }

  if (target.role === 'owner') {
    return res.status(400).json({ error: 'CANNOT_REMOVE_OWNER' });
  }

  // Solo owner può rimuovere un admin
  if (target.role === 'admin' && req.userRole !== 'owner') {
    return res.status(403).json({ error: 'ONLY_OWNER_CAN_REMOVE_ADMIN' });
  }

  // Recupera email del membro prima di eliminarlo
  const { data: targetAuth } = await supabase.auth.admin.getUserById(userId);
  const targetEmail = targetAuth?.user?.email;

  const { error } = await supabase
    .from('company_users')
    .delete()
    .eq('company_id', req.companyId)
    .eq('user_id', userId);

  if (error) {
    console.error('[team-members] delete error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  // Invia email di notifica (non bloccante)
  if (targetEmail) {
    const { data: company } = await supabase
      .from('companies').select('name').eq('id', req.companyId).single();
    sendMemberRemovedEmail({ to: targetEmail, companyName: company?.name || 'Palladia' })
      .catch(err => console.error('[team-members] email error:', err.message));
  }

  res.json({ ok: true });
});

// PATCH /api/v1/team-members/:userId — modifica ruolo di un membro
router.patch('/team-members/:userId', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const { userId } = req.params;
  const { role }   = req.body || {};

  const allowedRoles = ['admin', 'tech', 'viewer'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'INVALID_ROLE', allowed: allowedRoles });
  }

  const { data: target } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', req.companyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!target) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
  if (target.role === 'owner') return res.status(400).json({ error: 'CANNOT_CHANGE_OWNER_ROLE' });
  if (target.role === 'admin' && req.userRole !== 'owner') {
    return res.status(403).json({ error: 'ONLY_OWNER_CAN_CHANGE_ADMIN_ROLE' });
  }

  const { error } = await supabase
    .from('company_users')
    .update({ role })
    .eq('company_id', req.companyId)
    .eq('user_id', userId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json({ ok: true, role });
});

// POST /api/v1/leave-company — l'utente lascia una company (non quella corrente obbligatoriamente)
// Body: { company_id }  — JWT only, no X-Company-Id obbligatorio
// Blocca se l'utente è l'unico owner rimasto
router.post('/leave-company', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const jwt = auth.slice(7);

  const { data: authData, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !authData?.user) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const userId    = authData.user.id;
  const companyId = req.body?.company_id;
  if (!companyId) return res.status(400).json({ error: 'MISSING_COMPANY_ID' });

  // Verifica membership
  const { data: membership } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!membership) return res.status(404).json({ error: 'NOT_A_MEMBER' });

  // Se è owner, verifica che non sia l'unico owner
  if (membership.role === 'owner') {
    const { data: owners } = await supabase
      .from('company_users')
      .select('user_id')
      .eq('company_id', companyId)
      .eq('role', 'owner');
    if (!owners || owners.length <= 1) {
      return res.status(400).json({ error: 'SOLE_OWNER', message: 'Sei l\'unico proprietario. Trasferisci la proprietà prima di uscire, oppure elimina l\'azienda.' });
    }
  }

  const { error } = await supabase
    .from('company_users')
    .delete()
    .eq('company_id', companyId)
    .eq('user_id', userId);

  if (error) {
    console.error('[leave-company] error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  res.json({ ok: true });
});

// GET /api/v1/my-companies-overview — panoramica di tutte le company dell'utente con conteggi dati
// JWT only. Usato per identificare e pulire aziende duplicate.
router.get('/my-companies-overview', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const jwt = auth.slice(7);

  const { data: authData, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !authData?.user) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const userId = authData.user.id;

  const { data: memberships, error: memberErr } = await supabase
    .from('company_users')
    .select('company_id, role, companies(id, name, created_at, subscription_status, subscription_plan)')
    .eq('user_id', userId);

  if (memberErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!memberships || memberships.length === 0) return res.json([]);

  const overviews = await Promise.all(memberships.map(async (m) => {
    const cid = m.company_id;

    const [
      { count: sitesCount },
      { count: workersCount },
      { count: presenceCount },
      { count: memberCount },
    ] = await Promise.all([
      supabase.from('sites').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      supabase.from('workers').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      supabase.from('company_users').select('id', { count: 'exact', head: true }).eq('company_id', cid),
    ]);

    return {
      company_id:          cid,
      company_name:        m.companies?.name ?? '—',
      role:                m.role,
      created_at:          m.companies?.created_at,
      subscription_status: m.companies?.subscription_status ?? null,
      subscription_plan:   m.companies?.subscription_plan ?? null,
      data_summary: {
        sites:         sitesCount    ?? 0,
        workers:       workersCount  ?? 0,
        presence_logs: presenceCount ?? 0,
        team_members:  memberCount   ?? 0,
      },
      is_empty: (sitesCount ?? 0) === 0 && (workersCount ?? 0) === 0 && (presenceCount ?? 0) === 0,
      can_delete: m.role === 'owner' && (presenceCount ?? 0) === 0,
    };
  }));

  const ROLE_ORDER = { owner: 0, admin: 1, tech: 2, viewer: 3 };
  overviews.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

  res.json(overviews);
});

// DELETE /api/v1/companies/:companyId — l'owner elimina una sua company
// JWT only. Permesso solo se la company non ha timbrature (presenza reale).
// Per company vuote (nessuna timbratura): cancella cascata nell'ordine corretto.
// Per company con timbrature: blocca (dati reali non eliminabili dall'UI).
router.delete('/companies/:companyId', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const jwt = auth.slice(7);

  const { data: authData, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !authData?.user) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const userId        = authData.user.id;
  const { companyId } = req.params;

  // Verifica che l'utente sia owner di questa company
  const { data: membership } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!membership)                  return res.status(403).json({ error: 'FORBIDDEN' });
  if (membership.role !== 'owner')  return res.status(403).json({ error: 'OWNER_ONLY' });

  // Blocca se la company ha timbrature reali (dati irreversibili)
  const { count: presenceCount } = await supabase
    .from('presence_logs')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);

  if (presenceCount && presenceCount > 0) {
    return res.status(400).json({
      error:   'HAS_REAL_DATA',
      message: `Questa azienda ha ${presenceCount} timbrature reali e non può essere eliminata dall'app. Contatta il supporto se è davvero necessario.`,
    });
  }

  console.log(`[delete-company] inizio cancellazione cascata company ${companyId} (owner: ${userId})`);

  // Cancellazione in ordine FK-safe (dalla foglia alla radice)
  // 1. Sessioni badge operai
  await supabase.from('worker_device_sessions').delete().eq('company_id', companyId);
  // 2. Assegnazioni operai-cantieri
  await supabase.from('worksite_workers').delete().eq('company_id', companyId);
  // 3. Operai
  await supabase.from('workers').delete().eq('company_id', companyId);
  // 4. Cantieri (cascade sui propri dati collegati via FK ON DELETE CASCADE)
  await supabase.from('sites').delete().eq('company_id', companyId);
  // 5. Company — cascade elimina automaticamente: company_users, company_invites
  const { error } = await supabase
    .from('companies')
    .delete()
    .eq('id', companyId);

  if (error) {
    console.error('[delete-company] error:', error.message);
    // FK violation residua: ci sono dati che non abbiamo gestito
    return res.status(400).json({
      error:   'HAS_DEPENDENCIES',
      message: 'Ci sono ancora dati collegati a questa azienda. Eliminali manualmente dalla dashboard prima di procedere.',
      detail:  error.message,
    });
  }

  console.log(`[delete-company] company ${companyId} eliminata con successo`);
  res.json({ ok: true });
});

module.exports = router;
