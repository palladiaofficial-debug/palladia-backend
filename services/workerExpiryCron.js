'use strict';
/**
 * services/workerExpiryCron.js
 *
 * Cron giornaliero (07:15 Europe/Rome) — controlla worker_documents.expiry_date
 * per TUTTI i tipi di documento (idoneità, formazione, antincendio, ponteggi, ecc.).
 *
 * Cadenza Telegram:
 *   - critical (già scaduto): ogni giorno
 *   - warning/info (prima volta o peggioramento): una volta
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, inDays,
  severityFor, severityLabel,
  getCompanyName, getCompanyAdminEmails,
  upsertNotification, shouldSendTelegram, pruneNotifications,
} = require('./expiryHelper');
// Email rimossa: ora gestita dal digest unificato (dailyDigestCron)
const {
  notifyExpiryAlert, notifyResolved,
  buildWorkerDocExpiryMessage,
} = require('./telegramNotifications');

const DOC_TYPE_LABELS = {
  idoneita_medica:      'Idoneità medica',
  formazione_sicurezza: 'Formazione sicurezza',
  primo_soccorso:       'Primo soccorso',
  antincendio:          'Antincendio',
  lavori_quota:         'Lavori in quota',
  ponteggi:             'Ponteggi',
  gruista:              'Gruista',
  pes_pav_pei:          'PES/PAV/PEI',
  rspp:                 'RSPP',
  patente_guida:        'Patente di guida',
  altro:                'Documento',
};

async function runWorkerExpiryCheck() {
  console.log('[workerExpiry] avvio controllo scadenze documenti lavoratori...');

  const t30 = inDays(30);

  const { data: docs, error } = await supabase
    .from('worker_documents')
    .select(`id, company_id, worker_id, doc_type, name, expiry_date,
             worker:workers ( full_name, is_active )`)
    .not('expiry_date', 'is', null)
    .order('expiry_date', { ascending: false });

  if (error) { console.error('[workerExpiry] fetch error:', error.message); return; }

  // Dedup per (worker_id, doc_type): tieni solo il doc con expiry massima.
  // Evita alert su versioni vecchie scadute quando esiste un rinnovo valido.
  const latestByKey = new Map();
  for (const d of (docs || [])) {
    if (!d.worker?.is_active) continue;
    const key = `${d.worker_id}:${d.doc_type}`;
    if (!latestByKey.has(key)) latestByKey.set(key, d); // già ordinati DESC
  }
  const relevant = [...latestByKey.values()].filter(d => d.expiry_date <= t30);
  if (!relevant.length) { console.log('[workerExpiry] nessuna scadenza — skip.'); return; }

  const docsWithMeta = relevant.map(d => ({
    ...d,
    days:     daysUntil(d.expiry_date),
    severity: severityFor(daysUntil(d.expiry_date)),
  }));

  // Raggruppa per company
  const byCompany = {};
  for (const d of docsWithMeta) {
    if (!byCompany[d.company_id]) byCompany[d.company_id] = [];
    byCompany[d.company_id].push(d);
  }

  for (const companyId of Object.keys(byCompany)) {
    const items = byCompany[companyId];
    try {
      // ── Notifiche in-app + flag Telegram ──────────────────────────────────
      const relevantIds  = new Set();
      const telegramDocs = []; // docs che richiedono notifica Telegram oggi

      for (const d of items) {
        const typeLabel = DOC_TYPE_LABELS[d.doc_type] || 'Documento';
        const { isNew, escalated } = await upsertNotification({
          companyId,
          type:       'worker_doc_expiry',
          severity:   d.severity,
          title:      `${d.worker.full_name} — ${typeLabel}`,
          body:       severityLabel(d.days),
          entityType: 'worker_document',
          entityId:   d.id,
        });
        relevantIds.add(d.id);
        if (shouldSendTelegram(d.severity, { isNew, escalated })) {
          telegramDocs.push(d);
        }
      }

      const { resolved } = await pruneNotifications(companyId, 'worker_doc_expiry', 'worker_document', relevantIds);

      // ── Telegram ──────────────────────────────────────────────────────────
      if (telegramDocs.length) {
        // Raggruppa per tipo per il messaggio
        const byType = {};
        for (const d of telegramDocs) {
          if (!byType[d.doc_type]) byType[d.doc_type] = [];
          byType[d.doc_type].push(d);
        }
        const msg = buildWorkerDocExpiryMessage(byType, DOC_TYPE_LABELS);
        await notifyExpiryAlert(companyId, msg).catch(() => {});
      }

      if (resolved.length) {
        await notifyResolved(companyId, resolved, 'Documenti lavoratori aggiornati').catch(() => {});
      }

      console.log(`[workerExpiry] ${companyId}: Telegram → ${telegramDocs.length} docs, risolti → ${resolved.length}`);
    } catch (e) {
      console.error(`[workerExpiry] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[workerExpiry] completato.');
}

function startWorkerExpiryCron() {
  cron.schedule('15 7 * * *', async () => {
    try { await runWorkerExpiryCheck(); }
    catch (e) { console.error('[workerExpiry] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] worker-expiry attivo — 07:15 Europe/Rome');
}

module.exports = { startWorkerExpiryCron, runWorkerExpiryCheck };
