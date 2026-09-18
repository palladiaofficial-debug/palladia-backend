'use strict';
// F-212 (AUDIT.md): consenso esplicito del lavoratore alla condivisione
// della propria busta paga con il soggetto esterno incaricato dei pagamenti
// (routes/v1/payerArea.js) — stesso identico schema del consenso privacy/GPS
// (F-178, lib/workerPrivacyConsent.js): un'unica informativa globale
// versionata, rapporto 1:1 per lavoratore (due colonne su `workers`,
// migrazione 220), verificato dal server prima di mostrare le buste paga —
// mai un flag cosmetico lato client.

// Bump manuale se il testo dell'informativa cambia in modo sostanziale —
// richiede nuovo consenso a tutti i lavoratori, esistenti compresi.
const PAYSLIP_SHARE_CONSENT_VERSION = '2026-09-17';

function hasValidConsent(worker) {
  return !!(worker && worker.payslip_share_consent_accepted_at && worker.payslip_share_consent_version === PAYSLIP_SHARE_CONSENT_VERSION);
}

// Il consenso ha senso chiederlo solo se l'azienda condivide DAVVERO le
// buste paga con un soggetto esterno in questo momento (almeno un accesso
// pagatore attivo, non scaduto/revocato) — altrimenti sarebbe un'informativa
// su una pratica che non esiste, il contrario di un consenso informato.
async function companyHasActivePayer(supabase, companyId) {
  const { data } = await supabase
    .from('payslip_payer_sessions')
    .select('id')
    .eq('company_id', companyId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Registra il consenso: aggiorna il puntatore "corrente" su `workers` (letto
// da hasValidConsent) e inserisce una riga durevole in admin_audit_log —
// prova consultabile in caso di controllo, non solo lo stato presente.
async function recordConsent(supabase, { workerId, companyId, ip, userAgent, source }) {
  const { error: updateErr } = await supabase
    .from('workers')
    .update({ payslip_share_consent_accepted_at: new Date().toISOString(), payslip_share_consent_version: PAYSLIP_SHARE_CONSENT_VERSION })
    .eq('id', workerId);
  if (updateErr) throw updateErr;

  const { error: auditErr } = await supabase.from('admin_audit_log').insert({
    company_id:  companyId,
    user_id:     null,
    user_role:   'worker_area',
    action:      'worker.payslip_share_consent_accepted',
    target_type: 'worker',
    target_id:   workerId,
    payload:     { version: PAYSLIP_SHARE_CONSENT_VERSION, source },
    ip:          (ip || '').slice(0, 45) || null,
    user_agent:  (userAgent || '').slice(0, 500) || null,
  });
  if (auditErr) console.error('[workerPayslipShareConsent] admin_audit_log insert fallito (non bloccante):', auditErr.message);
}

module.exports = { PAYSLIP_SHARE_CONSENT_VERSION, hasValidConsent, companyHasActivePayer, recordConsent };
