'use strict';
const supabase = require('../lib/supabase');

/**
 * verifySupabaseJwt — middleware per endpoint privati /api/v1/...
 *
 * Richiede:
 *   Authorization: Bearer <supabase-jwt>
 *   X-Company-Id:  <company-uuid>
 *
 * Popola:
 *   req.user      = { id, email }
 *   req.companyId = company_id verificato (da company_users, non fidato dal client)
 *   req.userRole  = ruolo dell'utente in quella company
 *
 * Errori:
 *   401 — JWT assente, malformato o scaduto
 *   400 — header X-Company-Id mancante
 *   403 — utente non appartiene alla company
 */
async function verifySupabaseJwt(req, res, next) {
  // 1. Estrai JWT dall'header Authorization
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const jwt = auth.slice(7);

  // 2. Valida JWT con Supabase Auth (call HTTP a Supabase Auth server)
  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    user = data.user;
  } catch (e) {
    console.error('[auth] getUser exception:', e.message);
    return res.status(401).json({ error: 'Token validation failed' });
  }

  // 3. X-Company-Id obbligatorio
  const companyId = req.headers['x-company-id'];
  if (!companyId) {
    return res.status(400).json({ error: 'Missing X-Company-Id header' });
  }

  // 4. Verifica membership reale in company_users
  //    SECURITY: era il TODO critico — ora risolto.
  //    Non si fida del company_id dal client: lo verifica contro DB.
  const { data: membership, error: memberErr } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (memberErr) {
    console.error('[auth] membership check error:', memberErr.message);
    return res.status(500).json({ error: 'Auth check failed' });
  }
  if (!membership) {
    return res.status(403).json({ error: 'Not a member of this company' });
  }

  // Popola req con dati verificati — usare solo questi nelle query business
  req.user      = { id: user.id, email: user.email };
  req.jwt       = jwt;
  req.companyId = companyId;   // verificato, sicuro da usare in .eq('company_id', req.companyId)
  req.userRole  = membership.role;

  next();
}

module.exports = { verifySupabaseJwt };
