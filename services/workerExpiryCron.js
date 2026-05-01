'use strict';
/**
 * services/workerExpiryCron.js
 *
 * Cron giornaliero (07:15 Europe/Rome) — controlla worker_documents.expiry_date
 * per TUTTI i tipi di documento (idoneità, formazione, antincendio, ponteggi, ecc.).
 *
 * Soglie:
 *   - critical: già scaduto (< oggi)
 *   - warning:  scade entro 7 giorni
 *   - info:     scade entro 30 giorni
 *
 * Crea notifiche in-app + invia email agli owner/admin/tech.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, inDays,
  severityFor, severityLabel,
  getCompanyName, getCompanyAdminEmails,
  upsertNotification, pruneNotifications,
} = require('./expiryHelper');
const { sendWorkerDocExpiryAlert } = require('./email');

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

  // Tutti i worker_documents con scadenza nei prossimi 30 giorni (o già scaduta)
  const { data: docs, error } = await supabase
    .from('worker_documents')
    .select(`
      id, company_id, worker_id, doc_type, name, expiry_date,
      worker:workers ( full_name, is_active )
    `)
    .not('expiry_date', 'is', null)
    .lte('expiry_date', t30);

  if (error) { console.error('[workerExpiry] fetch error:', error.message); return; }

  // Filtra solo lavoratori attivi
  const relevant = (docs || []).filter(d => d.worker?.is_active);
  if (!relevant.length) { console.log('[workerExpiry] nessuna scadenza imminente — skip.'); return; }

  // Aggiungi days + severity
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

  const companyIds = Object.keys(byCompany);
  if (!companyIds.length) { console.log('[workerExpiry] nessuna scadenza rilevante — skip.'); return; }

  console.log(`[workerExpiry] ${companyIds.length} company con scadenze imminenti`);

  for (const companyId of companyIds) {
    const items = byCompany[companyId];

    try {
      // ── Notifiche in-app — una per documento ──────────────────────────────
      const relevantIds = new Set();

      for (const d of items) {
        const typeLabel = DOC_TYPE_LABELS[d.doc_type] || 'Documento';
        await upsertNotification({
          companyId,
          type:       'worker_doc_expiry',
          severity:   d.severity,
          title:      `${d.worker.full_name} — ${typeLabel}`,
          body:       severityLabel(d.days),
          entityType: 'worker_document',
          entityId:   d.id,
        });
        relevantIds.add(d.id);
      }

      await pruneNotifications(companyId, 'worker_doc_expiry', 'worker_document', relevantIds);

      // ── Email ─────────────────────────────────────────────────────────────
      const emails      = await getCompanyAdminEmails(companyId);
      const companyName = await getCompanyName(companyId);

      if (emails.length) {
        await sendWorkerDocExpiryAlert({
          to: emails,
          companyName,
          docs: items,
          docTypeLabels: DOC_TYPE_LABELS,
          dashboardUrl: (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '') + '/risorse',
        });
        console.log(`[workerExpiry] ${companyId}: email → ${emails.length} destinatari, ${items.length} documenti`);
      }
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

  console.log('[cron] worker-expiry scheduler attivo — ogni giorno alle 07:15 (Europe/Rome)');
}

module.exports = { startWorkerExpiryCron, runWorkerExpiryCheck };
