'use strict';
// ── Niente seconda azienda per chi è stato invitato (F-348) ─────────────────
// Due colleghi del titolare sono finiti in aziende vuote create senza volerlo:
// "Accedi con Google" con l'email personale (nessuna azienda → onboarding →
// "Crea azienda") invece dell'email dell'invito. Prima di creare un'azienda:
//   - se c'è un invito aperto per la sua email → si entra lì, non si crea;
//   - se il nome è quello di un'azienda già su Palladia (anche scritto diverso:
//     "MSC edilizia srl" = "MSCedilizia S.r.l.") → si avvisa; si crea solo se
//     conferma che è un'altra impresa.
const supabase = require('./supabase');

const FORME = ['srls', 'srl', 'spa', 'snc', 'sas', 'sapa', 'scarl', 'scrl', 'soc', 'coop', 'societa', 'cooperativa', 'ditta', 'impresa', 'di', 'e', 'la', 'il'];
const RUOLI = { admin: 'Amministratore', tech: 'Tecnico', viewer: 'Solo lettura' };

/** "MSC edilizia srl", "MSCedilizia S.r.l." → "mscedilizia". */
function normalizzaNome(nome) {
  const parole = String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b([a-z])\.(?=[a-z]\.?)/g, '$1') // s.r.l. → srl
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (parole.length > 1 && FORME.includes(parole[parole.length - 1])) parole.pop();
  return parole.filter((p, i) => i === 0 || !FORME.includes(p) || p.length > 3).join('');
}

/** Inviti non usati e non scaduti per questa email. */
async function invitiAperti(email) {
  if (!email) return [];
  const { data, error } = await supabase.from('company_invites')
    .select('token, role, expires_at, companies(name)')
    .ilike('email', String(email).trim())
    .is('used_at', null).gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(5);
  if (error) throw new Error(error.message);
  return (data || []).map(i => ({ token: i.token, azienda: i.companies?.name || 'un\'azienda', ruolo: i.role, ruoloEtichetta: RUOLI[i.role] || i.role }));
}

/** Azienda già su Palladia con lo stesso nome (normalizzato), dello stesso tipo. Le aziende di prova (TEST-…) non contano. */
async function aziendaConNome(nome, accountType = 'impresa') {
  const chiave = normalizzaNome(nome);
  if (chiave.length < 3) return null;
  // A pagine da 1000 (il limite del DB): con le aziende di prova sono di più
  for (let da = 0; da < 50000; da += 1000) {
    const { data, error } = await supabase.from('companies').select('id, name, account_type')
      .not('name', 'ilike', 'test%').order('created_at', { ascending: true }).range(da, da + 999);
    if (error) throw new Error(error.message);
    const trovata = (data || []).find(c => (c.account_type || 'impresa') === accountType && normalizzaNome(c.name) === chiave);
    if (trovata) return trovata;
    if (!data || data.length < 1000) return null;
  }
  return null;
}

module.exports = { normalizzaNome, invitiAperti, aziendaConNome };
