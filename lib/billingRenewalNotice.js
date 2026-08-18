'use strict';
/**
 * lib/billingRenewalNotice.js
 * Logica per l'avviso di rinnovo abbonamento (F-058, AUDIT.md) — separata dal
 * webhook handler in server.js per essere testabile senza avviare il server
 * né firmare eventi Stripe.
 */

const supabase = require('./supabase');

/**
 * Estrae i dati dell'avviso da un evento Stripe `invoice.upcoming`.
 * Pura: nessun I/O, testabile con fixture in isolamento.
 * @param {object} invoice - `event.data.object` di un evento invoice.upcoming
 */
function buildRenewalNoticeData(invoice) {
  const amount   = (invoice.amount_due ?? 0) / 100;
  const currency = (invoice.currency || 'eur').toUpperCase();

  // invoice.upcoming non ha ancora un `id` (nessuna fattura reale creata) —
  // next_payment_attempt è la data del prossimo addebito; period_end come
  // fallback se Stripe non lo valorizza (es. importo zero, nessun addebito).
  const renewalTimestamp = invoice.next_payment_attempt || invoice.period_end || null;
  const renewalDate = renewalTimestamp ? new Date(renewalTimestamp * 1000).toISOString() : null;

  const line = invoice.lines?.data?.[0];
  const planName = line?.description || line?.price?.nickname || 'abbonamento Palladia';

  return { amount, currency, renewalDate, planName };
}

/**
 * Trova la company Palladia collegata a un customer Stripe.
 * @param {string} stripeCustomerId
 */
async function findCompanyByStripeCustomer(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const { data } = await supabase
    .from('companies')
    .select('id, name')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();
  return data || null;
}

/**
 * Email di owner/admin di una company — sempre inviata, non filtrata dalle
 * preferenze di notifica generiche (lib/notificationPrefs.js): un avviso di
 * addebito imminente è transazionale, non un alert operativo disattivabile.
 * @param {string} companyId
 */
async function getCompanyAdminEmails(companyId) {
  const { data: adminUsers } = await supabase
    .from('company_users')
    .select('user_id, role')
    .eq('company_id', companyId)
    .in('role', ['owner', 'admin']);

  const emails = [];
  for (const u of (adminUsers || [])) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(u.user_id);
      if (user?.email) emails.push(user.email);
    } catch { /* ignora errori singolo utente */ }
  }
  return emails;
}

module.exports = { buildRenewalNoticeData, findCompanyByStripeCustomer, getCompanyAdminEmails };
