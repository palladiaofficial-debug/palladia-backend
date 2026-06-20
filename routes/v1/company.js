'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { sendMemberRemovedEmail } = require('../../services/email');
const { validate } = require('../../middleware/validate');
const { patchCompanySchema, patchTeamMemberSchema, leaveCompanySchema } = require('../../lib/schemas/company');
const { isFounder } = require('../../lib/founder');

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
      .select('company_id, role, companies(account_type)')
      .eq('user_id', userId)
      .eq('company_id', hint)
      .maybeSingle();
    if (hinted) {
      return res.json({
        company_id:   hinted.company_id,
        role:         hinted.role,
        account_type: hinted.companies?.account_type || 'impresa',
        is_founder:   isFounder(userId),
      });
    }
    // hint non valido → continua con fallback
  }

  // Fallback: restituisce la company più "sana" tra quelle dell'utente.
  // Ordine: abbonamento attivo > trial valido > trial scaduto/canceled, poi per ruolo.
  // Questo evita che un utente membro di un team Pro (come tech) venga mandato
  // sulla propria company con trial scaduto dopo un login da nuovo dispositivo.
  const { data: memberships } = await supabase
    .from('company_users')
    .select('company_id, role, companies(subscription_status, trial_ends_at, account_type)')
    .eq('user_id', userId);

  if (!memberships || memberships.length === 0) {
    return res.status(404).json({ error: 'NO_COMPANY' });
  }

  const ROLE_ORDER = { owner: 0, admin: 1, tech: 2, viewer: 3 };

  function subScore(m) {
    const s = m.companies?.subscription_status;
    if (s === 'active') return 0;
    if (s === 'trial') {
      const trialEnd = m.companies?.trial_ends_at;
      return trialEnd && new Date(trialEnd) > new Date() ? 1 : 3;
    }
    if (s === 'past_due') return 2;
    return 3; // canceled / expired
  }

  memberships.sort((a, b) => {
    const sDiff = subScore(a) - subScore(b);
    if (sDiff !== 0) return sDiff;
    return (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9);
  });

  const best = memberships[0];
  res.json({
    company_id:   best.company_id,
    role:         best.role,
    account_type: best.companies?.account_type || 'impresa',
    is_founder:   isFounder(userId),
  });
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
    .select('id, name, piva, address, phone, contact_email, safety_manager, durc_expiry')
    .eq('id', req.companyId)
    .single();

  if (error || !data) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data);
});

// GET /api/v1/company/defaults — profilo azienda + figure di sicurezza dall'ultimo POS
// Usato da DVR, PIMUS, POS e tutti i generatori di documenti per pre-popolare i form.
router.get('/company/defaults', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;

  const [companyResult, figureResult] = await Promise.allSettled([
    supabase
      .from('companies')
      .select('id, name, piva, address, phone, contact_email, safety_manager')
      .eq('id', companyId)
      .single(),

    // Figura: estrai dall'ultimo POS dell'azienda
    (async () => {
      const { data: sites } = await supabase
        .from('sites')
        .select('id')
        .eq('company_id', companyId)
        .limit(500);
      if (!sites?.length) return null;

      const { data: doc } = await supabase
        .from('pos_documents')
        .select('pos_data')
        .in('site_id', sites.map(s => s.id))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return doc?.pos_data || null;
    })(),
  ]);

  const company = companyResult.status === 'fulfilled' ? companyResult.value.data : null;
  const posData = figureResult.status === 'fulfilled' ? figureResult.value : null;

  const persona = (nome = '', tel = '', email = '', cf = '') =>
    ({ nome, telefono: tel, email, codiceFiscale: cf });

  let figure = null;
  let hasFigureDefaults = false;

  if (posData) {
    figure = {
      ragioneSocialeImpresa: posData.companyName || company?.name || '',
      partitaIvaImpresa:     posData.companyVat  || company?.piva || '',
      responsabileLavori:    persona(posData.responsabileLavori),
      csp:                   persona(posData.csp),
      cse:                   persona(posData.cse, posData.cseTel, posData.cseEmail, posData.cseCf),
      rspp:                  persona(posData.rspp, posData.rsppTel, posData.rsppEmail, posData.rsppCf),
      rls:                   persona(posData.rls, posData.rlsTel),
      medicoCompetente:      { ...persona(posData.medico, posData.medicoTel), firma: '' },
      addettoPrimoSoccorso:  persona(posData.primoSoccorso, posData.primoSoccorsoTel),
      addettoAntincendio:    persona(posData.antincendio, posData.antincendioTel),
      direttoreTecnico:      persona(posData.direttoreTecnico),
      prepostoCantiere:      persona(posData.preposto),
    };
    hasFigureDefaults = !!(posData.rspp || posData.rls || posData.medico || posData.cse);
  }

  res.json({
    company: company ? {
      id:            company.id,
      nome:          company.name          || '',
      partitaIva:    company.piva          || '',
      sedeLegale:    company.address       || '',
      telefono:      company.phone         || '',
      email:         company.contact_email || '',
      safetyManager: company.safety_manager || '',
    } : null,
    figure,
    hasFigureDefaults,
  });
});

// PATCH /api/v1/company — aggiorna profilo azienda (owner/admin/tech)
router.patch('/company', verifySupabaseJwt, validate(patchCompanySchema), async (req, res) => {
  if (!['owner', 'admin', 'tech'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const allowed = ['name', 'piva', 'address', 'phone', 'contact_email', 'safety_manager', 'durc_expiry'];
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
router.patch('/team-members/:userId', verifySupabaseJwt, validate(patchTeamMemberSchema), async (req, res) => {
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
router.post('/leave-company', validate(leaveCompanySchema), async (req, res) => {
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

  console.log(`[delete-company] inizio cancellazione transazionale company ${companyId} (owner: ${userId})`);

  const { error } = await supabase.rpc('delete_company_cascade', { p_company_id: companyId });

  if (error) {
    console.error('[delete-company] error:', error.message);
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
