'use strict';
/**
 * routes/v1/studio.js
 * Portale Studio CDL Partner — Consulenti del Lavoro che gestiscono N imprese clienti.
 *
 * POST /api/v1/studio/onboard                        — crea/aggiorna profilo studio
 * GET  /api/v1/studio/me                             — profilo studio corrente
 * PUT  /api/v1/studio/me                             — aggiorna profilo studio
 * GET  /api/v1/studio/clients                        — lista imprese clienti
 * POST /api/v1/studio/clients/invite                 — invita impresa (per company_id)
 * POST /api/v1/studio/clients/accept/:token          — impresa accetta invito
 * GET  /api/v1/studio/clients/:companyId             — dettaglio impresa cliente
 * DELETE /api/v1/studio/clients/:companyId           — rimuovi relazione
 * GET  /api/v1/studio/dashboard                      — dashboard aggregato con semaforo
 */

const router   = require('express').Router();
const crypto   = require('crypto');
const supabase = require('../../lib/supabase');
const { verifyStudioJwt, verifyStudioOrCreate } = require('../../middleware/verifyStudio');
const { sendStudioInviteEmail } = require('../../services/email');

// ── Onboarding ────────────────────────────────────────────────────────────────

router.post('/studio/onboard', verifyStudioOrCreate, async (req, res) => {
  const {
    studio_name, vat_number, registration_number,
    operative_regions, bio, logo_url, edil_connect_code,
  } = req.body || {};

  if (!studio_name?.trim()) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'studio_name obbligatorio' });
  }

  const { data: studio, error: sErr } = await supabase
    .from('studio_partners')
    .upsert({
      user_id:              req.user.id,
      studio_name:          studio_name.trim(),
      vat_number:           vat_number?.trim()          || null,
      registration_number:  registration_number?.trim() || null,
      operative_regions:    operative_regions           || [],
      bio:                  bio?.trim()                 || null,
      logo_url:             logo_url                    || null,
      edil_connect_code:    edil_connect_code?.trim()   || null,
      onboarding_completed: true,
    }, { onConflict: 'user_id' })
    .select()
    .single();

  if (sErr) return res.status(500).json({ error: sErr.message });

  // Garantisce record studio_users come owner
  await supabase.from('studio_users').upsert({
    studio_id: studio.id,
    user_id:   req.user.id,
    role:      'owner',
    joined_at: new Date().toISOString(),
  }, { onConflict: 'studio_id,user_id' });

  res.json({ studio });
});

// ── Profilo ───────────────────────────────────────────────────────────────────

router.get('/studio/me', verifyStudioJwt, async (req, res) => {
  res.json({ studio: req.studio });
});

router.put('/studio/me', verifyStudioJwt, async (req, res) => {
  const allowed = ['studio_name','vat_number','registration_number','operative_regions','bio','logo_url','edil_connect_code'];
  const update  = {};
  for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

  const { data, error } = await supabase
    .from('studio_partners')
    .update(update)
    .eq('id', req.studioId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ studio: data });
});

// ── Clienti ───────────────────────────────────────────────────────────────────

router.get('/studio/clients', verifyStudioJwt, async (req, res) => {
  const { data: clients, error } = await supabase
    .from('studio_clients')
    .select('*, companies(id, name)')
    .eq('studio_id', req.studioId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ clients: clients || [] });
});

