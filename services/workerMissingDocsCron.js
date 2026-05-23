'use strict';
/**
 * services/workerMissingDocsCron.js
 *
 * Cron giornaliero (07:05 Europe/Rome) — individua lavoratori attivi privi
 * di documenti obbligatori per legge (D.Lgs. 81/2008):
 *   - Idoneità medica (visita medica)
 *   - Formazione sicurezza
 *
 * Comportamento:
 *   - Crea notifica in-app (severity: critical) per ogni lavoratore mancante
 *   - Invia Telegram ogni giorno finché il documento non viene caricato
 *   - Quando il documento viene caricato → invia "✅ Risolto" su Telegram
 *   - Raggruppa tutto in un unico messaggio per company (anti-spam)
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  getCompanyName, getCompanyAdminEmails,
  upsertNotification, pruneNotifications,
} = require('./expiryHelper');
const {
  notifyExpiryAlert, notifyResolved, buildMissingDocsMessage,
} = require('./telegramNotifications');
// Email rimossa: ora gestita dal digest unificato (dailyDigestCron)

const REQUIRED_TYPES = ['idoneita_medica', 'formazione_sicurezza'];
const REQUIRED_LABELS = {
  idoneita_medica:      'Visita medica',
  formazione_sicurezza: 'Formazione sicurezza',
};

async function runWorkerMissingDocsCheck() {
  console.log('[workerMissingDocs] avvio controllo documenti obbligatori mancanti...');

  // 1. Tutti i lavoratori attivi
  const { data: workers, error: wErr } = await supabase
    .from('workers')
    .select('id, company_id, full_name')
    .eq('is_active', true);

  if (wErr) { console.error('[workerMissingDocs] fetch workers error:', wErr.message); return; }
  if (!workers?.length) { console.log('[workerMissingDocs] nessun lavoratore — skip.'); return; }

  const workerIds = workers.map(w => w.id);

  // 2. Documenti esistenti per i tipi obbligatori (solo quelli non scaduti o senza scadenza)
  const todayStr = new Date().toISOString().split('T')[0];
  const { data: docs, error: dErr } = await supabase
    .from('worker_documents')
    .select('worker_id, doc_type')
    .in('worker_id', workerIds)
    .in('doc_type', REQUIRED_TYPES)
    .or(`expiry_date.is.null,expiry_date.gte.${todayStr}`);

  if (dErr) { console.error('[workerMissingDocs] fetch docs error:', dErr.message); return; }

  // 3. Costruisci set dei tipi per ogni worker
  const workerDocTypes = new Map(); // workerId → Set<docType>
  for (const d of (docs || [])) {
    if (!workerDocTypes.has(d.worker_id)) workerDocTypes.set(d.worker_id, new Set());
    workerDocTypes.get(d.worker_id).add(d.doc_type);
  }

  // 4. Trova worker con almeno un tipo mancante
  const missingByWorker = [];
  for (const w of workers) {
    const present      = workerDocTypes.get(w.id) || new Set();
    const missingTypes = REQUIRED_TYPES
      .filter(t => !present.has(t))
      .map(t => REQUIRED_LABELS[t]);
    if (missingTypes.length) {
      missingByWorker.push({ ...w, missingTypes });
    }
  }

  if (!missingByWorker.length) {
    console.log('[workerMissingDocs] tutti i lavoratori hanno i documenti obbligatori — skip.');
    return;
  }

  // 5. Raggruppa per company
  const byCompany = {};
  for (const w of missingByWorker) {
    if (!byCompany[w.company_id]) byCompany[w.company_id] = [];
    byCompany[w.company_id].push(w);
  }

  for (const companyId of Object.keys(byCompany)) {
    const workersMissing = byCompany[companyId];
    try {
      const relevantIds = new Set();

      // Notifica in-app (una per lavoratore, severity sempre critical)
      for (const w of workersMissing) {
        await upsertNotification({
          companyId,
          type:       'worker_doc_missing',
          severity:   'critical',
          title:      `${w.full_name} — ${w.missingTypes.join(', ')}`,
          body:       'Documenti obbligatori mancanti',
          entityType: 'worker',
          entityId:   w.id,
        });
        relevantIds.add(w.id);
      }

      // Cleanup notifiche risolte (lavoratore ha ora tutti i doc)
      const { resolved } = await pruneNotifications(
        companyId, 'worker_doc_missing', 'worker', relevantIds
      );

      // Telegram — invia sempre (critical: ogni giorno)
      const msg = buildMissingDocsMessage(workersMissing);
      await notifyExpiryAlert(companyId, msg).catch(() => {});

      if (resolved.length) {
        await notifyResolved(companyId, resolved, 'Documenti obbligatori caricati').catch(() => {});
      }

      console.log(`[workerMissingDocs] ${companyId}: ${workersMissing.length} lavoratori, risolti → ${resolved.length}`);
    } catch (e) {
      console.error(`[workerMissingDocs] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[workerMissingDocs] completato.');
}

function startWorkerMissingDocsCron() {
  // Gira per primo, alle 07:05, così quando arrivano gli altri cron i dati sono già aggiornati
  cron.schedule('5 7 * * *', async () => {
    try { await runWorkerMissingDocsCheck(); }
    catch (e) { console.error('[workerMissingDocs] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] worker-missing-docs attivo — 07:05 Europe/Rome');
}

module.exports = { startWorkerMissingDocsCron, runWorkerMissingDocsCheck };
