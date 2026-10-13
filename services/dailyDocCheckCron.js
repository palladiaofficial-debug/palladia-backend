'use strict';
/**
 * services/dailyDocCheckCron.js
 *
 * Cron giornaliero (07:05 Europe/Rome) — unico messaggio Telegram per company
 * che combina documenti obbligatori mancanti + scadenze imminenti/scadute.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { problemiLavoratori } = require('../lib/documentiStato');
const { allRows } = require('../lib/allRows');
const {
  daysUntil,
  severityFor, severityLabel,
  upsertNotification, shouldSendTelegram, pruneNotifications,
} = require('./expiryHelper');
const {
  notifyExpiryAlert, notifyResolved, notifyCompany,
} = require('./telegramNotifications');
const { queueOrSend } = require('../lib/alertDigest');
const { sendPushToCompany } = require('./pushNotifications');

const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

function buildUnifiedMessage(missing, expiring) {
  const lines = [];

  if (missing.length) {
    lines.push('🚨 <b>Mancanti</b>');
    for (const w of missing) {
      lines.push(`🔴 ${w.name} — ${w.missing.map(x => x.label).join(', ')}`);
    }
  }

  if (expiring.length) {
    if (lines.length) lines.push('');
    lines.push('⚠️ <b>In scadenza / scaduti</b>');
    for (const d of expiring) {
      const icon  = d.severity === 'critical' ? '🔴' : '🟡';
      const when  = d.days < 0
        ? `scaduto ${Math.abs(d.days)}gg fa`
        : `scade in ${d.days}gg`;
      lines.push(`${icon} ${d.name} — ${d.label} · ${when}`);
    }
  }

  return (
    `📋 <b>PALLADIA — Documenti lavoratori</b>\n\n` +
    lines.join('\n') +
    `\n\n→ <a href="${FRONTEND_URL}/risorse">Gestisci i documenti</a>`
  );
}

/** Aziende con almeno un lavoratore attivo, a pagine (F-353: niente tetto a 1000). */
async function companiesWithWorkers() {
  const rows = await allRows(() => supabase.from('workers').select('company_id').eq('is_active', true).order('id'), 'workers');
  return [...new Set(rows.map(r => r.company_id))];
}

/** Chiave della notifica di scadenza: il documento vecchio (snooze di Da fare) o il lavoratore+requisito. */
function expiryEntityId(x) {
  const d = x.doc && x.doc.expiry === x.expiry ? x.doc : null;
  if (d && d.source === 'worker_documents' && d.legacyId) return String(d.legacyId);
  if (d) return d.id;
  return `${x.workerId}:${x.key}`; // requisito che vale solo per il campo della scheda
}

/**
 * F-353: un'azienda alla volta, con lo stesso stato di /documenti
 * (lib/documentiStato.js). Se una lettura fallisce l'azienda viene saltata
 * senza scrivere né mandare nulla: mai un avviso costruito su dati mancanti.
 */
async function checkCompany(companyId) {
  const { mancanti, scadenze } = await problemiLavoratori(companyId);

  // ── In-app: documenti mancanti ────────────────────────────
  const missingIds = new Set();
  for (const w of mancanti) {
    await upsertNotification({
      companyId,
      type:       'worker_doc_missing',
      severity:   'critical',
      title:      `${w.name} — ${w.missing.map(x => x.label).join(', ')}`,
      body:       'Documenti obbligatori mancanti',
      entityType: 'worker',
      entityId:   w.workerId,
    });
    missingIds.add(w.workerId);
  }
  const { resolved: resolvedMissing } = await pruneNotifications(
    companyId, 'worker_doc_missing', 'worker', missingIds
  );

  // ── In-app: scadenze ──────────────────────────────────────
  const expiryIds      = new Set();
  const telegramExpiry = [];
  for (const x of scadenze) {
    const days = daysUntil(x.expiry);
    if (days === null) continue;
    const severity = severityFor(days);
    const entityId = expiryEntityId(x);
    if (expiryIds.has(entityId)) continue; // stesso documento già avvisato
    const { isNew, escalated } = await upsertNotification({
      companyId,
      type:       'worker_doc_expiry',
      severity,
      title:      `${x.name} — ${x.label}`,
      body:       severityLabel(days),
      entityType: 'worker_document',
      entityId,
    });
    expiryIds.add(entityId);
    if (shouldSendTelegram(severity, { isNew, escalated })) telegramExpiry.push({ ...x, days, severity });
  }
  const { resolved: resolvedExpiry } = await pruneNotifications(
    companyId, 'worker_doc_expiry', 'worker_document', expiryIds
  );

  // ── Telegram: un unico messaggio combinato ────────────────
  // Missing → sempre inviato (critical ogni giorno)
  // Expiry  → solo quelli che shouldSendTelegram ha approvato
  if (mancanti.length || telegramExpiry.length) {
    const msg = buildUnifiedMessage(mancanti, telegramExpiry);
    await notifyExpiryAlert(companyId, msg).catch(() => {});
  }

  // Risolti: un solo messaggio aggregato
  const resolvedAll = [...(resolvedMissing || []), ...(resolvedExpiry || [])];
  if (resolvedAll.length) {
    await notifyResolved(companyId, resolvedAll, 'Documenti aggiornati').catch(() => {});
  }
  return { mancanti: mancanti.length, scadenzeTelegram: telegramExpiry.length, risolti: resolvedAll.length };
}