router.post('/studio/clients/invite', verifyStudioJwt, async (req, res) => {
  const { company_id } = req.body || {};
  if (!company_id) return res.status(400).json({ error: 'company_id obbligatorio' });

  const { data: company } = await supabase
    .from('companies')
    .select('id, name')
    .eq('id', company_id)
    .maybeSingle();

  if (!company) return res.status(404).json({ error: 'Azienda non trovata' });

  // Se relazione già attiva, non degradarla a 'pending'
  const { data: existing } = await supabase
    .from('studio_clients')
    .select('id, status')
    .eq('studio_id', req.studioId)
    .eq('company_id', company_id)
    .maybeSingle();

  if (existing?.status === 'active') {
    return res.status(409).json({ error: 'ALREADY_ACTIVE', message: 'Questa azienda è già un cliente attivo del tuo studio.' });
  }

  const invite_token = crypto.randomBytes(24).toString('hex');

  const { data, error } = await supabase
    .from('studio_clients')
    .upsert({
      studio_id:      req.studioId,
      company_id,
      status:         'pending',
      invited_by:     req.user.id,
      invite_token,
      invite_sent_at: new Date().toISOString(),
    }, { onConflict: 'studio_id,company_id' })
    .select('*, companies(id, name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const APP_BASE_URL = process.env.APP_BASE_URL || 'https://palladia-kappa.vercel.app';
  const accept_url   = `${APP_BASE_URL}/studio/accetta/${invite_token}`;

  // Trova l'email dell'owner dell'impresa invitata e invia l'email (fire-and-forget)
  supabase
    .from('company_users')
    .select('user_id')
    .eq('company_id', company_id)
    .eq('role', 'owner')
    .maybeSingle()
    .then(async ({ data: owner }) => {
      if (!owner?.user_id) return;
      const { data: { user } } = await supabase.auth.admin.getUserById(owner.user_id);
      if (!user?.email) return;
      await sendStudioInviteEmail({
        to:         user.email,
        studioName: req.studio.studio_name,
        acceptUrl:  accept_url,
      });
    })
    .catch(err => console.error('[studio] sendStudioInviteEmail:', err.message));

  res.json({ client: data, invite_token, accept_url });
});

// Impresa accetta l'invito dello studio — NON richiede X-Company-Id.
// Verifica server-side che il JWT appartenga a un membro dell'impresa invitata.
router.post('/studio/clients/accept/:token', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  const jwt = auth.slice(7);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  const { token } = req.params;

  const { data: relation, error: relErr } = await supabase
    .from('studio_clients')
    .select('*, studio_partners(id, studio_name)')
    .eq('invite_token', token)
    .maybeSingle();

  if (relErr || !relation) {
    return res.status(404).json({ error: 'Invito non trovato o non valido' });
  }

  // Verifica che l'utente sia owner/admin dell'impresa invitata
  const { data: membership } = await supabase
    .from('company_users')
    .select('role')
    .eq('company_id', relation.company_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) {
    return res.status(403).json({ error: 'Non sei membro di questa azienda' });
  }
  if (!['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: 'Solo owner o admin possono accettare inviti' });
  }
  if (relation.status === 'active') {
    return res.status(409).json({ error: 'Relazione già attiva', studio_name: relation.studio_partners?.studio_name });
  }

  const { data, error } = await supabase
    .from('studio_clients')
    .update({ status: 'active', accepted_at: new Date().toISOString() })
    .eq('id', relation.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, studio_name: relation.studio_partners?.studio_name, client: data });
});

// Dettaglio impresa cliente
router.get('/studio/clients/:companyId', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;

  const { data: relation } = await supabase
    .from('studio_clients')
    .select('*')
    .eq('studio_id', req.studioId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle();

  if (!relation) return res.status(403).json({ error: 'Azienda non associata a questo studio' });

  const [
    { data: company },
    { data: sites },
    { data: workers },
    { data: dvrs },
    { data: subcontractors },
    { data: certs },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).maybeSingle(),
    supabase.from('sites').select('id, name, status, address').eq('company_id', companyId).order('created_at', { ascending: false }),
    supabase.from('workers').select('id, full_name, fiscal_code, is_active').eq('company_id', companyId).eq('is_active', true).limit(200),
    supabase.from('dvr_documents').select('id, revision, dvr_data, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(5),
    supabase.from('subcontractors').select('id, company_name, status').eq('company_id', companyId),
    supabase.from('worker_certificates').select('id, worker_id, expiry_date, course_types(name)').eq('company_id', companyId).order('expiry_date', { ascending: true }).limit(100),
  ]);

  res.json({
    company,
    sites:          sites          || [],
    workers:        workers        || [],
    dvrs:           dvrs           || [],
    subcontractors: subcontractors || [],
    certificates:   certs          || [],
  });
});

