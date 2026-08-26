'use strict';
/**
 * services/studioDurcAlertCron.js
 * Cron giornaliero (07:45) — alert DURC in scadenza per lo studio CDL.
 * Per ogni studio che ha clienti con DURC in scadenza entro 30 giorni,
 * invia una email riepilogativa con l'elenco dei clienti da contattare.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { inDays, daysUntil, severityFor } = require('./expiryHelper');
const { sendStudioDurcAlert } = require('./email');

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

/**
 * Dedup F-087: senza questo controllo, ogni cliente con DURC entro 30gg
 * genererebbe una email identica ogni giorno (anche dopo la scadenza, per
 * sempre, dato che la query non ha un limite inferiore sui giorni). Stessa
 * logica isNew/escalated/critical-sempre di expiryHelper.upsertNotification,
 * applicata qui a livello (studio_id, company_id) invece che per entità.
 * Ritorna true se questo cliente va incluso nell'email di oggi.
 */
async function shouldAlertStudioDurc(studioId, companyId, severity) {
  const { data: existing } = await supabase
    .from('studio_durc_alert_log')
    .select('severity')
    .eq('studio_id', studioId)
    .eq('company_id', companyId)
    .maybeSingle();

  const isNew     = !existing;
  const escalated = !isNew && (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[existing.severity] ?? 0);
  const alert     = severity === 'critical' || isNew || escalated;

  if (alert) {
    await supabase.from('studio_durc_alert_log')
      .upsert({ studio_id: studioId, company_id: companyId, severity, notified_at: new Date().toISOString() },
              { onConflict: 'studio_id,company_id' });
  }
  return alert;
}

/** Rimuove il tracking per i clienti che sono usciti dalla finestra di rischio (DURC rinnovato o rapporto cessato). */
async function pruneStudioDurcAlerts(studioId, activeCompanyIds) {
  const { data: existing } = await supabase
    .from('studio_durc_alert_log')
    .select('id, company_id')
    .eq('studio_id', studioId);

  const stale = (existing || []).filter(r => !activeCompanyIds.has(r.company_id));
  if (stale.length) {
    await supabase.from('studio_durc_alert_log').delete().in('id', stale.map(r => r.id));
  }
}

async function runStudioDurcAlertCheck() {
  console.log('[studioDurcAlert] avvio controllo DURC clienti studio...');

  const t30 = inDays(30);

  const { data: clients, error } = await supabase
    .from('studio_clients')
    .select(`
      studio_id,
      company_id,
      studio_partners(id, studio_name, user_id),
      companies(id, name, durc_expiry_date)
    `)
    .eq('status', 'active')
    .not('companies.durc_expiry_date', 'is', null)
    .lte('companies.durc_expiry_date', t30);

  if (error) { console.error('[studioDurcAlert] fetch error:', error.message); return; }

  // Raggruppa per studio
  const byStudio = {};
  const allActiveByStudio = {}; // per il prune: TUTTI i clienti nella finestra, non solo quelli da alertare oggi
  for (const c of (clients || [])) {
    const days = daysUntil(c.companies?.durc_expiry_date);
    if (days === null || days > 30) continue;
    const studio  = c.studio_partners;
    if (!studio) continue;
    if (!byStudio[c.studio_id]) {
      byStudio[c.studio_id] = { studio, companies: [] };
      allActiveByStudio[c.studio_id] = new Set();
    }
    allActiveByStudio[c.studio_id].add(c.company_id);
    byStudio[c.studio_id].companies.push({
      name:       c.companies?.name || 'Impresa',
      expiryDate: c.companies?.durc_expiry_date,
      days,
      companyId:  c.company_id,
      severity:   severityFor(days),
    });
  }

  // F-087 (parte 2): il prune deve girare per OGNI studio che ha ancora righe
  // di tracking, non solo per quelli con clienti a rischio OGGI — altrimenti
  // un cliente che esce del tutto dalla finestra (DURC rinnovato) sparisce
  // dalla query sopra e la sua riga di dedup resta orfana per sempre.
  const { data: trackedStudios } = await supabase.from('studio_durc_alert_log').select('studio_id');
  const allStudioIds = new Set([...(trackedStudios || []).map(r => r.studio_id), ...Object.keys(byStudio)]);
  for (const studioId of allStudioIds) {
    await pruneStudioDurcAlerts(studioId, allActiveByStudio[studioId] || new Set());
  }

  if (!Object.keys(byStudio).length) { console.log('[studioDurcAlert] nessun DURC in scadenza — skip.'); return; }

  const appUrl = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

  for (const [studioId, info] of Object.entries(byStudio)) {
    try {
      // F-087: filtra ai soli clienti con qualcosa di NUOVO da segnalare oggi
      // (prima volta, peggiorata, o critica — stessa regola degli altri cron).
      const toAlert = [];
      for (const comp of info.companies) {
        if (await shouldAlertStudioDurc(studioId, comp.companyId, comp.severity)) toAlert.push(comp);
      }
      if (!toAlert.length) {
        console.log(`[studioDurcAlert] studio ${studioId}: nessuna novità — skip (dedup F-087).`);
        continue;
      }

      // Email dallo studio owner (via auth admin)
      const { data: { user } } = await supabase.auth.admin.getUserById(info.studio.user_id);
      const email = user?.email;
      if (!email) { console.warn(`[studioDurcAlert] no email for studio ${studioId}`); continue; }

      await sendStudioDurcAlert({
        to:           email,
        studioName:   info.studio.studio_name,
        companies:    toAlert,
        dashboardUrl: `${appUrl}/studio`,
      });
      console.log(`[studioDurcAlert] studio ${studioId}: alert inviato (${toAlert.length}/${info.companies.length} clienti)`);
    } catch (e) {
      console.error(`[studioDurcAlert] errore studio ${studioId}:`, e.message);
    }
  }

  console.log('[studioDurcAlert] completato.');
}

function startStudioDurcAlertCron() {
  cron.schedule('45 7 * * *', async () => {
    try { await runStudioDurcAlertCheck(); }
    catch (e) { console.error('[studioDurcAlert] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] studio-durc-alert attivo — 07:45 Europe/Rome');
}

module.exports = { startStudioDurcAlertCron, runStudioDurcAlertCheck, shouldAlertStudioDurc, pruneStudioDurcAlerts };
