'use strict';
// ── L'iscrizione dei coordinatori (F-429, AUDIT.md del frontend) ──────────────
// Dalla landing palladia.net/coordinatori un coordinatore si iscrive con la sola
// email, senza codice d'invito: area coordinatori accesa e 30 giorni di prova.
// Il link d'invito (lib/psc/beta.js) continua a valere: col codice, 60 giorni.
// Prezzo: 150 € l'anno + IVA, un solo piano (services/stripe.js, coordinatore_150).
const supabase = require('./supabase');
const pscBeta = require('./psc/beta');

const PROVA_GIORNI = 30;
const PREZZO_ANNO = 150;

/** Serve controllare un codice? Solo se il coordinatore ne ha portato uno (link d'invito). */
function codiceDaControllare(accountType, betaCode) {
  return accountType === 'coordinatore' && !!String(betaCode || '').trim();
}

/** Dopo la creazione dell'azienda del coordinatore: area accesa e prova. */
async function attiva(companyId, betaCode) {
  if (String(betaCode || '').trim()) return pscBeta.activate(companyId, betaCode);
  const f = await supabase.from('company_feature_flags').upsert({ company_id: companyId, feature: 'psc_coordinatori', enabled: true }, { onConflict: 'company_id,feature' });
  if (f.error) return false;
  const t = await supabase.from('companies').update({ trial_ends_at: new Date(Date.now() + PROVA_GIORNI * 86400000).toISOString() }).eq('id', companyId);
  return !t.error;
}

module.exports = { attiva, codiceDaControllare, PROVA_GIORNI, PREZZO_ANNO };
