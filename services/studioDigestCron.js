'use strict';
/**
 * services/studioDigestCron.js
 *
 * Ogni lunedì alle 08:00 (Europe/Rome):
 *   1. Per ogni studio CDL attivo, calcola il semaforo aggregato di tutti i clienti
 *   2. Invia il digest settimanale all'owner dello studio
 *   3. Per ogni impresa cliente con problemi, invia un alert all'impresa stessa
 *
 * L'email all'impresa è firmata "dal tuo studio CDL tramite Palladia" — questo è
 * il meccanismo che rende il CDL indispensabile: è lui la fonte della segnalazione.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  sendStudioWeeklyDigest,
  sendStudioExpiryAlertToCompany,
} = require('./email');

async function runStudioDigest() {
  console.log('[studioDigest] avvio elaborazione settimanale');

  // Tutti gli studi con onboarding completato
  const { data: studios, error: sErr } = await supabase
    .from('studio_partners')
    .select('id, studio_name, user_id')
    .eq('onboarding_completed', true);

  if (sErr || !studios?.length) {
    console.log('[studioDigest] nessuno studio trovato');
    return;
  }

  const now        = new Date();
  const in30       = new Date(now.getTime() + 30 * 86_400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);

  for (const studio of studios) {
    try {
      await processStudio(studio, now, in30, oneYearAgo);
    } catch (err) {
      console.error(`[studioDigest] errore studio ${studio.id}:`, err.message);
    }
  }

  console.log('[studioDigest] elaborazione completata');
}

async function processStudio(studio, now, in30, oneYearAgo) {
  // Clienti attivi di questo studio
  const { data: clients } = await supabase
    .from('studio_clients')
    .select('company_id, companies(id, name)')
    .eq('studio_id', studio.id)
    .eq('status', 'active');

  if (!clients?.length) return;

  const companyIds = clients.map(c => c.company_id);

  // Fetch parallelo di tutti i dati di conformità
  const todayStr = now.toISOString().slice(0, 10);
  const in30Str  = in30.toISOString().slice(0, 10);

  const [
    { data: sites },
    { data: workers },
    { data: dvrs },
    { data: certExpired },
    { data: certSoon },
    { data: subDocs },
    { data: ssorvExpired },
    { data: ssorvSoon },
    { data: compData },
    { data: safetyRoles },
  ] = await Promise.all([
    supabase.from('sites').select('id, company_id').in('company_id', companyIds).neq('status', 'chiuso'),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true),
    supabase.from('dvr_documents').select('id, company_id, created_at').in('company_id', companyIds).order('created_at', { ascending: false }),
    supabase.from('worker_certificates').select('id, company_id, expiry_date, course_types(name)').in('company_id', companyIds).lt('expiry_date', todayStr),
    supabase.from('worker_certificates').select('id, company_id, expiry_date, course_types(name)').in('company_id', companyIds)
      .gte('expiry_date', todayStr).lt('expiry_date', in30Str),
    supabase.from('subcontractor_documents').select('id, company_id, valid_until').in('company_id', companyIds),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true)
      .not('health_fitness_expiry', 'is', null).lt('health_fitness_expiry', todayStr),
    supabase.from('workers').select('id, company_id').in('company_id', companyIds).eq('is_active', true)
      .not('health_fitness_expiry', 'is', null).gte('health_fitness_expiry', todayStr).lt('health_fitness_expiry', in30Str),
    supabase.from('companies').select('id, durc_expiry_date, last_safety_meeting_at').in('id', companyIds),
    supabase.from('company_safety_roles').select('company_id, role_type').in('company_id', companyIds),
  ]);

  // Metriche per impresa
  const metrics = {};
  for (const c of clients) {
    metrics[c.company_id] = {
      company_id:   c.company_id,
      company_name: c.companies.name,
      workers:      0,
      dvr_presente: false,
      dvr_data:     null,
      alerts:       [],
    };
  }

  for (const w of workers || []) if (metrics[w.company_id]) metrics[w.company_id].workers++;

  const latestDvr = {};
  for (const d of dvrs || []) if (!latestDvr[d.company_id]) latestDvr[d.company_id] = d;
  for (const [cid, dvr] of Object.entries(latestDvr)) {
    if (!metrics[cid]) continue;
    metrics[cid].dvr_presente = true;
    metrics[cid].dvr_data     = dvr.created_at;
    if (new Date(dvr.created_at) < oneYearAgo) {
      metrics[cid].alerts.push({ type: 'dvr_old', message: 'DVR non aggiornato da oltre 12 mesi', severity: 'warning' });
    }
  }

  for (const c of certExpired || []) {
    if (!metrics[c.company_id]) continue;
    const courseName = c.course_types?.name || 'Attestato';
    metrics[c.company_id].alerts.push({ type: 'cert_expired', message: `${courseName} scaduto`, severity: 'critical' });
  }
  for (const c of certSoon || []) {
    if (!metrics[c.company_id]) continue;
    const courseName = c.course_types?.name || 'Attestato';
    metrics[c.company_id].alerts.push({ type: 'cert_expiring', message: `${courseName} in scadenza entro 30 giorni`, severity: 'warning' });
  }
  for (const d of subDocs || []) {
    if (!metrics[d.company_id] || !d.valid_until) continue;
    const vDate = new Date(d.valid_until);
    if (vDate < now) {
      metrics[d.company_id].alerts.push({ type: 'sub_doc_expired', message: 'Documento subappaltatore scaduto', severity: 'critical' });
    } else if (vDate < in30) {
      metrics[d.company_id].alerts.push({ type: 'sub_doc_expiring', message: 'Documento subappaltatore in scadenza', severity: 'warning' });
    }
  }

  // ── Sorveglianza sanitaria ─────────────────────────────────────────────────
  for (const w of ssorvExpired || []) {
    if (!metrics[w.company_id]) continue;
    metrics[w.company_id].alerts.push({ type: 'sorv_expired', message: 'Idoneità medica scaduta', severity: 'critical' });
  }
  for (const w of ssorvSoon || []) {
    if (!metrics[w.company_id]) continue;
    metrics[w.company_id].alerts.push({ type: 'sorv_expiring', message: 'Idoneità medica in scadenza (30 gg)', severity: 'warning' });
  }

  // ── DURC e riunione periodica ──────────────────────────────────────────────
  for (const co of compData || []) {
    if (!metrics[co.id]) continue;
    if (co.durc_expiry_date) {
      if (co.durc_expiry_date < todayStr) {
        metrics[co.id].alerts.push({ type: 'durc_expired',  message: 'DURC scaduto', severity: 'critical' });
      } else if (co.durc_expiry_date < in30Str) {
        metrics[co.id].alerts.push({ type: 'durc_expiring', message: 'DURC in scadenza (30 gg)', severity: 'warning' });
      }
    }
    if (co.last_safety_meeting_at) {
      const nextDue = new Date(new Date(co.last_safety_meeting_at).getTime() + 365 * 86_400_000);
      if (nextDue < now) {
        metrics[co.id].alerts.push({ type: 'riunione_scaduta', message: 'Riunione periodica art.35 da rinnovare', severity: 'warning' });
      }
    }
  }

  // ── RSPP non nominato ──────────────────────────────────────────────────────
  const rolesByCompany = {};
  for (const r of safetyRoles || []) {
    if (!rolesByCompany[r.company_id]) rolesByCompany[r.company_id] = new Set();
    rolesByCompany[r.company_id].add(r.role_type);
  }

  for (const m of Object.values(metrics)) {
    if (!m.dvr_presente && m.workers > 0) {
      m.alerts.push({ type: 'dvr_missing', message: 'DVR assente — obbligatorio per legge (D.Lgs 81/2008)', severity: 'critical' });
    }
    if (m.workers > 0 && !rolesByCompany[m.company_id]?.has('rspp')) {
      m.alerts.push({ type: 'rspp_mancante', message: 'RSPP non nominato', severity: 'warning' });
    }
    // Deduplica per tipo
    m.alerts = [...new Map(m.alerts.map(a => [a.type, a])).values()];
    m.semaforo = m.alerts.some(a => a.severity === 'critical') ? 'rosso'
               : m.alerts.some(a => a.severity === 'warning')  ? 'giallo'
               : 'verde';
  }

  const allIssues = Object.values(metrics)
    .flatMap(m => m.alerts.map(a => ({ ...a, company_id: m.company_id, company_name: m.company_name })))
    .sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));

  const summary = {
    total:  Object.keys(metrics).length,
    verde:  Object.values(metrics).filter(m => m.semaforo === 'verde').length,
    giallo: Object.values(metrics).filter(m => m.semaforo === 'giallo').length,
    rosso:  Object.values(metrics).filter(m => m.semaforo === 'rosso').length,
  };

  // ── Email all'owner dello studio ───────────────────────────────────────────
  const { data: { user: studioOwner } } = await supabase.auth.admin.getUserById(studio.user_id);
  if (studioOwner?.email) {
    await sendStudioWeeklyDigest({
      to:         studioOwner.email,
      studioName: studio.studio_name,
      summary,
      issues:     allIssues,
    }).catch(err => console.error(`[studioDigest] digest email errore per studio ${studio.id}:`, err.message));
  }

  // ── Email alle imprese con problemi ────────────────────────────────────────
  const problematicCompanies = Object.values(metrics).filter(m => m.alerts.length > 0);

  for (const company of problematicCompanies) {
    try {
      // Trova owner/admin dell'impresa
      const { data: members } = await supabase
        .from('company_users')
        .select('user_id')
        .eq('company_id', company.company_id)
        .in('role', ['owner', 'admin']);

      if (!members?.length) continue;

      for (const member of members.slice(0, 2)) { // max 2 destinatari per impresa
        const { data: { user: companyUser } } = await supabase.auth.admin.getUserById(member.user_id);
        if (!companyUser?.email) continue;

        await sendStudioExpiryAlertToCompany({
          to:          companyUser.email,
          companyName: company.company_name,
          studioName:  studio.studio_name,
          issues:      company.alerts,
        }).catch(err => console.error(`[studioDigest] company alert errore per ${company.company_id}:`, err.message));
      }
    } catch (err) {
      console.error(`[studioDigest] errore notifica impresa ${company.company_id}:`, err.message);
    }
  }
}

function startStudioDigestCron() {
  // Ogni lunedì alle 08:00 (Europe/Rome)
  cron.schedule('0 8 * * 1', () => {
    runStudioDigest().catch(err => console.error('[studioDigest] errore fatale:', err.message));
  }, { timezone: 'Europe/Rome' });

  console.log('[studioDigest] cron avviato — ogni lunedì 08:00 Europe/Rome');
}

module.exports = { startStudioDigestCron, runStudioDigest };
