'use strict';
/**
 * services/companyDocExpiryCron.js
 * Cron giornaliero (07:12) — scadenze documenti aziendali + Telegram + email.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, inDays, severityFor, severityLabel,
  upsertNotification, shouldSendTelegram, pruneNotifications,
} = require('./expiryHelper');
// Email rimossa: ora gestita dal digest unificato (dailyDigestCron)
const {
  notifyExpiryAlert, notifyResolved, buildCompanyDocExpiryMessage,
} = require('./telegramNotifications');

const CATEGORY_LABELS = {
  rspp: 'RSPP', rls: 'RLS', medico_competente: 'Medico Competente',
  visite_mediche: 'Visite Mediche', primo_soccorso: 'Primo Soccorso',
  emergenze: 'Piano Emergenze', preposto: 'Preposto', dvr: 'DVR', duvri: 'DUVRI',
  formazione: 'Formazione', durc: 'DURC', visura: 'Visura Camerale',
  iso: 'Certificazione ISO', soa: 'Attestazione SOA',
  assicurazione: 'Assicurazione', polizza: 'Polizza', f24: 'F24', altro: 'Documento',
};

async function runCompanyDocExpiryCheck() {
  console.log('[companyDocExpiry] avvio controllo scadenze documenti aziendali...');
  const t30 = inDays(30);

  const { data: docs, error } = await supabase
    .from('company_documents')
    .select('id, company_id, name, category, ai_expiry_date, ai_renewal_years')
    .not('ai_expiry_date', 'is', null)
    .lte('ai_expiry_date', t30);

  if (error) { console.error('[companyDocExpiry] fetch error:', error.message); return; }
  if (!docs?.length) { console.log('[companyDocExpiry] nessuna scadenza — skip.'); return; }

  const byCompany = {};
  for (const doc of docs) {
    const days = daysUntil(doc.ai_expiry_date);
    if (days === null) continue;
    if (!byCompany[doc.company_id]) byCompany[doc.company_id] = [];
    byCompany[doc.company_id].push({ ...doc, days, severity: severityFor(days) });
  }

  for (const companyId of Object.keys(byCompany)) {
    const items = byCompany[companyId];
    try {
      const relevantIds   = new Set();
      const telegramItems = [];

      for (const doc of items) {
        const catLabel   = CATEGORY_LABELS[doc.category] || 'Documento';
        const renewalNote = doc.ai_renewal_years
          ? ` (rinnovo ogni ${doc.ai_renewal_years} ann${doc.ai_renewal_years === 1 ? 'o' : 'i'})`
          : '';
        const { isNew, escalated } = await upsertNotification({
          companyId, type: 'company_doc_expiry', severity: doc.severity,
          title: `${catLabel}: ${doc.name}`,
          body:  severityLabel(doc.days) + renewalNote,
          entityType: 'company_document', entityId: doc.id,
        });
        relevantIds.add(doc.id);
        if (shouldSendTelegram(doc.severity, { isNew, escalated })) {
          telegramItems.push(doc);
        }
      }

      const { resolved } = await pruneNotifications(companyId, 'company_doc_expiry', 'company_document', relevantIds);

      if (telegramItems.length) {
        const msg = buildCompanyDocExpiryMessage(telegramItems, CATEGORY_LABELS);
        await notifyExpiryAlert(companyId, msg).catch(() => {});
      }
      if (resolved.length) {
        await notifyResolved(companyId, resolved, 'Documenti aziendali aggiornati').catch(() => {});
      }

      console.log(`[companyDocExpiry] ${companyId}: Telegram → ${telegramItems.length} docs`);
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
  console.log('[cron] company-doc-expiry attivo — 07:12 Europe/Rome');
}

module.exports = { startCompanyDocExpiryCron, runCompanyDocExpiryCheck };