/** @param {{ companyIds?: string[] }} [opts] solo queste aziende (test) */
async function runDailyDocCheck(opts = {}) {
  console.log('[dailyDocCheck] avvio controllo unificato documenti lavoratori...');
  const companyIds = opts.companyIds || await companiesWithWorkers();
  for (const companyId of companyIds) {
    try {
      const r = await checkCompany(companyId);
      if (r.mancanti || r.scadenzeTelegram || r.risolti) {
        console.log(`[dailyDocCheck] ${companyId}: mancanti=${r.mancanti}, scadenze TG=${r.scadenzeTelegram}, risolti=${r.risolti}`);
      }
    } catch (e) {
      console.error(`[dailyDocCheck] errore company ${companyId}:`, e.message);
    }
  }
  console.log('[dailyDocCheck] completato.');
}

async function runBirthdayCheck() {
  const today = new Date();
  const mm    = today.getMonth() + 1;
  const dd    = today.getDate();

  const { data: workers, error } = await supabase
    .from('workers')
    .select('id, company_id, full_name, birth_date')
    .eq('is_active', true)
    .not('birth_date', 'is', null);

  if (error) { console.error('[birthday] fetch workers:', error.message); return; }
  if (!workers?.length) return;

  const todayWorkers = workers.filter(w => {
    const parts = w.birth_date.split('-').map(Number);
    return parts[1] === mm && parts[2] === dd;
  });

  if (!todayWorkers.length) { console.log('[birthday] nessun compleanno oggi.'); return; }

  const byCompany = new Map();
  for (const w of todayWorkers) {
    if (!byCompany.has(w.company_id)) byCompany.set(w.company_id, []);
    byCompany.get(w.company_id).push(w);
  }

  for (const [companyId, bWorkers] of byCompany) {
    const names  = bWorkers.map(w => w.full_name).join(', ');
    const single = bWorkers.length === 1;

    const push = {
      title: single
        ? `🎂 Compleanno di ${bWorkers[0].full_name}`
        : `🎂 ${bWorkers.length} compleanni oggi`,
      body: single
        ? `Oggi è il compleanno di ${bWorkers[0].full_name} — un augurio fa sempre piacere!`
        : `Compleanni oggi: ${names}`,
      tag: 'birthday',
      url: '/persone',
    };

    const tgMsg = [
      `🎂 <b>Compleanno${single ? '' : 'i'} di oggi</b>`,
      '',
      ...bWorkers.map(w => `🎉 ${w.full_name}`),
      '',
      'Un augurio fa sempre piacere! 🎉',
    ].join('\n');

    // F-240: col riepilogo delle 7:30 acceso il compleanno entra lì. Prima
    // passava da notifyExpiryAlert, che aggiungeva per sbaglio anche una
    // notifica "Documenti in scadenza": ora parte solo quella del compleanno.
    await queueOrSend(companyId, { kind: 'birthday', telegramText: tgMsg, push }, () => Promise.all([
      sendPushToCompany(companyId, push).catch(() => {}),
      notifyCompany(companyId, tgMsg).catch(() => {}),
    ])).catch(() => {});

    console.log(`[birthday] ${companyId}: ${names}`);
  }
}

function startDailyDocCheckCron() {
  cron.schedule('5 7 * * *', async () => {
    try { await Promise.all([runDailyDocCheck(), runBirthdayCheck()]); }
    catch (e) { console.error('[dailyDocCheck] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] daily-doc-check attivo — 07:05 Europe/Rome');
}

module.exports = { startDailyDocCheckCron, runDailyDocCheck, runBirthdayCheck };
