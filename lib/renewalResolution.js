'use strict';
const supabase = require('./supabase');

// ── Flusso scadenza→rinnovo — Fase 3.4 "Ciclo del Risultato" ─────────────────
// Oggi una scadenza intercettata (expiry_interception_log) viene marcata
// risolta solo al prossimo giro del cron notturno (services/expiryHelper.js:
// pruneNotifications), quando il problema esce dal set "in scadenza". Questo
// significa che il Contato di un rinnovo appena fatto non è immediatamente
// verificabile — bisogna aspettare fino al giorno dopo perché "scadenza
// intercettata" compaia nella ResultCard.
//
// resolveInterceptedExpiry cerca la riga ANCORA APERTA per questa entità e la
// risolve SUBITO dopo una scrittura di rinnovo riuscita, stampando anche quale
// azione l'ha risolta (superseded_by_action_history_id, migrazione 145) — così
// il numero nella ResultCard è tracciabile a un evento preciso, non a un batch
// notturno anonimo.
//
// Solo per i destination-type che usano davvero expiry_interception_log
// (company_documents/worker_documents — vedi migrazione 141): worker_certificates
// usa un trail più vecchio e diverso (expiry_notifications, rilevamento per
// confronto con la formazione successiva, nessun resolved_at da stampare) e
// site_documents non ha affatto un concetto di scadenza intercettata — per
// questi due il cron resta l'unico meccanismo, non è una regressione.
const ENTITY_TYPE_BY_DESTINATION = {
  company_documents: 'company_document',
  worker_documents: 'worker_document',
};

async function resolveInterceptedExpiry({ companyId, destination, recordId, actionHistoryId }) {
  const entityType = ENTITY_TYPE_BY_DESTINATION[destination];
  if (!entityType || !recordId) return null;

  // Entity_id per company_documents/worker_documents è l'id della riga stessa
  // (a differenza di subcontractors, dove entity_id è composito "<id>::campo"
  // — questi due destination-type hanno una sola scadenza per riga).
  const { data, error } = await supabase
    .from('expiry_interception_log')
    .update({ resolved_at: new Date().toISOString(), superseded_by_action_history_id: actionHistoryId || null })
    .eq('company_id', companyId)
    .eq('entity_type', entityType)
    .eq('entity_id', String(recordId))
    .is('resolved_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[renewalResolution] risoluzione fallita:', error.message);
    return null;
  }
  return data || null;
}

module.exports = { resolveInterceptedExpiry };
