'use strict';
/**
 * services/companyDocExpiryCron.js
 *
 * Cron giornaliero (07:12 Europe/Rome) — controlla company_documents.ai_expiry_date:
 * scadenze estratte automaticamente dall'AI al momento dell'upload.
 *
 * Soglie: critical (già scaduto), warning (≤7gg), info (≤30gg).
 * Crea notifiche in-app + invia email agli owner/admin/tech.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, today, inDays,
  severityFor, severityLabel,
  getCompanyName, getCompanyAdminEmails,
  upsertNotification, pruneNotifications,
} = require('./expiryHelper');
const { sendCompanyDocExpiryAlert } = require('./email');

const CATEGORY_LABELS = {
  rspp:              'RSPP',
  rls:               'RLS',
  medico_competente: 'Medico Competente',
  visite_mediche:    'Visite Mediche',
  primo_soccorso:    'Primo Soccorso',
  emergenze:         'Piano Emergenze',
  preposto:          'Preposto',
  dvr:               'DVR',
  duvri:             'DUVRI',
  formazione:        'Formazione',
  durc:              'DURC',
  visura:            'Visura Camerale',
  iso:               'Certificazione ISO',
  soa:               'Attestazione SOA',
  assicurazione:     'Assicurazione',
  polizza:           'Polizza',
  f24:               'F24',
  altro:             'Documento',
};

async function runCompanyDocExpiryCheck() {
  console.log('[companyDocExpiry] avvio controllo scadenze documenti aziendali...');

  const t30 = inDays(30);

  // Prende solo documenti con ai_expiry_date compilata e in scadenza entro 30gg (o già scaduta)
  const { data: docs, error } = await supabase
    .from('company_documents')
    .select('id, company_id, name, category, ai_expiry_date, ai_renewal_years')
    .not('ai_expiry_date', 'is', null)
    .lte('ai_expiry_date', t30);

  if (error) { console.error('[companyDocExpiry] fetch error:', error.message); return; }
  if (!docs?.length) { console.log('[companyDocExpiry] nessuna scadenza imminente — skip.'); return; }

  // Raggruppa per company
  const byCompany = {};
  for (const doc of docs) {
    const days = daysUntil(doc.ai_expiry_date);
    if (days === null) continue;
    if (!byCompany[doc.company_id]) byCompany[doc.company_id] = [];
    byCompany[doc.company_id].push({ ...doc, days, severity: severityFor(days) });
  }

  const companyIds = Object.keys(byCompany);
  if (!companyIds.length) { console.log('[companyDocExpiry] nessuna scadenza rilevante — skip.'); return; }

  for (const companyId of companyIds) {
    const items = byCompany[companyId];

    try {
      // ── Notifiche in-app ────────────────────────────────────────────────────
      const relevantIds = new Set();

      for (const doc of items) {
        const catLabel = CATEGORY_LABELS[doc.category] || 'Documento';
        const renewalNote = doc.ai_renewal_years
          ? ` (rinnovo ogni ${doc.ai_renewal_years} ann${doc.ai_renewal_years === 1 ? 'o' : 'i'})`
          : '';

        await upsertNotification({
          companyId,
          type:       'company_doc_expiry',
          severity:   doc.severity,
          title:      `${catLabel}: ${doc.name}`,
          body:       severityLabel(doc.days) + renewalNote,
          entityType: 'company_document',
          entityId:   doc.id,
        });
        relevantIds.add(doc.id);
      }

      await pruneNotifications(companyId, 'company_doc_expiry', 'company_document', relevantIds);

      // ── Email ────────────────────────────────────────────────────────────────
      const emails      = await getCompanyAdminEmails(companyId);
      const companyName = await getCompanyName(companyId);

      if (emails.length) {
        await sendCompanyDocExpiryAlert({
          to: emails,
          companyName,
          docs: items,
          categoryLabels: CATEGORY_LABELS,
          dashboardUrl: (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '') + '/risorse',
        });
        console.log(`[companyDocExpiry] ${companyId}: email → ${emails.length} destinatari, ${items.length} documenti`);
      }
    } catch (e) {
      console.error(`[companyDocExpiry] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[companyDocExpiry] completato.');
}

function startCompanyDocExpiryCron() {
  cron.schedule('12 7 * * *', async () => {
    try { await runCompanyDocExpiryCheck(); }
    catch (e) { console.error('[companyDocExpiry] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });

  console.log('[cron] company-doc-expiry scheduler attivo — ogni giorno alle 07:12 (Europe/Rome)');
}

module.exports = { startCompanyDocExpiryCron, runCompanyDocExpiryCheck };
