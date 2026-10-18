'use strict';
/**
 * services/equipmentExpiryCron.js
 * Cron giornaliero (07:10) — scadenze mezzi aziendali + Telegram + email.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, inDays, severityFor, severityLabel,
  upsertNotification, shouldSendTelegram, pruneNotifications, pruneOrphanedNotifications,
} = require('./expiryHelper');
const { allRows } = require('../lib/allRows');
// Email rimossa: ora gestita dal digest unificato (dailyDigestCron)
const {
  notifyExpiryAlert, notifyResolved, buildEquipmentExpiryMessage,
} = require('./telegramNotifications');

const FIELDS = [
  { key: 'insurance_expiry',  label: 'Assicurazione' },
  { key: 'inspection_date',   label: 'Revisione periodica' },
  { key: 'maintenance_date',  label: 'Tagliando / Manutenzione' },
];

async function runEquipmentExpiryCheck() {
  console.log('[equipmentExpiry] avvio controllo scadenze mezzi...');
  const t30 = inDays(30);

  let equipment;
  try {
    equipment = await allRows(() => supabase
      .from('equipment')
      .select('id, company_id, type, model, plate_or_serial, insurance_expiry, inspection_date, maintenance_date')
      .eq('is_active', true)
      .or(`insurance_expiry.lte.${t30},inspection_date.lte.${t30},maintenance_date.lte.${t30}`)
      .order('id'), 'equipment');
  } catch (e) { console.error('[equipmentExpiry] fetch error:', e.message); return; }

  // F-375: i promemoria in più (bollo, tagliando, cronotachigrafo, verifica
  // periodica, altro) avvisano come assicurazione e revisione.
  let promemoria = [];
  try {
    promemoria = await allRows(() => supabase
      .from('equipment_promemoria')
      .select('id, equipment_id, tipo, testo, scadenza, equipment!inner(id, company_id, type, model, plate_or_serial, insurance_expiry, inspection_date, maintenance_date, is_active)')
      .lte('scadenza', t30)
      .eq('equipment.is_active', true)
      .order('id'), 'equipment_promemoria');
  } catch (e) { console.error('[equipmentExpiry] promemoria fetch error:', e.message); }
  const ETICHETTA = { bollo: 'Bollo', tagliando: 'Tagliando', cronotachigrafo: 'Cronotachigrafo', verifica: 'Verifica periodica' };
  const extra = new Map();
  for (const p of promemoria) {
    if (!extra.has(p.equipment_id)) extra.set(p.equipment_id, { eq: p.equipment, list: [] });
    extra.get(p.equipment_id).list.push(p);
  }
  const tutti = [...(equipment || [])];
  for (const [id, { eq }] of extra) if (!tutti.some(e => e.id === id)) tutti.push(eq);

  const byCompany = {};
  for (const eq of tutti) {
    const issues = [];
    for (const { key, label } of FIELDS) {
      const days = daysUntil(eq[key]);
      if (days === null || days > 30) continue;
      issues.push({ key, label, date: eq[key], days, severity: severityFor(days) });
    }
    for (const p of extra.get(eq.id)?.list || []) {
      const days = daysUntil(p.scadenza);
      if (days === null || days > 30) continue;
      issues.push({ key: `promemoria_${p.tipo}`, label: ETICHETTA[p.tipo] || p.testo || 'Promemoria', date: p.scadenza, days, severity: severityFor(days) });
    }
    if (!issues.length) continue;
    if (!byCompany[eq.company_id]) byCompany[eq.company_id] = [];
    byCompany[eq.company_id].push({ ...eq, issues });
  }

  // F-088: sweep delle company la cui ultima scadenza mezzi si è risolta oggi
  // (uscite da `byCompany`) — senza questo, la notifica resta orfana per sempre.
  const { resolved: orphanResolved } = await pruneOrphanedNotifications('equipment_expiry', 'equipment', new Set(Object.keys(byCompany)));
  for (const r of orphanResolved) {
    await notifyResolved(r.companyId, [r], 'Scadenze mezzi aggiornate').catch(() => {});
  }
  if (orphanResolved.length) console.log(`[equipmentExpiry] risolti orfani: ${orphanResolved.length}`);

  if (!Object.keys(byCompany).length) { console.log('[equipmentExpiry] nessuna scadenza — skip.'); return; }

  for (const companyId of Object.keys(byCompany)) {
    const items = byCompany[companyId];
    try {
      const relevantIds   = new Set();
      const telegramItems = [];

      for (const eq of items) {
        const worstSeverity = eq.issues.reduce((best, i) => {
          const rank = { info: 0, warning: 1, critical: 2 };
          return (rank[i.severity] ?? 0) > (rank[best] ?? 0) ? i.severity : best;
        }, 'info');

        const name     = [eq.type, eq.model, eq.plate_or_serial].filter(Boolean).join(' — ');
        const bodyParts = eq.issues.map(i => `${i.label}: ${severityLabel(i.days)}`).join(', ');

        const { isNew, escalated } = await upsertNotification({
          companyId, type: 'equipment_expiry', severity: worstSeverity,
          title: `Mezzo: ${name}`, body: bodyParts,
          entityType: 'equipment', entityId: eq.id,
        });
        relevantIds.add(eq.id);
        if (shouldSendTelegram(worstSeverity, { isNew, escalated })) {
          telegramItems.push(eq);
        }
      }

      const { resolved } = await pruneNotifications(companyId, 'equipment_expiry', 'equipment', relevantIds);

      if (telegramItems.length) {
        const msg = buildEquipmentExpiryMessage(telegramItems);
        await notifyExpiryAlert(companyId, msg).catch(() => {});
      }
      if (resolved.length) {
        await notifyResolved(companyId, resolved, 'Scadenze mezzi aggiornate').catch(() => {});
      }

      console.log(`[equipmentExpiry] ${companyId}: Telegram → ${telegramItems.length} mezzi`);
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
  console.log('[cron] equipment-expiry attivo — 07:10 Europe/Rome');
}

module.exports = { startEquipmentExpiryCron, runEquipmentExpiryCheck };
