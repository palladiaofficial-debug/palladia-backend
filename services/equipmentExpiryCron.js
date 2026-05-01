'use strict';
/**
 * services/equipmentExpiryCron.js
 *
 * Cron giornaliero (07:10 Europe/Rome) — controlla scadenze dei mezzi aziendali:
 *   - insurance_expiry  (assicurazione)
 *   - inspection_date   (revisione periodica)
 *   - maintenance_date  (tagliando / manutenzione)
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
  daysUntil, today, inDays,
  severityFor, severityLabel,
  getCompanyName, getCompanyAdminEmails,
  upsertNotification, pruneNotifications,
} = require('./expiryHelper');
const { sendEquipmentExpiryAlert } = require('./email');

const FIELDS = [
  { key: 'insurance_expiry',  label: 'Assicurazione' },
  { key: 'inspection_date',   label: 'Revisione periodica' },
  { key: 'maintenance_date',  label: 'Tagliando / Manutenzione' },
];

async function runEquipmentExpiryCheck() {
  console.log('[equipmentExpiry] avvio controllo scadenze mezzi...');

  const t0   = today();
  const t30  = inDays(30);

  // Recupera mezzi attivi con almeno una data scadenza entro 30 giorni (o già scaduta)
  const { data: equipment, error } = await supabase
    .from('equipment')
    .select('id, company_id, type, model, plate_or_serial, insurance_expiry, inspection_date, maintenance_date')
    .eq('is_active', true)
    .or([
      `insurance_expiry.lte.${t30}`,
      `inspection_date.lte.${t30}`,
      `maintenance_date.lte.${t30}`,
    ].join(','));

  if (error) { console.error('[equipmentExpiry] fetch error:', error.message); return; }
  if (!equipment?.length) { console.log('[equipmentExpiry] nessuna scadenza imminente — skip.'); return; }

  // Raggruppa per company
  const byCompany = {};
  for (const eq of equipment) {
    const issues = [];
    for (const { key, label } of FIELDS) {
      const days = daysUntil(eq[key]);
      if (days === null || days > 30) continue;
      issues.push({ key, label, date: eq[key], days, severity: severityFor(days) });
    }
    if (!issues.length) continue;

    if (!byCompany[eq.company_id]) byCompany[eq.company_id] = [];
    byCompany[eq.company_id].push({ ...eq, issues });
  }

  const companyIds = Object.keys(byCompany);
  if (!companyIds.length) { console.log('[equipmentExpiry] nessuna scadenza rilevante — skip.'); return; }

  for (const companyId of companyIds) {
    const items = byCompany[companyId];

    try {
      // ── Notifiche in-app ────────────────────────────────────────────────────
      const relevantIds = new Set();

      for (const eq of items) {
        // Una notifica per mezzo (severity peggiore tra tutte le sue scadenze)
        const worstSeverity = eq.issues.reduce((best, i) => {
          const rank = { info: 0, warning: 1, critical: 2 };
          return (rank[i.severity] ?? 0) > (rank[best] ?? 0) ? i.severity : best;
        }, 'info');

        const name = [eq.type, eq.model, eq.plate_or_serial].filter(Boolean).join(' — ');
        const bodyParts = eq.issues.map(i => `${i.label}: ${severityLabel(i.days)}`).join(', ');

        await upsertNotification({
          companyId,
          type:       'equipment_expiry',
          severity:   worstSeverity,
          title:      `Mezzo: ${name}`,
          body:       bodyParts,
          entityType: 'equipment',
          entityId:   eq.id,
        });
        relevantIds.add(eq.id);
      }

      await pruneNotifications(companyId, 'equipment_expiry', 'equipment', relevantIds);

      // ── Email ────────────────────────────────────────────────────────────────
      const emails      = await getCompanyAdminEmails(companyId);
      const companyName = await getCompanyName(companyId);

      if (emails.length) {
        await sendEquipmentExpiryAlert({
          to: emails,
          companyName,
          items,
          dashboardUrl: (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '') + '/risorse',
        });
        console.log(`[equipmentExpiry] ${companyId}: email → ${emails.length} destinatari, ${items.length} mezzi`);
      }
    } catch (e) {
      console.error(`[equipmentExpiry] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[equipmentExpiry] completato.');
}

function startEquipmentExpiryCron() {
  cron.schedule('10 7 * * *', async () => {
    try { await runEquipmentExpiryCheck(); }
    catch (e) { console.error('[equipmentExpiry] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });

  console.log('[cron] equipment-expiry scheduler attivo — ogni giorno alle 07:10 (Europe/Rome)');
}

module.exports = { startEquipmentExpiryCron, runEquipmentExpiryCheck };
