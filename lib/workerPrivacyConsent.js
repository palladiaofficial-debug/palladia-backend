'use strict';
// F-178 (AUDIT.md): consenso privacy/GPS verificato dal server, non un
// flag localStorage cosmetico. Un'unica informativa globale versionata,
// rapporto 1:1 per lavoratore — a differenza di pos_acknowledgments
// (N:1 documento↔lavoratore), quindi due colonne su `workers`
// (migrazione 205) invece di una tabella a parte.

// Bump manuale se il testo dell'informativa cambia in modo sostanziale —
// richiede nuovo consenso a tutti i lavoratori, esistenti compresi.
const PRIVACY_CONSENT_VERSION = '2026-09-12';

function hasValidConsent(worker) {
  return !!(worker && worker.privacy_consent_accepted_at && worker.privacy_consent_version === PRIVACY_CONSENT_VERSION);
}

// Registra il consenso: aggiorna il puntatore "corrente" su `workers` (letto
// da hasValidConsent) e inserisce una riga durevole in admin_audit_log
// (append-only via trigger, stesso pattern di punch.rejected_geofence in
// routes/v1/badgePunch.js) — prova consultabile in caso di controllo, non
// solo lo stato presente.
async function recordConsent(supabase, { workerId, companyId, ip, userAgent, source }) {
  const { error: updateErr } = await supabase
    .from('workers')
    .update({ privacy_consent_accepted_at: new Date().toISOString(), privacy_consent_version: PRIVACY_CONSENT_VERSION })
    .eq('id', workerId);
  if (updateErr) throw updateErr;

  const { error: auditErr } = await supabase.from('admin_audit_log').insert({
    company_id:  companyId,
    user_id:     null,
    user_role:   'worker_badge',
    action:      'worker.privacy_consent_accepted',
    target_type: 'worker',
    target_id:   workerId,
    payload:     { version: PRIVACY_CONSENT_VERSION, source },
    ip:          (ip || '').slice(0, 45) || null,
    user_agent:  (userAgent || '').slice(0, 500) || null,
  });
  if (auditErr) console.error('[workerPrivacyConsent] admin_audit_log insert fallito (non bloccante):', auditErr.message);
}

module.exports = { PRIVACY_CONSENT_VERSION, hasValidConsent, recordConsent };
