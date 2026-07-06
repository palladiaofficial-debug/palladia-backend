'use strict';
const supabase = require('./supabase');

/**
 * Verifica se la company ha un abbonamento attivo (trial non scaduto o pagato).
 * Logica pura, nessuna dipendenza da Express — estratta da server.js
 * (checkBillingActive) così è richiamabile anche da routes/v1/chat.js senza
 * un oggetto `res` su cui scrivere una risposta HTTP.
 */
async function isBillingActive(companyId) {
  const { data: company } = await supabase
    .from('companies').select('subscription_status, trial_ends_at')
    .eq('id', companyId).maybeSingle();
  if (!company) return false;
  const now = Date.now();
  const trialExpired = company.subscription_status === 'trial' &&
    company.trial_ends_at && new Date(company.trial_ends_at).getTime() < now;
  return company.subscription_status === 'active' ||
    (company.subscription_status === 'trial' && !trialExpired);
}

module.exports = { isBillingActive };
