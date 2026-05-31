'use strict';
/**
 * services/dailyDigestCron.js
 *
 * Cron giornaliero (07:30 Europe/Rome) — invia UNA sola email per company
 * che riassume TUTTI gli alert di conformità:
 *   1. Documenti obbligatori mancanti (idoneità medica, formazione sicurezza)
 *   2. Documenti lavoratori in scadenza (qualsiasi tipo entro 30gg)
 *   3. Documenti aziendali in scadenza (DURC, DVR, ecc.)
 *   4. Scadenze mezzi (assicurazione, revisione, tagliando)
 *
 * I singoli cron (workerMissingDocsCron, workerExpiryCron, ecc.) gestiscono
 * notifiche in-app e Telegram — questo cron gestisce solo l'email.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { daysUntil, inDays, severityFor, getCompanyName, getCompanyAdminEmails } = require('./expiryHelper');
const { sendDailyAlertDigest } = require('./email');

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

const CATEGORY_LABELS = {
  rspp: 'RSPP', rls: 'RLS', medico_competente: 'Medico Competente',
  visite_mediche: 'Visite Mediche', primo_soccorso: 'Primo Soccorso',
  emergenze: 'Piano Emergenze', preposto: 'Preposto', dvr: 'DVR', duvri: 'DUVRI',
  formazione: 'Formazione', durc: 'DURC', visura: 'Visura Camerale',
  iso: 'Certificazione ISO', soa: 'Attestazione SOA',
  assicurazione: 'Assicurazione', polizza: 'Polizza', f24: 'F24', altro: 'Documento',
};

const EQUIPMENT_FIELDS = [
  { key: 'insurance_expiry',  label: 'Assicurazione' },
  { key: 'inspection_date',   label: 'Revisione periodica' },
  { key: 'maintenance_date',  label: 'Tagliando / Manutenzione' },
];

const REQUIRED_TYPES  = ['idoneita_medica', 'formazione_sicurezza'];
const DASHBOARD_URL   = (process.env.FRONTEND_URL || 'https://palladia.net').replace(/\/$/, '') + '/risorse';

async function runDailyDigest() {
  console.log('[dailyDigest] avvio digest giornaliero...');

  const t30      = inDays(30);
  const todayStr = new Date().toISOString().split('T')[0];

  // ── Query parallele ────────────────────────────────────────────────────────
  const [wRes, wdRes, cdRes, eqRes] = await Promise.all([
    // 1. Tutti i lavoratori attivi
    supabase.from('workers').select('id, company_id, full_name').eq('is_active', true),

    // 2. Documenti lavoratori in scadenza entro 30gg
    supabase
      .from('worker_documents')
      .select('id, company_id, worker_id, doc_type, name, expiry_date, worker:workers(full_name, is_active)')
      .not('expiry_date', 'is', null)
      .lte('expiry_date', t30),

    // 3. Documenti aziendali in scadenza entro 30gg
    supabase
      .from('company_documents')
      .select('id, company_id, name, category, ai_expiry_date, ai_renewal_years')
      .not('ai_expiry_date', 'is', null)
      .lte('ai_expiry_date', t30),

    // 4. Mezzi con scadenze entro 30gg
    supabase
      .from('equipment')
      .select('id, company_id, type, model, plate_or_serial, insurance_expiry, inspection_date, maintenance_date')
      .eq('is_active', true)
      .or(`insurance_expiry.lte.${t30},inspection_date.lte.${t30},maintenance_date.lte.${t30}`),
  ]);

  if (wRes.error)  { console.error('[dailyDigest] workers error:', wRes.error.message); }
  if (wdRes.error) { console.error('[dailyDigest] worker_docs error:', wdRes.error.message); }
  if (cdRes.error) { console.error('[dailyDigest] company_docs error:', cdRes.error.message); }
  if (eqRes.error) { console.error('[dailyDigest] equipment error:', eqRes.error.message); }

  const workers     = wRes.data  || [];
  const workerDocs  = wdRes.data || [];
  const companyDocs = cdRes.data || [];
  const equipment   = eqRes.data || [];

  // ── 1. Documenti obbligatori mancanti ─────────────────────────────────────
  const workerIds = workers.map(w => w.id);
  let existingReqDocs = [];
  if (workerIds.length) {
    const { data } = await supabase
      .from('worker_documents')
      .select('worker_id, doc_type')
      .in('worker_id', workerIds)
      .in('doc_type', REQUIRED_TYPES)
      .or(`expiry_date.is.null,expiry_date.gte.${todayStr}`);
    existingReqDocs = data || [];
  }

  const workerDocTypes = new Map();
  for (const d of existingReqDocs) {
    if (!workerDocTypes.has(d.worker_id)) workerDocTypes.set(d.worker_id, new Set());
    workerDocTypes.get(d.worker_id).add(d.doc_type);
  }

  const missingByWorker = workers.reduce((acc, w) => {
    const present      = workerDocTypes.get(w.id) || new Set();
    const missingTypes = REQUIRED_TYPES.filter(t => !present.has(t)).map(t => DOC_TYPE_LABELS[t] || t);
    if (missingTypes.length) {
      if (!acc[w.company_id]) acc[w.company_id] = [];
      acc[w.company_id].push({ ...w, missingTypes });
    }
    return acc;
  }, {});

  // ── 2. Documenti lavoratori in scadenza ───────────────────────────────────
  // Dedup per (worker_id, doc_type): tieni solo il doc con expiry massima.
  // Evita che un doc vecchio scaduto generi alert quando esiste un rinnovo valido.
  const latestByKey = new Map();
  for (const d of workerDocs) {
    if (!d.worker?.is_active) continue;
    const key = `${d.worker_id}:${d.doc_type}`;
    if (!latestByKey.has(key) || d.expiry_date > latestByKey.get(key).expiry_date) {
      latestByKey.set(key, d);
    }
  }
  const expiryByCompany = {};
  for (const d of latestByKey.values()) {
    if (d.expiry_date > t30) continue; // il rinnovo è valido oltre 30gg — non segnalare
    const days     = daysUntil(d.expiry_date);
    if (days === null) continue;
    const severity = severityFor(days);
    if (!expiryByCompany[d.company_id]) expiryByCompany[d.company_id] = [];
    expiryByCompany[d.company_id].push({
      ...d,
      days,
      severity,
      typeLabel: DOC_TYPE_LABELS[d.doc_type] || d.doc_type,
    });
  }

  // ── 3. Documenti aziendali in scadenza ────────────────────────────────────
  const companyDocByCompany = {};
  for (const doc of companyDocs) {
    const days = daysUntil(doc.ai_expiry_date);
    if (days === null) continue;
    if (!companyDocByCompany[doc.company_id]) companyDocByCompany[doc.company_id] = [];
    companyDocByCompany[doc.company_id].push({
      ...doc,
      days,
      severity: severityFor(days),
      catLabel: CATEGORY_LABELS[doc.category] || doc.category,
    });
  }

  // ── 4. Scadenze mezzi ─────────────────────────────────────────────────────
  const equipByCompany = {};
  for (const eq of equipment) {
    const issues = [];
    for (const { key, label } of EQUIPMENT_FIELDS) {
      const days = daysUntil(eq[key]);
      if (days === null || days > 30) continue;
      issues.push({ key, label, date: eq[key], days, severity: severityFor(days) });
    }
    if (!issues.length) continue;
    if (!equipByCompany[eq.company_id]) equipByCompany[eq.company_id] = [];
    equipByCompany[eq.company_id].push({ ...eq, issues });
  }

  // ── Raccoglie tutti i company_id con almeno un problema ──────────────────
  const allCompanyIds = new Set([
    ...Object.keys(missingByWorker),
    ...Object.keys(expiryByCompany),
    ...Object.keys(companyDocByCompany),
    ...Object.keys(equipByCompany),
  ]);

  if (!allCompanyIds.size) {
    console.log('[dailyDigest] nessun problema da segnalare — nessuna email inviata.');
    return;
  }

  // ── Invia un'email per company ────────────────────────────────────────────
  for (const companyId of allCompanyIds) {
    try {
      const sections = {
        missingDocs:    missingByWorker[companyId]    || [],
        workerExpiry:   expiryByCompany[companyId]    || [],
        companyExpiry:  companyDocByCompany[companyId] || [],
        equipmentExpiry: equipByCompany[companyId]    || [],
      };

      // Salta se non c'è nulla di reale
      const total = Object.values(sections).reduce((n, arr) => n + arr.length, 0);
      if (!total) continue;

      const [emails, companyName] = await Promise.all([
        getCompanyAdminEmails(companyId),
        getCompanyName(companyId),
      ]);
      if (!emails.length) continue;

      await sendDailyAlertDigest({
        to: emails,
        companyName,
        dashboardUrl: DASHBOARD_URL,
        sections,
      });

      console.log(`[dailyDigest] ${companyId} (${companyName}): email digest → ${emails.length} dest., problemi: missing=${sections.missingDocs.length}, expiry=${sections.workerExpiry.length}, compDoc=${sections.companyExpiry.length}, equip=${sections.equipmentExpiry.length}`);
    } catch (e) {
      console.error(`[dailyDigest] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[dailyDigest] completato.');
}

function startDailyDigestCron() {
  // Gira dopo tutti gli altri cron (07:05–07:15) per avere notifiche in-app aggiornate
  cron.schedule('30 7 * * *', async () => {
    try { await runDailyDigest(); }
    catch (e) { console.error('[dailyDigest] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] daily-digest attivo — 07:30 Europe/Rome');
}

module.exports = { startDailyDigestCron, runDailyDigest };
