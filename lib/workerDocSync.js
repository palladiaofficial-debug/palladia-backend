'use strict';
/**
 * lib/workerDocSync.js
 * Sincronizza workers.health_fitness_expiry / workers.safety_training_expiry
 * col documento più recente in worker_documents — unica fonte di verità per
 * lo stato "Conforme/Non conforme" mostrato in Organico, badge e cruscotti.
 *
 * Estratto da routes/v1/workerDocs.js (F-105, AUDIT.md): il percorso di
 * caricamento manuale la chiamava già dopo ogni insert/update/delete; il
 * percorso di archiviazione via chat (services/chatDocumentAnalysis.js,
 * tool Ladia archive_document) non la chiamava mai — un'idoneità medica
 * archiviata da Ladia finiva nel registro documenti ma non aggiornava mai
 * lo stato di conformità del lavoratore altrove nella piattaforma.
 */

const supabase = require('./supabase');

// Stessi valori validi già in uso da routes/v1/workerDocs.js (upload manuale) —
// unica lista, non duplicata: se cambia lì, chi la importa da qui la vede subito.
const ALLOWED_WORKER_DOC_TYPES = [
  'idoneita_medica',
  'formazione_sicurezza',
  'primo_soccorso',
  'antincendio',
  'lavori_quota',
  'ponteggi',
  'gruista',
  'pes_pav_pei',
  'rspp',
  'patente_guida',
  'altro',
];

async function syncWorkerExpiry(docType, workerId, companyId) {
  const field = docType === 'idoneita_medica'      ? 'health_fitness_expiry'
    : docType === 'formazione_sicurezza' ? 'safety_training_expiry'
    : null;
  if (!field) return;
  // Usa MAX(ai_expiry_date, expiry_date) coerente con BadgeModal.computeDocStatus.
  // expiry_date (confermato dall'utente) ha priorità su ai_expiry_date (AI fallibile)
  const { data } = await supabase
    .from('worker_documents')
    .select('expiry_date, ai_expiry_date')
    .eq('worker_id',  workerId)
    .eq('company_id', companyId)
    .eq('doc_type',   docType);

  const maxExpiry = (data || [])
    .map(d => d.expiry_date || d.ai_expiry_date)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  await supabase.from('workers')
    .update({ [field]: maxExpiry })
    .eq('id', workerId)
    .eq('company_id', companyId);
}

module.exports = { syncWorkerExpiry, ALLOWED_WORKER_DOC_TYPES };
