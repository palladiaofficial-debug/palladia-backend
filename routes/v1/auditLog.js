'use strict';
// ── Audit Log — lettura ────────────────────────────────────────────────────
// GET /api/v1/audit-log?action=&targetType=&targetId=&limit=&from=
// Visibile solo agli admin (owner/admin) della company.
// ──────────────────────────────────────────────────────────────────────────
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const ALLOWED_ROLES = ['owner', 'admin'];

router.get('/audit-log', verifySupabaseJwt, async (req, res) => {
  if (!ALLOWED_ROLES.includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono leggere l\'audit log' });
  }

  const { action, targetType, targetId, limit = '100', from } = req.query;

  let query = supabase
    .from('admin_audit_log')
    .select('id, user_id, user_role, action, target_type, target_id, payload, ip, created_at')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 100, 500));

  if (action)     query = query.eq('action', action);
  if (targetType) query = query.eq('target_type', targetType);
  if (targetId)   query = query.eq('target_id', targetId);
  if (from)       query = query.gte('created_at', from);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json({ count: data.length, entries: data });
});

module.exports = router;
