'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');

/**
 * verifyJwtOnly — verifica solo il JWT Supabase senza check company membership.
 * Usato per /onboarding/setup dove l'utente non ha ancora una company.
 * Popola req.user = { id, email }.
 */
async function verifyJwtOnly(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    user = data.user;
  } catch (e) {
    console.error('[onboarding] getUser exception:', e.message);
    return res.status(401).json({ error: 'Token validation failed' });
  }

  req.user = { id: user.id, email: user.email };
  next();
}

// GET /api/v1/me — restituisce company_id e ruolo dell'utente autenticato (no company check)
// Usato dal frontend admin.html per scoprire il company_id prima di qualsiasi altra chiamata.
router.get('/me', verifyJwtOnly, async (req, res) => {
  const { data, error } = await supabase
    .from('company_users')
    .select('company_id, role')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'NO_COMPANY' });

  res.json({
    user_id:    req.user.id,
    email:      req.user.email,
    company_id: data.company_id,
    role:       data.role
  });
});

// POST /api/v1/onboarding/setup — crea la prima company per l'utente autenticato
router.post('/onboarding/setup', verifyJwtOnly, async (req, res) => {
  const { company_name } = req.body || {};

  // Validazione
  if (
    !company_name ||
    typeof company_name !== 'string' ||
    company_name.trim().length < 2 ||
    company_name.trim().length > 200
  ) {
    return res.status(400).json({
      error:   'INVALID_COMPANY_NAME',
      message: 'company_name è obbligatorio (min 2, max 200 caratteri)'
    });
  }

  const cleanName = company_name.trim();

  // Controlla che l'utente non abbia già una company
  const { data: existing, error: existErr } = await supabase
    .from('company_users')
    .select('company_id')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (existErr) {
    console.error('[onboarding] existing check error:', existErr.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  if (existing) {
    return res.status(409).json({
      error:      'ALREADY_HAS_COMPANY',
      company_id: existing.company_id
    });
  }

  // Crea la company
  const { data: company, error: compErr } = await supabase
    .from('companies')
    .insert({ name: cleanName })
    .select('id, name')
    .single();

  if (compErr) {
    console.error('[onboarding] insert company error:', compErr.message);
    return res.status(500).json({ error: 'DB_ERROR', message: compErr.message });
  }

  // Aggiunge l'utente come owner
  const { error: memberErr } = await supabase
    .from('company_users')
    .insert({
      company_id: company.id,
      user_id:    req.user.id,
      role:       'owner'
    });

  if (memberErr) {
    console.error('[onboarding] insert company_users error:', memberErr.message);
    // Tenta rollback company
    await supabase.from('companies').delete().eq('id', company.id);
    return res.status(500).json({ error: 'DB_ERROR', message: memberErr.message });
  }

  console.log(`[onboarding] company creata: ${company.id} (${cleanName}) per user ${req.user.id}`);

  res.status(201).json({
    ok:           true,
    company_id:   company.id,
    company_name: company.name
  });
});

module.exports = router;
