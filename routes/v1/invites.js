'use strict';
const crypto   = require('crypto');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const APP_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

// ── helpers ──────────────────────────────────────────────────────────────────

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin';
}

// ── POST /api/v1/invites — crea e invia invito ────────────────────────────────

router.post('/invites', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono invitare.' });
  }

  const { email, role } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'INVALID_EMAIL' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const allowedRoles = ['admin', 'tech', 'viewer'];
  if (!role || !allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'INVALID_ROLE', message: 'Ruolo deve essere admin, tech o viewer.' });
  }

  // Verifica che l'email non sia già membro della company
  // (cerca nell'auth chi ha quell'email, poi controlla company_users)
  const { data: existingUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const existingUser = existingUsers?.users?.find(u => u.email?.toLowerCase() === normalizedEmail);
  if (existingUser) {
    const { data: alreadyMember } = await supabase
      .from('company_users')
      .select('role')
      .eq('company_id', req.companyId)
      .eq('user_id', existingUser.id)
      .maybeSingle();
    if (alreadyMember) {
      return res.status(409).json({ error: 'ALREADY_MEMBER', message: 'Questo utente è già nel team.' });
    }
  }

  // Verifica che non esista già un invito pendente per questa email+company
  const { data: pendingInvite } = await supabase
    .from('company_invites')
    .select('id, expires_at')
    .eq('company_id', req.companyId)
    .eq('email', normalizedEmail)
    .is('used_at', null)
    .gte('expires_at', new Date().toISOString())
    .maybeSingle();

  if (pendingInvite) {
    return res.status(409).json({ error: 'INVITE_PENDING', message: 'Esiste già un invito attivo per questa email.' });
  }

  // Genera token sicuro (32 byte hex = 64 caratteri)
  const token = crypto.randomBytes(32).toString('hex');

  // Recupera info dell'invitante
  const inviterName = req.user.email;

  // Recupera nome company
  const { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', req.companyId)
    .single();

  const companyName = company?.name || 'Palladia';

  // Inserisci invito nel DB
  const { data: invite, error: insertError } = await supabase
    .from('company_invites')
    .insert({
      company_id:  req.companyId,
      email:       normalizedEmail,
      role,
      token,
      invited_by:  req.user.id,
    })
    .select()
    .single();

  if (insertError) {
    console.error('[invites] insert error:', insertError.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  const inviteUrl = `${APP_URL}/invito/${token}`;

  res.status(201).json({
    id:         invite.id,
    email:      invite.email,
    role:       invite.role,
    expires_at: invite.expires_at,
    invite_url: inviteUrl, // utile per debug/copia-link
  });
});

// ── GET /api/v1/invites — lista inviti pendenti ───────────────────────────────

router.get('/invites', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const { data, error } = await supabase
    .from('company_invites')
    .select('id, email, role, token, created_at, expires_at, used_at')
    .eq('company_id', req.companyId)
    .is('used_at', null)
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  // Aggiunge invite_url e rimuove il token raw dalla risposta
  const result = (data || []).map(({ token, ...rest }) => ({
    ...rest,
    invite_url: `${APP_URL}/invito/${token}`,
  }));

  res.json(result);
});

// ── DELETE /api/v1/invites/:id — revoca invito ────────────────────────────────

router.delete('/invites/:id', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const { error } = await supabase
    .from('company_invites')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId); // sicurezza: solo inviti della tua company

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json({ ok: true });
});

// ── GET /api/v1/invites/accept/:token — valida token (PUBBLICA) ───────────────
// Usata dal frontend per mostrare i dettagli dell'invito prima di accettare

router.get('/invites/accept/:token', async (req, res) => {
  const { token } = req.params;

  const { data: invite, error } = await supabase
    .from('company_invites')
    .select('id, email, role, expires_at, used_at, company_id')
    .eq('token', token)
    .maybeSingle();

  if (error || !invite) {
    return res.status(404).json({ error: 'INVITE_NOT_FOUND', message: 'Invito non trovato o non valido.' });
  }
  if (invite.used_at) {
    return res.status(410).json({ error: 'INVITE_USED', message: 'Questo invito è già stato utilizzato.' });
  }
  if (new Date(invite.expires_at) < new Date()) {
    return res.status(410).json({ error: 'INVITE_EXPIRED', message: 'Questo invito è scaduto.' });
  }

  // Recupera nome company + controlla se la email ha già un account Palladia
  const [{ data: company }, { data: existingUsers }] = await Promise.all([
    supabase.from('companies').select('name').eq('id', invite.company_id).single(),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  const hasAccount = existingUsers?.users?.some(
    u => u.email?.toLowerCase() === invite.email.toLowerCase()
  ) ?? false;

  res.json({
    valid:        true,
    email:        invite.email,
    role:         invite.role,
    company_name: company?.name || '—',
    expires_at:   invite.expires_at,
    has_account:  hasAccount,
  });
});

// ── POST /api/v1/invites/accept/:token — accetta invito (JWT richiesto) ────────

router.post('/invites/accept/:token', async (req, res) => {
  // Valida JWT manualmente (non usiamo verifySupabaseJwt perché non c'è X-Company-Id)
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'INVALID_TOKEN' });
    user = data.user;
  } catch {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }

  const { token } = req.params;

  // Carica invito
  const { data: invite, error: inviteErr } = await supabase
    .from('company_invites')
    .select('id, email, role, expires_at, used_at, company_id')
    .eq('token', token)
    .maybeSingle();

  if (inviteErr || !invite) {
    return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
  }
  if (invite.used_at) {
    return res.status(410).json({ error: 'INVITE_USED', message: 'Invito già utilizzato.' });
  }
  if (new Date(invite.expires_at) < new Date()) {
    return res.status(410).json({ error: 'INVITE_EXPIRED', message: 'Invito scaduto.' });
  }

  // Sicurezza: l'email dell'utente loggato deve corrispondere all'email dell'invito
  if (user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return res.status(403).json({
      error:   'EMAIL_MISMATCH',
      message: `Questo invito è destinato a ${invite.email}. Sei loggato come ${user.email}.`,
    });
  }

  // Verifica che l'utente non sia già membro
  const { data: alreadyMember } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', invite.company_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (alreadyMember) {
    // Marca comunque l'invito come usato
    await supabase.from('company_invites').update({ used_at: new Date().toISOString(), used_by: user.id }).eq('id', invite.id);
    return res.json({ ok: true, company_id: invite.company_id, already_member: true });
  }

  // Aggiungi l'utente alla company
  const { error: insertErr } = await supabase
    .from('company_users')
    .insert({ company_id: invite.company_id, user_id: user.id, role: invite.role });

  if (insertErr) {
    console.error('[invites] company_users insert error:', insertErr.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  // Marca invito come usato
  await supabase
    .from('company_invites')
    .update({ used_at: new Date().toISOString(), used_by: user.id })
    .eq('id', invite.id);

  res.json({ ok: true, company_id: invite.company_id });
});

module.exports = router;
