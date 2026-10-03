'use strict';
/**
 * lib/psc/beta.js — F-270. Accesso in prova per i coordinatori invitati dal
 * titolare prima dell'apertura al pubblico. Un codice = un coordinatore.
 * Con PSC_OPEN_SIGNUP=true (apertura) il codice non serve più.
 */
const crypto = require('crypto');
const supabase = require('../supabase');

const TRIAL_DAYS = 90;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return `CSE-${s.slice(0, 4)}-${s.slice(4)}`;
}

const normalize = (c) => String(c || '').trim().toUpperCase();

async function checkCode(code) {
  const c = normalize(code);
  if (!/^CSE-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) return { ok: false, reason: 'FORMATO' };
  const { data } = await supabase.from('psc_beta_invites').select('code, used_by_company, revoked, note').eq('code', c).maybeSingle();
  if (!data || data.revoked) return { ok: false, reason: 'NON_VALIDO' };
  if (data.used_by_company) return { ok: false, reason: 'GIA_USATO' };
  return { ok: true, code: c, note: data.note };
}

/** Dopo la creazione della company del coordinatore: codice usato, modulo acceso, prova lunga. */
async function activate(companyId, code) {
  const c = normalize(code);
  const { data: claimed, error } = await supabase.from('psc_beta_invites')
    .update({ used_by_company: companyId, used_at: new Date().toISOString() })
    .eq('code', c).is('used_by_company', null).eq('revoked', false)
    .select('code');
  if (error || !claimed || !claimed.length) return false;
  await supabase.from('company_feature_flags').upsert({ company_id: companyId, feature: 'psc_coordinatori', enabled: true }, { onConflict: 'company_id,feature' });
  await supabase.from('companies').update({ trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString() }).eq('id', companyId);
  return true;
}

const openSignup = () => process.env.PSC_OPEN_SIGNUP === 'true';

module.exports = { newCode, checkCode, activate, normalize, openSignup, TRIAL_DAYS };
