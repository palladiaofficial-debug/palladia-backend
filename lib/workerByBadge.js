'use strict';
// ── Risoluzione lavoratore da badge_code — condiviso dagli endpoint pubblici ────

const supabase = require('./supabase');

const BADGE_CODE_RE = /^[A-Fa-f0-9]{18}$/;

// Ritorna { id, company_id, is_active } oppure null se il codice non è valido
// o non corrisponde a nessun lavoratore.
async function resolveWorkerByBadge(code) {
  if (!BADGE_CODE_RE.test(code)) return null;
  const { data } = await supabase
    .from('workers')
    .select('id, company_id, is_active')
    .eq('badge_code', code.toUpperCase())
    .maybeSingle();
  return data;
}

module.exports = { resolveWorkerByBadge, BADGE_CODE_RE };
