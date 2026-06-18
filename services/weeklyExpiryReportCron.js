'use strict';
/**
 * services/weeklyExpiryReportCron.js
 *
 * Ogni lunedì alle 08:00 (Europe/Rome):
 * - Aggrega tutte le scadenze critiche (≤7 gg o già scadute) e warning (8-30 gg) per ogni company
 * - Invia email di riepilogo a tutti gli owner/admin
 * - Invia messaggio Telegram di sintesi agli utenti collegati
 *
 * Logica identica all'endpoint /api/v1/expiry-calendar ma eseguita server-side, su tutte le company.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const tg       = require('./telegram');
const { sendWeeklyExpiryReport } = require('./email');
const { filterUserIdsByChannel, getPrefsMap, isChannelEnabled } = require('../lib/notificationPrefs');

const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

function daysFrom(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date().setHours(0, 0, 0, 0)) / 86400000);
}

function fmtDate(d) { return d ? String(d).slice(0, 10) : null; }

// ── Aggregazione scadenze per una company ─────────────────────────────────────

async function buildExpiryEvents(companyId) {
  const from30  = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to30    = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const [workersRes, subsRes, companyRes, sitesRes, salRes] = await Promise.all([
    supabase.from('workers')
      .select('id, full_name, safety_training_expiry, health_fitness_expiry')
      .eq('company_id', companyId).eq('is_active', true),

    supabase.from('subcontractors')
      .select('id, company_name, durc_expiry, insurance_expiry, soa_expiry')
      .eq('company_id', companyId),

    supabase.from('companies')
      .select('id, name, durc_expiry')
      .eq('id', companyId).maybeSingle(),

    supabase.from('sites')
      .select('id, name, suolo_occupazione_end, end_date, suolo_occupazione')
      .eq('company_id', companyId).neq('status', 'eliminato'),

    supabase.from('site_sal_history')
      .select('id, sal_number, importo_maturato, data_pagamento_prevista, sites(name)')
      .eq('company_id', companyId)
      .is('pagato_il', null)
      .not('data_pagamento_prevista', 'is', null),
  ]);

  const events = [];

  const push = (dateStr, label) => {
    const d = fmtDate(dateStr);
    if (!d || d < from30 || d > to30) return;
    const days = daysFrom(d);
    if (days === null) return;
    const sev = days < 0 || days <= 7 ? 'critical' : days <= 30 ? 'warning' : null;
    if (sev) events.push({ label, date: d, days, severity: sev });
  };

  for (const w of (workersRes.data || [])) {
    if (w.safety_training_expiry) push(w.safety_training_expiry, `Formazione — ${w.full_name}`);
    if (w.health_fitness_expiry)  push(w.health_fitness_expiry,  `Idoneità — ${w.full_name}`);
  }
  for (const s of (subsRes.data || [])) {
    if (s.durc_expiry)      push(s.durc_expiry,      `DURC — ${s.company_name}`);
    if (s.insurance_expiry) push(s.insurance_expiry, `Assicurazione — ${s.company_name}`);
    if (s.soa_expiry)       push(s.soa_expiry,       `SOA — ${s.company_name}`);
  }
  if (companyRes.data?.durc_expiry) {
    push(companyRes.data.durc_expiry, `DURC aziendale — ${companyRes.data.name}`);
  }
  for (const s of (sitesRes.data || [])) {
    if (s.suolo_occupazione && s.suolo_occupazione_end)
      push(s.suolo_occupazione_end, `Suolo pubblico — ${s.name}`);
  }
  for (const sal of (salRes.data || [])) {
    const siteName = sal.sites?.name || 'Cantiere';
    const imp = sal.importo_maturato != null
      ? ` (€ ${Number(sal.importo_maturato).toLocaleString('it-IT', { maximumFractionDigits: 0 })})`
      : '';
    push(sal.data_pagamento_prevista, `Incasso SAL N.${sal.sal_number}${imp} — ${siteName}`);
  }

  events.sort((a, b) => a.date.localeCompare(b.date));
  return {
    companyName: companyRes.data?.name || companyId,
    critical: events.filter(e => e.severity === 'critical'),
    warning:  events.filter(e => e.severity === 'warning'),
  };
}

// ── Job principale ────────────────────────────────────────────────────────────

async function runWeeklyExpiryReport() {
  console.log('[weeklyExpiryReport] avvio');

  // Tutte le company con almeno un utente owner/admin
  const { data: companyUsers, error } = await supabase
    .from('company_users')
    .select('company_id, user_id, role')
    .in('role', ['owner', 'admin'])
    .limit(2000);

  if (error) {
    console.error('[weeklyExpiryReport] fetch company_users error:', error.message);
    return;
  }

  // Raggruppa: company → [{userId, role}]
  const byCompany = new Map();
  for (const cu of (companyUsers || [])) {
    if (!byCompany.has(cu.company_id)) byCompany.set(cu.company_id, []);
    byCompany.get(cu.company_id).push(cu.user_id);
  }

  let sentEmail = 0, sentTg = 0;

  for (const [companyId, userIds] of byCompany) {
    try {
      const { critical, warning, companyName } = await buildExpiryEvents(companyId);
      if (!critical.length && !warning.length) continue;

      // ── Email agli owner/admin (rispetta preferenze) ──
      const enabledEmailUserIds = await filterUserIdsByChannel(companyId, userIds, 'email');

      if (enabledEmailUserIds.length) {
        const { data: emails } = await supabase
          .from('auth_users_view')
          .select('email')
          .in('id', enabledEmailUserIds)
          .limit(10);

        for (const { email } of (emails || []).filter(u => u.email)) {
          try {
            await sendWeeklyExpiryReport({ to: email, companyName, critical, warning });
            sentEmail++;
          } catch (e) {
            console.error(`[weeklyExpiryReport] email error (${email}):`, e.message);
          }
        }
      }

      // ── Telegram (rispetta preferenze) ──
      const { data: tgUsers } = await supabase
        .from('telegram_users')
        .select('telegram_chat_id, user_id')
        .eq('company_id', companyId);

      if (tgUsers?.length) {
        const prefsMap = await getPrefsMap(companyId);
        const enabledTgUsers = tgUsers.filter(u => isChannelEnabled(prefsMap, u.user_id, 'telegram'));

        if (enabledTgUsers.length) {
          const total = critical.length + warning.length;
          const critLines = critical.slice(0, 5).map(e =>
            `🔴 ${e.label} — ${e.days <= 0 ? 'SCADUTA' : `${e.days}gg`}`
          );
          const warnLines = warning.slice(0, 3).map(e =>
            `🟡 ${e.label} — ${e.days}gg`
          );

          let msg = `📅 <b>Scadenze della settimana — ${companyName}</b>\n`;
          if (critLines.length) msg += `\n${critLines.join('\n')}`;
          if (warnLines.length) msg += `\n${warnLines.join('\n')}`;
          if (total > critLines.length + warnLines.length) {
            msg += `\n<i>...e altre ${total - critLines.length - warnLines.length} scadenze</i>`;
          }
          msg += `\n\n→ <a href="${FRONTEND_URL}/scadenze">Apri lo scadenzario</a>`;

          await Promise.allSettled(
            enabledTgUsers.map(u => tg.sendMessage(u.telegram_chat_id, msg).catch(() => {}))
          );
          sentTg++;
        }
      }

    } catch (e) {
      console.error(`[weeklyExpiryReport] errore company ${companyId}:`, e.message);
    }
  }

  console.log(`[weeklyExpiryReport] completato — email: ${sentEmail}, telegram: ${sentTg} company`);
}

// ── Registra il cron ──────────────────────────────────────────────────────────

function startWeeklyExpiryReportCron() {
  // Ogni lunedì alle 08:00 Europe/Rome
  cron.schedule('0 8 * * 1', runWeeklyExpiryReport, { timezone: 'Europe/Rome' });
  console.log('[cron] weekly-expiry-report attivo — ogni lunedì 08:00 Europe/Rome');
}

module.exports = { startWeeklyExpiryReportCron, runWeeklyExpiryReport };