// Rimuovi relazione studio-impresa
router.delete('/studio/clients/:companyId', verifyStudioJwt, async (req, res) => {
  const { companyId } = req.params;

  const { error } = await supabase
    .from('studio_clients')
    .delete()
    .eq('studio_id', req.studioId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Dashboard aggregato ───────────────────────────────────────────────────────

router.get('/studio/dashboard', verifyStudioJwt, async (req, res) => {
  const { data: clients } = await supabase
    .from('studio_clients')
    .select('company_id, companies(id, name)')
    .eq('studio_id', req.studioId)
    .eq('status', 'active');

  if (!clients?.length) {
    return res.json({
      clients: [],
      alerts:  [],
      summary: { total: 0, verde: 0, giallo: 0, rosso: 0 },
    });
  }

  const companyIds = clients.map(c => c.company_id);
  const now    = new Date();
  const in30   = new Date(now.getTime() + 30 * 86400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86400_000);

  // Fetch parallelo di tutti i dati necessari
  const [
    { data: sites        },
    { data: workers      },
    { data: dvrs         },
    { data: certExpired  },
    { data: certSoon     },
    { data: subDocs      },
  ] = await Promise.all([
    supabase.from('sites').select('id, company_id').in('company_id', companyIds).neq('status', 'chiuso'),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true),
    supabase.from('dvr_documents').select('id, company_id, created_at').in('company_id', companyIds).order('created_at', { ascending: false }),
    supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds).lt('expiry_date', now.toISOString().slice(0,10)),
    supabase.from('worker_certificates').select('id, company_id').in('company_id', companyIds)
      .gte('expiry_date', now.toISOString().slice(0,10)).lt('expiry_date', in30.toISOString().slice(0,10)),
    supabase.from('subcontractor_documents').select('id, company_id, valid_until').in('company_id', companyIds),
  ]);

  // Inizializza metriche per ogni impresa
  const metrics = {};
  for (const c of clients) {
    metrics[c.company_id] = {
      company_id:               c.company_id,
      company_name:             c.companies.name,
      cantieri_attivi:          0,
      lavoratori_totali:        0,
      dvr_presente:             false,
      dvr_data:                 null,
      certificati_scaduti:      0,
      certificati_in_scadenza:  0,
      sub_docs_scaduti:         0,
      semaforo:                 'verde',
      alerts:                   [],
    };
  }

  for (const s of sites   || []) if (metrics[s.company_id]) metrics[s.company_id].cantieri_attivi++;
  for (const w of workers || []) if (metrics[w.company_id]) metrics[w.company_id].lavoratori_totali++;

  // DVR — solo il più recente per company
  const latestDvr = {};
  for (const d of dvrs || []) if (!latestDvr[d.company_id]) latestDvr[d.company_id] = d;
  for (const [cid, dvr] of Object.entries(latestDvr)) {
    if (!metrics[cid]) continue;
    metrics[cid].dvr_presente = true;
    metrics[cid].dvr_data     = dvr.created_at;
    if (new Date(dvr.created_at) < oneYearAgo) {
      metrics[cid].alerts.push({ type: 'dvr_old', message: 'DVR non aggiornato (>12 mesi)', severity: 'warning' });
    }
  }

  for (const c of certExpired || []) {
    if (!metrics[c.company_id]) continue;
    metrics[c.company_id].certificati_scaduti++;
    metrics[c.company_id].alerts.push({ type: 'cert_expired', message: 'Attestato formazione scaduto', severity: 'critical' });
  }
  for (const c of certSoon || []) {
    if (!metrics[c.company_id]) continue;
    metrics[c.company_id].certificati_in_scadenza++;
    metrics[c.company_id].alerts.push({ type: 'cert_expiring', message: 'Attestato in scadenza (30 gg)', severity: 'warning' });
  }
  for (const d of subDocs || []) {
    if (!metrics[d.company_id] || !d.valid_until) continue;
    const vDate = new Date(d.valid_until);
    if (vDate < now) {
      metrics[d.company_id].sub_docs_scaduti++;
      metrics[d.company_id].alerts.push({ type: 'sub_doc_expired', message: 'Documento subappaltatore scaduto', severity: 'critical' });
    } else if (vDate < in30) {
      metrics[d.company_id].alerts.push({ type: 'sub_doc_expiring', message: 'Documento subappaltatore in scadenza', severity: 'warning' });
    }
  }

  // DVR mancante
  const allAlerts = [];
  for (const m of Object.values(metrics)) {
    if (!m.dvr_presente && m.lavoratori_totali > 0) {
      m.alerts.push({ type: 'dvr_missing', message: 'DVR assente', severity: 'critical' });
    }

    const hasCritical = m.alerts.some(a => a.severity === 'critical');
    const hasWarning  = m.alerts.some(a => a.severity === 'warning');
    m.semaforo = hasCritical ? 'rosso' : hasWarning ? 'giallo' : 'verde';

    for (const alert of m.alerts) {
      allAlerts.push({ ...alert, company_id: m.company_id, company_name: m.company_name });
    }
    // Deduplica alert per tipo
    m.alerts = [...new Map(m.alerts.map(a => [a.type, a])).values()];
  }

  allAlerts.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));

  const clientList = Object.values(metrics);
  const summary = {
    total:  clientList.length,
    verde:  clientList.filter(c => c.semaforo === 'verde').length,
    giallo: clientList.filter(c => c.semaforo === 'giallo').length,
    rosso:  clientList.filter(c => c.semaforo === 'rosso').length,
  };

  res.json({ clients: clientList, alerts: allAlerts.slice(0, 60), summary });
});

module.exports = router;
