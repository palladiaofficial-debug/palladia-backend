'use strict';

/**
 * lib/stripeWebhookHandlers.js
 * Logica dei due handler webhook Stripe scoperti irraggiungibili in F-059
 * (AUDIT.md) — estratta da server.js per essere testabile senza avviare il
 * server né firmare eventi Stripe, stesso motivo per cui lib/billingRenewalNotice.js
 * è stato estratto per F-058.
 *
 * `invoice.payment_failed` e `account.updated` erano scritti in server.js ma
 * mai raggiunti in produzione: l'endpoint webhook Stripe non li aveva tra gli
 * `enabled_events` (Stripe non invia mai un evento non sottoscritto). Il fix
 * dell'iscrizione è esterno a questo codice — vedi scripts/run-once-f059-enable-events.js
 * — ma un endpoint sottoscritto correttamente con un handler mai testato è comunque
 * un rischio silenzioso, quindi la logica va coperta a prescindere.
 */

const supabase = require('./supabase');

// ── invoice.payment_failed ────────────────────────────────────────────────────
// Un pagamento rifiutato non deve lasciare l'abbonamento "active": il cliente
// continuerebbe a usare il prodotto gratis a tempo indeterminato finché
// Stripe non abbandona i tentativi (dunning), momento in cui arriverebbe
// customer.subscription.updated con status 'unpaid' — troppo tardi rispetto
// al primo rifiuto.
async function handlePaymentFailed(invoice) {
  const { data: company, error: findErr } = await supabase
    .from('companies')
    .select('id')
    .eq('stripe_customer_id', invoice.customer)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!company) return { updated: false, reason: 'company_not_found' };

  const { error: updateErr } = await supabase
    .from('companies')
    .update({ subscription_status: 'past_due' })
    .eq('id', company.id);
  if (updateErr) throw updateErr;

  return { updated: true, companyId: company.id };
}

// ── account.updated (Stripe Connect) ──────────────────────────────────────────
// Aggiorna lo stato di onboarding del consulente non appena Stripe lo conferma
// — senza questo, stripe_charges_enabled resta congelato al valore letto
// all'avvio del collegamento Connect, e i payout automatici (server.js,
// checkout.session.completed → booking_ids) restano "in sospeso" per sempre
// anche dopo che il consulente ha completato l'onboarding per davvero.
async function handleAccountUpdated(account) {
  const { data, error } = await supabase
    .from('consultant_profiles')
    .update({
      stripe_onboarding_complete: account.details_submitted,
      stripe_charges_enabled:     account.charges_enabled,
      stripe_payouts_enabled:     account.payouts_enabled,
    })
    .eq('stripe_account_id', account.id)
    .select('id');
  if (error) throw error;

  const updated = (data || []).length > 0;
  return { updated, profileId: updated ? data[0].id : null };
}

module.exports = {
  handlePaymentFailed,
  handleAccountUpdated,
};
