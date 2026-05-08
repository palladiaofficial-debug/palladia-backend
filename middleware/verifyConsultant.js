'use strict';
const supabase = require('../lib/supabase');

/**
 * verifyConsultantJwt — middleware per endpoint /api/v1/consultant/...
 *
 * Non richiede X-Company-Id (il consulente non appartiene a un'impresa).
 * Verifica che l'utente abbia un record in consultant_profiles.
 *
 * Popola:
 *   req.user         = { id, email }
 *   req.consultantId = user_id del consulente (auth.uid)
 *   req.consultant   = riga consultant_profiles completa
 */
async function verifyConsultantJwt(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  const { data: profile, error: pErr } = await supabase
    .from('consultant_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (pErr) return res.status(503).json({ error: 'Service temporarily unavailable' });
  if (!profile) return res.status(403).json({ error: 'CONSULTANT_PROFILE_NOT_FOUND', message: 'Completa prima il profilo consulente' });

  req.user         = { id: user.id, email: user.email };
  req.consultantId = user.id;
  req.consultant   = profile;
  next();
}

/**
 * verifyConsultantOrCreate — come verifyConsultantJwt ma NON fallisce se il profilo
 * non esiste ancora. Usato per l'endpoint di onboarding.
 */
async function verifyConsultantOrCreate(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  const { data: profile } = await supabase
    .from('consultant_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  req.user         = { id: user.id, email: user.email };
  req.consultantId = user.id;
  req.consultant   = profile || null;
  next();
}

module.exports = { verifyConsultantJwt, verifyConsultantOrCreate };
