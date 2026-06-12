'use strict';
// ── Onboarding lavoratore self-service ────────────────────────────────────────
//
// PRIVATO (JWT):
//   POST /api/v1/worker-invite-links         — crea link invito
//   GET  /api/v1/worker-invite-links         — lista link attivi
//   DELETE /api/v1/worker-invite-links/:id   — revoca link
//   GET  /api/v1/workers/pending             — lavoratori in attesa di approvazione
//   PATCH /api/v1/workers/:id/approve        — approva o rifiuta lavoratore
//
// PUBBLICO (token):
//   GET  /api/v1/onboard/:token              — info link (azienda, cantiere, scadenza)
//   POST /api/v1/onboard/:token              — lavoratore compila dati e li invia
// ─────────────────────────────────────────────────────────────────────────────

const router   = require('express').Router();
const crypto   = require('crypto');
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog }          = require('../../lib/audit');
const { validate } = require('../../middleware/validate');
const { createInviteLinkSchema, approveWorkerSchema, onboardWorkerSchema } = require('../../lib/schemas/workerInvite');

// ── PRIVATO: gestione link ────────────────────────────────────────────────────

router.post('/worker-invite-links', verifySupabaseJwt, validate(createInviteLinkSchema), async (req, res) => {
  const companyId  = req.companyId;
  const { site_id, expires_in_days = 7, max_uses = 1 } = req.body || {};

  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const token     = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + Math.min(expires_in_days, 30) * 86400000).toISOString();

  const { data, error } = await supabase
    .from('worker_invite_tokens')
    .insert({
      company_id:  companyId,
      site_id:     site_id || null,
      token,
      created_by:  req.user?.id || null,
      expires_at:  expiresAt,
      max_uses:    Math.min(max_uses, 50),
    })
    .select()
    .single();

  if (error) {
    console.error('[worker-invite] insert error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  const appUrl = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
  res.status(201).json({ ...data, link: `${appUrl}/onboarding-lavoratore/${token}` });
});

router.get('/worker-invite-links', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('worker_invite_tokens')
    .select('id, token, site_id, expires_at, max_uses, uses_count, created_at')
    .eq('company_id', req.companyId)
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const appUrl = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
  res.json((data || []).map(t => ({ ...t, link: `${appUrl}/onboarding-lavoratore/${t.token}` })));
});

router.delete('/worker-invite-links/:id', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const { error } = await supabase
    .from('worker_invite_tokens')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── PRIVATO: lavoratori in attesa ─────────────────────────────────────────────

router.get('/workers/pending', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('workers')
    .select('id, full_name, fiscal_code, phone, qualification, self_submitted_at, invite_token_id')
    .eq('company_id', req.companyId)
    .eq('pending_approval', true)
    .order('self_submitted_at', { ascending: true })
    .limit(100);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

router.patch('/workers/:id/approve', verifySupabaseJwt, validate(approveWorkerSchema), async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'approve' | 'reject'

  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'INVALID_ACTION', valid: ['approve', 'reject'] });
  }

  const { data: worker } = await supabase
    .from('workers')
    .select('id, full_name, pending_approval, company_id')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  if (!worker.pending_approval) return res.status(400).json({ error: 'NOT_PENDING' });

  if (action === 'approve') {
    const { error } = await supabase
      .from('workers')
      .update({ pending_approval: false, is_active: true })
      .eq('id', id);

    if (error) return res.status(500).json({ error: 'DB_ERROR' });
    await auditLog(req.companyId, req.user?.id, 'worker.approved', { worker_id: id, name: worker.full_name });
    return res.json({ ok: true, action: 'approved', worker_id: id });
  }

  // reject → elimina il lavoratore pending
  const { error } = await supabase
    .from('workers')
    .delete()
    .eq('id', id)
    .eq('pending_approval', true);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  await auditLog(req.companyId, req.user?.id, 'worker.rejected', { worker_id: id, name: worker.full_name });
  res.json({ ok: true, action: 'rejected', worker_id: id });
});

// ── PUBBLICO: onboarding lavoratore ──────────────────────────────────────────

router.get('/onboard/:token', async (req, res) => {
  const { token } = req.params;

  const { data: invite } = await supabase
    .from('worker_invite_tokens')
    .select('id, company_id, site_id, expires_at, max_uses, uses_count')
    .eq('token', token)
    .maybeSingle();

  if (!invite) return res.status(404).json({ error: 'INVALID_LINK' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'LINK_EXPIRED' });
  if (invite.uses_count >= invite.max_uses) return res.status(410).json({ error: 'LINK_EXHAUSTED' });

  const { data: company } = await supabase
    .from('companies')
    .select('id, name')
    .eq('id', invite.company_id)
    .maybeSingle();

  let siteName = null;
  if (invite.site_id) {
    const { data: site } = await supabase
      .from('sites')
      .select('name, address')
      .eq('id', invite.site_id)
      .maybeSingle();
    siteName = site ? (site.name || site.address) : null;
  }

  res.json({
    company_name: company?.name || 'Azienda',
    site_name:    siteName,
    expires_at:   invite.expires_at,
    uses_left:    invite.max_uses - invite.uses_count,
  });
});

router.post('/onboard/:token', validate(onboardWorkerSchema), async (req, res) => {
  const { token } = req.params;
  const {
    full_name, fiscal_code, phone,
    qualification, hire_date,
  } = req.body || {};

  if (!full_name || !fiscal_code) {
    return res.status(400).json({ error: 'MISSING_FIELDS', required: ['full_name', 'fiscal_code'] });
  }

  // Validate token
  const { data: invite } = await supabase
    .from('worker_invite_tokens')
    .select('id, company_id, site_id, expires_at, max_uses, uses_count')
    .eq('token', token)
    .maybeSingle();

  if (!invite) return res.status(404).json({ error: 'INVALID_LINK' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'LINK_EXPIRED' });
  if (invite.uses_count >= invite.max_uses) return res.status(410).json({ error: 'LINK_EXHAUSTED' });

  // Controlla duplicato CF nella company
  const { data: existing } = await supabase
    .from('workers')
    .select('id')
    .eq('company_id', invite.company_id)
    .eq('fiscal_code', fiscal_code.toUpperCase().trim())
    .maybeSingle();

  if (existing) return res.status(409).json({ error: 'FISCAL_CODE_DUPLICATE' });

  // Crea worker in stato pending
  const insertPayload = {
    company_id:        invite.company_id,
    full_name:         full_name.trim(),
    fiscal_code:       fiscal_code.toUpperCase().trim(),
    phone:             phone || null,
    qualification:     qualification || null,
    hire_date:         hire_date || null,
    is_active:         false,
    pending_approval:  true,
    invite_token_id:   invite.id,
    self_submitted_at: new Date().toISOString(),
  };

  const { error: wErr } = await supabase
    .from('workers')
    .insert(insertPayload)
    .select('id')
    .single();

  if (wErr) {
    console.error('[worker-invite] worker insert error:', wErr.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  // Incrementa uses_count
  await supabase
    .from('worker_invite_tokens')
    .update({ uses_count: invite.uses_count + 1 })
    .eq('id', invite.id);

  res.status(201).json({ ok: true, message: 'Dati inviati. L\'amministratore li verificherà e ti aggiungerà al cantiere.' });
});

module.exports = router;
