'use strict';
const supabase = require('./supabase');

async function logStudioAction(studioId, userId, action, { companyId, targetType, targetId, payload } = {}) {
  try {
    await supabase.from('studio_audit_log').insert({
      studio_id:   studioId,
      user_id:     userId,
      action,
      company_id:  companyId || null,
      target_type: targetType || null,
      target_id:   targetId || null,
      payload:     payload || null,
    });
  } catch {
    // best-effort — non blocca l'operazione chiamante
  }
}

module.exports = { logStudioAction };
