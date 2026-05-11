'use strict';
const supabase = require('../lib/supabase');

/**
 * verifyStudioJwt — middleware per endpoint /api/v1/studio/...
 *
 * Non richiede X-Company-Id (il CDL non appartiene a un'impresa).
 * Verifica che l'utente abbia un record in studio_users.
 *
 * Popola:
 *   req.user       = { id, email }
 *   req.studioId   = UUID dello studio
 *   req.studioRole = 'owner'|'admin'|'collaborator'
 *   req.studio     = riga studio_partners completa
 */
async function verifyStudioJwt(req, res, next) {
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

  const { data: studioUser, error: suErr } = await supabase
    .from('studio_users')
    .select('studio_id, role, studio_partners(*)')
    .eq('user_id', user.id)
    .maybeSingle();

  if (suErr) return res.status(503).json({ error: 'Service temporarily unavailable' });
  if (!studioUser) {
    return res.status(403).json({
      error:   'STUDIO_NOT_FOUND',
      message: 'Nessuno studio CDL associato a questo account',
    });
  }

  req.user       = { id: user.id, email: user.email };
  req.studioId   = studioUser.studio_id;
  req.studioRole = studioUser.role;
  req.studio     = studioUser.studio_partners;
  next();
}

/**
 * verifyStudioOrCreate — come verifyStudioJwt ma NON fallisce se lo studio
 * non esiste ancora. Usato per l'endpoint di onboarding.
 */
async function verifyStudioOrCreate(req, res, next) {
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

  const { data: studioUser } = await supabase
    .from('studio_users')
    .select('studio_id, role, studio_partners(*)')
    .eq('user_id', user.id)
    .maybeSingle();

  req.user       = { id: user.id, email: user.email };
  req.studioId   = studioUser?.studio_id   || null;
  req.studioRole = studioUser?.role        || null;
  req.studio     = studioUser?.studio_partners || null;
  next();
}

module.exports = { verifyStudioJwt, verifyStudioOrCreate };
