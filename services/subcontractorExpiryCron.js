'use strict';
/**
 * services/subcontractorExpiryCron.js
 * Cron giornaliero (07:40) — scadenze DURC, assicurazione e SOA dei subappaltatori
 * + DURC dell'impresa principale.
 *
 * Severity:
 *   info     → scade entro 30 giorni
 *   warning  → scade entro 7 giorni
 *   critical → già scaduta
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, inDays, severityFor, severityLabel,
  upsertNotification, shouldSendTelegram, pruneNotifications,
} = require('./expiryHelper');
const {
  notifyExpiryAlert, notifyResolved,
} = require('./telegramNotifications');

const EXPIRY_FIELDS = [
  { field: 'durc_expiry',      label: 'DURC' },
  { field: 'insurance_expiry', label: 'Assicurazione' },
  { field: 'soa_expiry',       label: 'SOA' },
];

function buildSubMessage(items) {
  const URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
  const lines = items.map(item => {
    const icon = item.severity === 'critical' ? '🔴' : '🟡';
    const when = item.days < 0
      ? `scaduto ${Math.abs(item.days)} giorn${Math.abs(item.days) === 1 ? 'o' : 'i'} fa`
      : `scade in ${item.days} giorni`;
    return `${icon} <b>${item.subName}</b> — ${item.label}: ${when}`;
  });
  return (
    `⚠️ <b>PALLADIA — Scadenze subappaltatori</b>\n\n` +
    lines.join('\n') +
    `\n\n→ <a href="${URL}/subappaltatori">Gestisci subappaltatori</a>`
  );
}

async function runSubcontractorExpiryCheck() {
  console.log('[subcontractorExpiry] avvio controllo scadenze...');
  const t30 = inDays(30);

  // ── 1. DURC impresa principale (companies.durc_expiry) ────────────────────
  const { data: companies } = await supabase
    .from('companies')
    .select('id, durc_expiry')
    .not('durc_expiry', 'is', null)
    .lte('durc_expiry', t30);

  for (const company of (companies || [])) {
    const days = daysUntil(company.durc_expiry);
    if (days === null) continue;
    const severity = severityFor(days);
    const { isNew, escalated } = await upsertNotification({
      companyId:  company.id,
      type:       'company_durc_expiry',
      severity,
      title:      'DURC impresa in scadenza',
      body:       severityLabel(days),
      entityType: 'company',
      entityId:   company.id,
    });
    if (shouldSendTelegram(severity, { isNew, escalated })) {
      const icon = severity === 'critical' ? '🔴' : '🟡';
      const when = days < 0
        ? `scaduto ${Math.abs(days)} giorni fa`
        : `scade in ${days} giorni`;
      const msg =
        `⚠️ <b>PALLADIA — DURC impresa</b>\n\n` +
        `${icon} DURC: ${when}\n\n` +
        `→ Rinnova il DURC entro i termini di legge.`;
      await notifyExpiryAlert(company.id, msg).catch(() => {});
    }
  }

  // Pruning DURC impresa: rimuovi notifica se non più rilevante
  const { data: allCompanies } = await supabase
    .from('companies').select('id, durc_expiry');
  for (const company of (allCompanies || [])) {
    const days = daysUntil(company.durc_expiry);
    if (days === null || days > 30) {
      await supabase.from('notifications').delete()
        .eq('company_id', company.id)
        .eq('type', 'company_durc_expiry')
        .eq('entity_type', 'company')
        .eq('entity_id', company.id);
    }
  }

  // ── 2. Scadenze subappaltatori ────────────────────────────────────────────
  const { data: subs, error } = await supabase
    .from('subcontractors')
    .select('id, company_id, company_name, durc_expiry, insurance_expiry, soa_expiry')
    .eq('is_active', true)
    .or(`durc_expiry.lte.${t30},insurance_expiry.lte.${t30},soa_expiry.lte.${t30}`);

  if (error) { console.error('[subcontractorExpiry] fetch error:', error.message); return; }
  if (!subs?.length) { console.log('[subcontractorExpiry] nessuna scadenza subappaltatori — skip.'); return; }

  // Raggruppa per company
  const byCompany = {};
  for (const sub of subs) {
    for (const { field, label } of EXPIRY_FIELDS) {
      if (!sub[field]) continue;
      const days = daysUntil(sub[field]);
      if (days === null || days > 30) continue;
      if (!byCompany[sub.company_id]) byCompany[sub.company_id] = [];
      byCompany[sub.company_id].push({
        sub, subName: sub.company_name, field, label,
        days, severity: severityFor(days),
      });
    }
  }

  for (const companyId of Object.keys(byCompany)) {
    const items = byCompany[companyId];
    try {
      const relevantIds   = new Set();
      const telegramItems = [];

      for (const item of items) {
        const entityId = `${item.sub.id}::${item.field}`;
        const { isNew, escalated } = await upsertNotification({
          companyId,
          type:       'subcontractor_expiry',
          severity:   item.severity,
          title:      `${item.label}: ${item.subName}`,
          body:       severityLabel(item.days),
          entityType: 'subcontractor',
          entityId,
        });
        relevantIds.add(entityId);
        if (shouldSendTelegram(item.severity, { isNew, escalated })) telegramItems.push(item);
      }

      const { resolved } = await pruneNotifications(companyId, 'subcontractor_expiry', 'subcontractor', relevantIds);

      if (telegramItems.length) {
        await notifyExpiryAlert(companyId, buildSubMessage(telegramItems)).catch(() => {});
      }
      if (resolved.length) {
        await notifyResolved(companyId, resolved, 'Subappaltatore aggiornato').catch(() => {});
      }

      console.log(`[subcontractorExpiry] company ${companyId}: ${items.length} scadenze, ${resolved.length} risolte`);
    } catch (err) {
      console.error(`[subcontractorExpiry] errore company ${companyId}:`, err.message);
    }
  }
}

function startSubcontractorExpiryCron() {
  cron.schedule('40 7 * * *', async () => {
    try {
      await runSubcontractorExpiryCheck();
    } catch (e) {
      console.error('[subcontractorExpiry] errore cron:', e.message);
    }
  }, { timezone: 'Europe/Rome' });

  console.log('[subcontractorExpiry] scheduler attivo — esecuzione giornaliera alle 07:40 (Europe/Rome)');
}

module.exports = { startSubcontractorExpiryCron, runSubcontractorExpiryCheck };
