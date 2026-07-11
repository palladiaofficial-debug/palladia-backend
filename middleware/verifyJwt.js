'use strict';
const supabase = require('../lib/supabase');
const { isBillingActive } = require('../lib/billing');

// Endpoint che devono restare scrivibili anche ad abbonamento scaduto — altrimenti
// una company bloccata non potrebbe più riattivarsi da sola (paradosso del lucchetto).
const BILLING_EXEMPT_WRITE_PATHS = new Set([
  '/billing/checkout',
  '/billing/portal',
]);

/**
 * Blocca le scritture (tutti i metodi tranne GET/HEAD/OPTIONS) quando l'abbonamento
 * della company non è attivo (trial scaduto o subscription_status non 'active'/'trial').
 * La lettura resta sempre permessa. Ritorna true se la richiesta può proseguire.
 */
async function enforceBillingForWrites(req, res, companyId) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (BILLING_EXEMPT_WRITE_PATHS.has(req.path)) return true;
  if (await isBillingActive(companyId)) return true;
  res.status(402).json({
    error:   'SUBSCRIPTION_REQUIRED',
    message: 'Abbonamento scaduto: rinnova per continuare a modificare i dati.',
  });
  return false;
}

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

  // 4. Verifica membership reale in company_users (con retry su errore transitorio)
  let membership = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, error: memberErr } = await supabase
      .from('company_users')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!memberErr) { membership = data; break; }
    if (attempt === 2) {
      console.error('[auth] membership check failed after retry:', memberErr.message);
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
    await new Promise(r => { setTimeout(r, 300); });
  }

  if (!membership) {
    // Fallback CDL: controlla se l'utente è un CDL con accesso attivo a questa company
    const { data: studioUser } = await supabase
      .from('studio_users')
      .select('studio_id, role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (studioUser) {
      const { data: studioRelation } = await supabase
        .from('studio_clients')
        .select('id, owned_by_studio')
        .eq('studio_id', studioUser.studio_id)
        .eq('company_id', companyId)
        .eq('status', 'active')
        .maybeSingle();

      if (studioRelation) {
        // Collaboratori: se lo studio ha assegnazioni esplicite per-cliente,
        // un collaborator vede solo le aziende a lui assegnate (stessa regola
        // di filterClientsByCollaborator in routes/v1/studio.js).
        if (studioUser.role === 'collaborator') {
          const { data: assigned } = await supabase
            .from('studio_user_clients')
            .select('company_id')
            .eq('studio_id', studioUser.studio_id)
            .eq('user_id', user.id);
          if (assigned?.length && !assigned.some(r => r.company_id === companyId)) {
            return res.status(403).json({ error: 'Not a member of this company' });
          }
        }

        // Scritture dirette solo se l'azienda è gestita dallo studio: stessa
        // regola di checkStudioAccess(requireOwnership=true) in studio.js,
        // applicata qui perché questo fallback dà accesso a TUTTE le route
        // generiche /api/v1/*, non solo a /api/v1/studio/*.
        const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        if (isWrite && !studioRelation.owned_by_studio) {
          return res.status(403).json({ error: 'Azienda gestita autonomamente: il CDL non può modificare i dati direttamente' });
        }

        req.user      = { id: user.id, email: user.email };
        req.jwt       = jwt;
        req.companyId = companyId;
        req.userRole  = 'cdl';
        req.isCdl     = true;
        req.studioId  = studioUser.studio_id;
        if (!await enforceBillingForWrites(req, res, companyId)) return;
        return next();
      }
    }

    return res.status(403).json({ error: 'Not a member of this company' });
  }

  // Popola req con dati verificati — usare solo questi nelle query business
  req.user      = { id: user.id, email: user.email };
  req.jwt       = jwt;
  req.companyId = companyId;   // verificato, sicuro da usare in .eq('company_id', req.companyId)
  req.userRole  = membership.role;

  if (!await enforceBillingForWrites(req, res, companyId)) return;

  next();
}

module.exports = { verifySupabaseJwt };
