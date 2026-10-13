'use strict';
/**
 * services/dailyDigestCron.js
 *
 * Cron giornaliero (07:30 Europe/Rome) — invia UNA sola email per company
 * che riassume TUTTI gli alert di conformità:
 *   1. Documenti obbligatori mancanti (visita medica, corso sicurezza)
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
const { statoLavoratori } = require('../lib/documentiStato');

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

const DASHBOARD_URL   = (process.env.FRONTEND_URL || 'https://palladia.net').replace(/\/$/, '') + '/risorse';
const PAGE = 1000;

// Legge tutte le righe, a pagine: il limite di default di PostgREST è 1000
async function allRows(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * F-351: le sezioni di un'azienda. I lavoratori usano lo stesso calcolo della
 * pagina /documenti (campi del lavoratore + tabella unica dei documenti +
 * attestati, rinnovi compresi): l'email non può dire altro da quello che il
 * titolare vede aprendo Palladia.
 */
async function sectionsFor(companyId, t30) {
  const [lavoratori, cdRes, eqRes] = await Promise.all([
    statoLavoratori(companyId),
    supabase
      .from('company_documents')
      .select('id, company_id, name, category, ai_expiry_date, ai_renewal_years')
      .eq('company_id', companyId)
      .not('ai_expiry_date', 'is', null),
    supabase
      .from('equipment')
      .select('id, company_id, type, model, plate_or_serial, insurance_expiry, inspection_date, maintenance_date')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .or(`insurance_expiry.lte.${t30},inspection_date.lte.${t30},maintenance_date.lte.${t30}`),
  ]);
  if (cdRes.error) throw new Error(`company_documents: ${cdRes.error.message}`);
  if (eqRes.error) throw new Error(`equipment: ${eqRes.error.message}`);

  // ── 1-2. Lavoratori: mancanti e in scadenza ───────────────────────────────
  const missingDocs = [];
  const workerExpiry = [];
  for (const w of lavoratori) {
    const missingTypes = w.requirements.filter(r => r.state === 'manca').map(r => r.label);
    if (missingTypes.length) missingDocs.push({ id: w.id, company_id: companyId, full_name: w.name, missingTypes });
    const inScadenza = [...w.requirements, ...w.documents].filter(x => x.state === 'scaduto' || x.state === 'in_scadenza');
    for (const x of inScadenza) {
      const days = daysUntil(x.expiry);
      if (days === null) continue;
      workerExpiry.push({
        worker_id: w.id, worker: { full_name: w.name },
        typeLabel: x.label, expiry_date: x.expiry, days, severity: severityFor(days),
      });
    }
  }
  workerExpiry.sort((a, b) => a.days - b.days);

  // ── 3. Documenti aziendali: per tipo conta il più recente (rinnovi) ───────
  const latest = new Map();
  for (const d of cdRes.data || []) {
    const key = d.category && d.category !== 'altro' ? d.category : `doc:${d.id}`;
    if (!latest.has(key) || d.ai_expiry_date > latest.get(key).ai_expiry_date) latest.set(key, d);
  }
  const companyExpiry = [];
  for (const doc of latest.values()) {
    if (doc.ai_expiry_date > t30) continue;
    const days = daysUntil(doc.ai_expiry_date);
    if (days === null) continue;
    companyExpiry.push({ ...doc, days, severity: severityFor(days), catLabel: CATEGORY_LABELS[doc.category] || doc.category });
  }

  // ── 4. Scadenze mezzi ─────────────────────────────────────────────────────
  const equipmentExpiry = [];
  for (const eq of eqRes.data || []) {
    const issues = [];
    for (const { key, label } of EQUIPMENT_FIELDS) {
      const days = daysUntil(eq[key]);
      if (days === null || days > 30) continue;
      issues.push({ key, label, date: eq[key], days, severity: severityFor(days) });
    }
    if (issues.length) equipmentExpiry.push({ ...eq, issues });
  }

  return { missingDocs, workerExpiry, companyExpiry, equipmentExpiry };
}

/** @param {{ companyIds?: string[] }} [opts] solo queste aziende (test) */
async function runDailyDigest(opts = {}) {
  console.log('[dailyDigest] avvio digest giornaliero...');
  const t30 = inDays(30);

  // Aziende con qualcosa da guardare. Un'azienda alla volta: niente .in() con
  // migliaia di id (F-351: Bad Request letto come "nessun documento").
  let companyIds = opts.companyIds;
  if (!companyIds) {
    const [workers, docs, equip] = await Promise.all([
      allRows(() => supabase.from('workers').select('company_id').eq('is_active', true).order('id')),
      allRows(() => supabase.from('company_documents').select('company_id').not('ai_expiry_date', 'is', null).lte('ai_expiry_date', t30).order('id')),
      allRows(() => supabase.from('equipment').select('company_id').eq('is_active', true)
        .or(`insurance_expiry.lte.${t30},inspection_date.lte.${t30},maintenance_date.lte.${t30}`).order('id')),
    ]);
    companyIds = [...new Set([...workers, ...docs, ...equip].map(r => r.company_id).filter(Boolean))];
  }

  for (const companyId of companyIds) {
    try {
      const sections = await sectionsFor(companyId, t30);
      const total = Object.values(sections).reduce((n, arr) => n + arr.length, 0);
      if (!total) continue;

      const [emails, companyName] = await Promise.all([
        getCompanyAdminEmails(companyId),
        getCompanyName(companyId),
      ]);
      if (!emails.length) continue;

      await sendDailyAlertDigest({ to: emails, companyName, dashboardUrl: DASHBOARD_URL, sections });

      console.log(`[dailyDigest] ${companyId} (${companyName}): email digest → ${emails.length} dest., problemi: missing=${sections.missingDocs.length}, expiry=${sections.workerExpiry.length}, compDoc=${sections.companyExpiry.length}, equip=${sections.equipmentExpiry.length}`);
    } catch (e) {
      // Mai un'email costruita su dati che non siamo riusciti a leggere
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

module.exports = { startDailyDigestCron, runDailyDigest, sectionsFor };
