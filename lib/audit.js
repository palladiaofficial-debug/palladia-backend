'use strict';
const supabase = require('./supabase');

/**
 * Registra un'azione admin nell'audit log.
 * Non blocca mai l'operazione chiamante: gli errori sono loggati e ignorati.
 *
 * @param {object} opts
 * @param {string}  opts.companyId  - UUID della company
 * @param {string}  [opts.userId]   - auth.uid() dell'operatore
 * @param {string}  [opts.userRole] - ruolo (owner/admin/tech/viewer)
 * @param {string}  opts.action     - es. 'worker.create', 'session.revoke'
 * @param {string}  [opts.targetType] - 'worker' | 'site' | 'session' | 'asl_token'
 * @param {string}  [opts.targetId]   - UUID della risorsa modificata
 * @param {object}  [opts.payload]    - dati extra (no segreti, no password)
 * @param {object}  [opts.req]        - Express request (per IP e user-agent)
 */
async function auditLog({ companyId, userId, userRole, action, targetType, targetId, payload, req }) {
  const ip = req
    ? ((req.ip || (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || '').slice(0, 45) || null)
    : null;
  const ua = req
    ? ((req.headers?.['user-agent'] || '').slice(0, 500) || null)
    : null;

  try {
    await supabase.from('admin_audit_log').insert([{
      company_id:  companyId,
      user_id:     userId     || null,
      user_role:   userRole   || null,
      action,
      target_type: targetType || null,
      target_id:   targetId   || null,
      payload:     payload    || null,
      ip,
      user_agent:  ua
    }]);
  } catch (e) {
    console.error('[audit] write error:', e.message);
  }
}

module.exports = { auditLog };
