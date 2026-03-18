'use strict';

/**
 * Stripe SDK — lazy init.
 * ENV richieste:
 *   STRIPE_SECRET_KEY       — chiave segreta Stripe (sk_live_... o sk_test_...)
 *   STRIPE_WEBHOOK_SECRET   — secret endpoint webhook (whsec_...)
 *   STRIPE_PRICE_BASE       — Price ID piano BASE €29/mese (price_...)
 *   STRIPE_PRICE_PRO        — Price ID piano PRO  €89/mese (price_...)
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
  base: () => process.env.STRIPE_PRICE_BASE,
  pro:  () => process.env.STRIPE_PRICE_PRO,
};

function getPriceId(plan) {
  const fn = PLAN_PRICES[plan];
  if (!fn) throw new Error(`Piano sconosciuto: ${plan}`);
  const id = fn();
  if (!id) throw new Error(`STRIPE_PRICE_${plan.toUpperCase()} non configurata`);
  return id;
}

module.exports = { getStripe, getPriceId };
