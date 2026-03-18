'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { getStripe, getPriceId } = require('../../services/stripe');

const APP_URL = () => (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

// ── GET /api/v1/billing/status ─────────────────────────────────────────────
// Restituisce stato abbonamento corrente della company.
router.get('/billing/status', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .select('subscription_status, subscription_plan, trial_ends_at, subscription_current_period_end, stripe_customer_id')
    .eq('id', req.companyId)
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'DB_ERROR' });
  }

  const now       = Date.now();
  const trialEnd  = data.trial_ends_at ? new Date(data.trial_ends_at).getTime() : 0;
  const daysLeft  = data.subscription_status === 'trial'
    ? Math.max(0, Math.ceil((trialEnd - now) / 86400000))
    : null;
  const isExpired = data.subscription_status === 'trial' && trialEnd < now;

  res.json({
    status:           isExpired ? 'trial_expired' : data.subscription_status,
    plan:             data.subscription_plan,
    trial_ends_at:    data.trial_ends_at,
    days_left:        daysLeft,
    is_expired:       isExpired,
    period_end:       data.subscription_current_period_end,
    has_customer:     !!data.stripe_customer_id,
  });
});

// ── POST /api/v1/billing/checkout ──────────────────────────────────────────
// Crea una Stripe Checkout Session per il piano richiesto.
// Body: { plan: 'base' | 'pro' }
// Returns: { url }
router.post('/billing/checkout', verifySupabaseJwt, async (req, res) => {
  const { plan } = req.body || {};
  if (!['base', 'pro'].includes(plan)) {
    return res.status(400).json({ error: 'INVALID_PLAN', message: 'plan deve essere base o pro' });
  }

  let priceId;
  try { priceId = getPriceId(plan); }
  catch (e) {
    console.error('[billing] getPriceId error:', e.message);
    return res.status(503).json({ error: 'STRIPE_NOT_CONFIGURED', message: e.message });
  }

  // Recupera email owner per pre-compilare checkout Stripe
  const { data: cu } = await supabase
    .from('company_users')
    .select('user_id')
    .eq('company_id', req.companyId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle();

  let customerEmail;
  if (cu?.user_id) {
    const { data: authUser } = await supabase.auth.admin.getUserById(cu.user_id);
    customerEmail = authUser?.user?.email;
  }

  // Controlla se la company ha già un stripe_customer_id
  const { data: company } = await supabase
    .from('companies')
    .select('stripe_customer_id, name')
    .eq('id', req.companyId)
    .single();

  let stripe;
  try { stripe = getStripe(); }
  catch (e) { return res.status(503).json({ error: 'STRIPE_NOT_CONFIGURED', message: e.message }); }

  const sessionParams = {
    mode:                'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_URL()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${APP_URL()}/paywall?canceled=true`,
    client_reference_id: req.companyId,
    metadata: { company_id: req.companyId, plan },
    subscription_data: { metadata: { company_id: req.companyId, plan } },
    allow_promotion_codes: true,
  };

  if (company?.stripe_customer_id) {
    sessionParams.customer = company.stripe_customer_id;
  } else if (customerEmail) {
    sessionParams.customer_email = customerEmail;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log(`[billing] checkout session creata: ${session.id} company=${req.companyId} plan=${plan}`);
    res.json({ url: session.url });
  } catch (e) {
    console.error('[billing] stripe.checkout.sessions.create error:', e.message);
    res.status(500).json({ error: 'STRIPE_ERROR', message: e.message });
  }
});

// ── POST /api/v1/billing/portal ────────────────────────────────────────────
// Crea una Stripe Customer Portal Session per gestire abbonamento.
// Returns: { url }
router.post('/billing/portal', verifySupabaseJwt, async (req, res) => {
  const { data: company } = await supabase
    .from('companies')
    .select('stripe_customer_id')
    .eq('id', req.companyId)
    .single();

  if (!company?.stripe_customer_id) {
    return res.status(400).json({ error: 'NO_CUSTOMER', message: 'Nessun abbonamento attivo da gestire' });
  }

  let stripe;
  try { stripe = getStripe(); }
  catch (e) { return res.status(503).json({ error: 'STRIPE_NOT_CONFIGURED', message: e.message }); }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   company.stripe_customer_id,
      return_url: `${APP_URL()}/account`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[billing] portal session error:', e.message);
    res.status(500).json({ error: 'STRIPE_ERROR', message: e.message });
  }
});

module.exports = router;
