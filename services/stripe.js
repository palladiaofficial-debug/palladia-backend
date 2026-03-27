'use strict';

/**
 * Stripe SDK — lazy init.
 * ENV richieste:
 *   STRIPE_SECRET_KEY        — chiave segreta Stripe (sk_live_... o sk_test_...)
 *   STRIPE_WEBHOOK_SECRET    — secret endpoint webhook (whsec_...)
 *   STRIPE_PRICE_STARTER     — Price ID piano STARTER   €29/mese  (price_...)
 *   STRIPE_PRICE_GROW        — Price ID piano GROW       €59/mese  (price_...)
 *   STRIPE_PRICE_PRO         — Price ID piano PRO        €99/mese  (price_...)
 *   STRIPE_PRICE_BUSINESS    — Price ID piano BUSINESS   €199/mese (price_...)
 *
 * Backward compat: STRIPE_PRICE_BASE viene usato come fallback per STARTER.
 */
let _stripe = null;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY non configurata');
    _stripe = require('stripe')(key);
  }
  return _stripe;
}

const PLAN_PRICES = {
  starter:  () => process.env.STRIPE_PRICE_STARTER || process.env.STRIPE_PRICE_BASE,
  grow:     () => process.env.STRIPE_PRICE_GROW,
  pro:      () => process.env.STRIPE_PRICE_PRO,
  business: () => process.env.STRIPE_PRICE_BUSINESS,
};

/**
 * Limite massimo di cantieri attivi (status != 'chiuso') per piano.
 * null = nessun limite (enterprise).
 */
const PLAN_LIMITS = {
  trial:      3,   // trial = limite ridotto per incentivare upgrade
  starter:    5,
  base:       5,   // backward compat
  grow:       10,
  pro:        20,
  business:   50,
  enterprise: null,
};

function getPriceId(plan) {
  const fn = PLAN_PRICES[plan];
  if (!fn) throw new Error(`Piano sconosciuto: ${plan}`);
  const id = fn();
  if (!id) throw new Error(`STRIPE_PRICE_${plan.toUpperCase()} non configurata`);
  return id;
}

/**
 * Restituisce il limite di cantieri attivi per il piano dato.
 * null = illimitati.
 */
function getSiteLimit(plan) {
  if (plan in PLAN_LIMITS) return PLAN_LIMITS[plan];
  return null;
}

module.exports = { getStripe, getPriceId, getSiteLimit, PLAN_LIMITS };
