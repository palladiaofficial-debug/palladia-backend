'use strict';
// ── L'iscrizione dei coordinatori (F-429, AUDIT.md del frontend) ──────────────
// Dalla landing palladia.net/coordinatori un coordinatore si iscrive con la sola
// email, senza codice d'invito: area coordinatori accesa e 30 giorni di prova.
// Il link d'invito (lib/psc/beta.js) continua a valere: col codice, 60 giorni.
// Prezzo: 150 € l'anno + IVA, un solo piano (services/stripe.js, coordinatore_150).
// F-464 (8/11, decisione del titolare): i primi coordinatori, cioè chi entra entro il
// 31 marzo 2027, hanno tutto gratis fino al 31 marzo 2027; poi 150 € l'anno. Chi entra
// dopo quella data ha di nuovo i 30 giorni di prova.
const supabase = require('./supabase');
const pscBeta = require('./psc/beta');

const PROVA_GIORNI = 30;
const PREZZO_ANNO = 150;
// Fine del periodo gratis dei primi coordinatori: 31/3/2027 a fine giornata, ora di Roma (CEST, +02:00)
const GRATIS_FINO_AL = '2027-03-31T23:59:59+02:00';

/** Fine della prova per chi entra adesso: almeno `giorni`, e fino al 31/3/2027 se entra prima. */
function fineProva(giorni, adesso = Date.now()) {
  const normale = adesso + giorni * 86400000;
  const fondatori = Date.parse(GRATIS_FINO_AL);
  return new Date(adesso <= fondatori ? Math.max(normale, fondatori) : normale).toISOString();
}

/** Serve controllare un codice? Solo se il coordinatore ne ha portato uno (link d'invito). */
function codiceDaControllare(accountType, betaCode) {
  return accountType === 'coordinatore' && !!String(betaCode || '').trim();
}

/** Dopo la creazione dell'azienda del coordinatore: area accesa e prova. */
async function attiva(companyId, betaCode) {
  if (String(betaCode || '').trim()) return pscBeta.activate(companyId, betaCode);
  const f = await supabase.from('company_feature_flags').upsert({ company_id: companyId, feature: 'psc_coordinatori', enabled: true }, { onConflict: 'company_id,feature' });
  if (f.error) return false;
  const t = await supabase.from('companies').update({ trial_ends_at: fineProva(PROVA_GIORNI) }).eq('id', companyId);
  return !t.error;
}

module.exports = { attiva, codiceDaControllare, fineProva, PROVA_GIORNI, PREZZO_ANNO, GRATIS_FINO_AL };
