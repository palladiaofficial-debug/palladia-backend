'use strict';
/**
 * routes/v1/consultantConnect.js
 * Stripe Connect Express per consulenti RSPP.
 *
 * POST /api/v1/consultant/connect/onboard  — crea Express Account + link onboarding
 * POST /api/v1/consultant/connect/refresh  — rigenera link (se scaduto o refresh URL)
 * GET  /api/v1/consultant/connect/status   — stato account Connect (live da Stripe)
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifyConsultantJwt } = require('../../middleware/verifyConsultant');

const FRONTEND_URL = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY non configurata');
  return require('stripe')(key);
}

router.use(verifyConsultantJwt);

// ── POST /api/v1/consultant/connect/onboard ───────────────────────────────────

router.post('/consultant/connect/onboard', async (req, res) => {
  const consultant = req.consultant;
  const stripe     = getStripe();

  let accountId = consultant.stripe_account_id;

  try {
    if (!accountId) {
      const account = await stripe.accounts.create({
        type:         'express',
        country:      'IT',
        email:        req.user.email,
        capabilities: { transfers: { requested: true } },
        business_profile: {
          name: consultant.company_name || undefined,
          url:  `${FRONTEND_URL()}/formazione/consulente/${consultant.id}`,
        },
        metadata: {
          consultant_id: consultant.id,
          user_id:       req.consultantId,
        },
      });

      accountId = account.id;

      const { error: dbErr } = await supabase
        .from('consultant_profiles')
        .update({ stripe_account_id: accountId })
        .eq('id', consultant.id);

      if (dbErr) throw new Error('Errore salvataggio account: ' + dbErr.message);
    }

    const accountLink = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${FRONTEND_URL()}/formazione/consulente/impostazioni?connect=refresh`,
      return_url:  `${FRONTEND_URL()}/formazione/consulente/impostazioni?connect=success`,
      type:        'account_onboarding',
    });

    res.json({ url: accountLink.url, account_id: accountId });
  } catch (e) {
    console.error('[connect/onboard]', e.message);
    res.status(503).json({ error: 'STRIPE_ERROR', message: e.message });
  }
});

// ── POST /api/v1/consultant/connect/refresh ───────────────────────────────────

router.post('/consultant/connect/refresh', async (req, res) => {
  const accountId = req.consultant.stripe_account_id;
  if (!accountId) {
    return res.status(400).json({ error: 'NO_ACCOUNT', message: 'Nessun account Stripe Connect — usa /onboard prima' });
  }

  try {
    const accountLink = await getStripe().accountLinks.create({
      account:     accountId,
      refresh_url: `${FRONTEND_URL()}/formazione/consulente/impostazioni?connect=refresh`,
      return_url:  `${FRONTEND_URL()}/formazione/consulente/impostazioni?connect=success`,
      type:        'account_onboarding',
    });
    res.json({ url: accountLink.url });
  } catch (e) {
    console.error('[connect/refresh]', e.message);
    res.status(503).json({ error: 'STRIPE_ERROR', message: e.message });
  }
});

// ── GET /api/v1/consultant/connect/status ─────────────────────────────────────

router.get('/consultant/connect/status', async (req, res) => {
  const c = req.consultant;

  if (!c.stripe_account_id) {
    return res.json({
      connected:                  false,
      stripe_account_id:          null,
      stripe_onboarding_complete: false,
      stripe_charges_enabled:     false,
      stripe_payouts_enabled:     false,
    });
  }

  try {
    const account = await getStripe().accounts.retrieve(c.stripe_account_id);

    const patch = {
      stripe_onboarding_complete: account.details_submitted,
      stripe_charges_enabled:     account.charges_enabled,
      stripe_payouts_enabled:     account.payouts_enabled,
    };

    await supabase
      .from('consultant_profiles')
      .update(patch)
      .eq('id', c.id);

    return res.json({ connected: true, stripe_account_id: c.stripe_account_id, ...patch });
  } catch (e) {
    // Stripe non raggiungibile: usa dati DB
    return res.json({
      connected:                  true,
      stripe_account_id:          c.stripe_account_id,
      stripe_onboarding_complete: c.stripe_onboarding_complete,
      stripe_charges_enabled:     c.stripe_charges_enabled,
      stripe_payouts_enabled:     c.stripe_payouts_enabled,
    });
  }
});

module.exports = router;
