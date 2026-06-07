'use strict';
/**
 * services/dailyDocCheckCron.js
 *
 * Cron giornaliero (07:05 Europe/Rome) — unico messaggio Telegram per company
 * che combina documenti obbligatori mancanti + scadenze imminenti/scadute.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, inDays,
  severityFor, severityLabel,
  upsertNotification, shouldSendTelegram, pruneNotifications,
} = require('./expiryHelper');
const {
  notifyExpiryAlert, notifyResolved,
} = require('./telegramNotifications');

const REQUIRED_TYPES = ['idoneita_medica', 'formazione_sicurezza'];

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

const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

function buildUnifiedMessage(missing, expiring) {
  const lines = [];

  if (missing.length) {
    lines.push('🚨 <b>Mancanti</b>');
    for (const w of missing) {
      lines.push(`🔴 ${w.full_name} — ${w.missingTypes.join(', ')}`);
    }
  }

  if (expiring.length) {
    if (lines.length) lines.push('');
    lines.push('⚠️ <b>In scadenza / scaduti</b>');
    for (const d of expiring) {
      const icon  = d.severity === 'critical' ? '🔴' : '🟡';
      const label = DOC_TYPE_LABELS[d.doc_type] || 'Documento';
      const when  = d.days < 0
        ? `scaduto ${Math.abs(d.days)}gg fa`
        : `scade in ${d.days}gg`;
      lines.push(`${icon} ${d.worker?.full_name || ''} — ${label} · ${when}`);
    }
  }

  return (
    `📋 <b>PALLADIA — Documenti lavoratori</b>\n\n` +
    lines.join('\n') +
    `\n\n→ <a href="${FRONTEND_URL}/risorse">Gestisci i documenti</a>`
  );
}

async function runDailyDocCheck() {
  console.log('[dailyDocCheck] avvio controllo unificato documenti lavoratori...');

  const todayStr = new Date().toISOString().split('T')[0];
  const t30      = inDays(30);

  // ── Fetch workers attivi ─────────────────────────────────────
  const { data: workers, error: wErr } = await supabase
    .from('workers')
    .select('id, company_id, full_name')
    .eq('is_active', true);

  if (wErr) { console.error('[dailyDocCheck] fetch workers:', wErr.message); return; }
  if (!workers?.length) { console.log('[dailyDocCheck] nessun lavoratore — skip.'); return; }

  const workerIds = workers.map(w => w.id);

  // ── Fetch doc obbligatori validi (per missing check) ─────────
  const { data: requiredDocs, error: rdErr } = await supabase
    .from('worker_documents')
    .select('worker_id, doc_type')
    .in('worker_id', workerIds)
    .in('doc_type', REQUIRED_TYPES)
    .or(`expiry_date.is.null,expiry_date.gte.${todayStr}`);

  if (rdErr) { console.error('[dailyDocCheck] fetch required docs:', rdErr.message); return; }

  // ── Fetch documenti in scadenza (≤30gg, tutti i tipi) ────────
  const { data: expiryDocs, error: edErr } = await supabase
    .from('worker_documents')
    .select(`id, company_id, worker_id, doc_type, name, expiry_date,
             worker:workers ( full_name, is_active )`)
    .not('expiry_date', 'is', null)
    .lte('expiry_date', t30)
    .order('expiry_date', { ascending: false });

  if (edErr) { console.error('[dailyDocCheck] fetch expiry docs:', edErr.message); return; }

  // Dedup: per (worker_id, doc_type) tieni solo il doc con expiry massima
  const latestByKey = new Map();
  for (const d of (expiryDocs || [])) {
    if (!d.worker?.is_active) continue;
    const key = `${d.worker_id}:${d.doc_type}`;
    if (!latestByKey.has(key)) latestByKey.set(key, d);
  }
  const relevantExpiry = [...latestByKey.values()].map(d => ({
    ...d,
    days:     daysUntil(d.expiry_date),
    severity: severityFor(daysUntil(d.expiry_date)),
  }));

  // ── Costruisci set doc presenti per worker ────────────────────
  const workerDocTypes = new Map();
  for (const d of (requiredDocs || [])) {
    if (!workerDocTypes.has(d.worker_id)) workerDocTypes.set(d.worker_id, new Set());
    workerDocTypes.get(d.worker_id).add(d.doc_type);
  }

  // ── Trova worker con mancanze ─────────────────────────────────
  const missingByWorker = [];
  for (const w of workers) {
    const present      = workerDocTypes.get(w.id) || new Set();
    const missingTypes = REQUIRED_TYPES
      .filter(t => !present.has(t))
      .map(t => DOC_TYPE_LABELS[t]);
    if (missingTypes.length) missingByWorker.push({ ...w, missingTypes });
  }

  // ── Raggruppa per company ─────────────────────────────────────
  const companies = new Set([
    ...missingByWorker.map(w => w.company_id),
    ...relevantExpiry.map(d => d.company_id),
  ]);

  if (!companies.size) { console.log('[dailyDocCheck] tutto in regola — skip.'); return; }

  for (const companyId of companies) {
    const companyMissing = missingByWorker.filter(w => w.company_id === companyId);
    const companyExpiry  = relevantExpiry.filter(d => d.company_id === companyId);

    try {
      // ── In-app: documenti mancanti ────────────────────────────
      const missingIds = new Set();
      for (const w of companyMissing) {
        await upsertNotification({
          companyId,
          type:       'worker_doc_missing',
          severity:   'critical',
          title:      `${w.full_name} — ${w.missingTypes.join(', ')}`,
          body:       'Documenti obbligatori mancanti',
          entityType: 'worker',
          entityId:   w.id,
        });
        missingIds.add(w.id);
      }
      const { resolved: resolvedMissing } = await pruneNotifications(
        companyId, 'worker_doc_missing', 'worker', missingIds
      );

      // ── In-app: scadenze ──────────────────────────────────────
      const expiryIds    = new Set();
      const telegramExpiry = [];
      for (const d of companyExpiry) {
        const typeLabel = DOC_TYPE_LABELS[d.doc_type] || 'Documento';
        const { isNew, escalated } = await upsertNotification({
          companyId,
          type:       'worker_doc_expiry',
          severity:   d.severity,
          title:      `${d.worker.full_name} — ${typeLabel}`,
          body:       severityLabel(d.days),
          entityType: 'worker_document',
          entityId:   d.id,
        });
        expiryIds.add(d.id);
        if (shouldSendTelegram(d.severity, { isNew, escalated })) telegramExpiry.push(d);
      }
      const { resolved: resolvedExpiry } = await pruneNotifications(
        companyId, 'worker_doc_expiry', 'worker_document', expiryIds
      );

      // ── Telegram: un unico messaggio combinato ────────────────
      // Missing → sempre inviato (critical ogni giorno)
      // Expiry  → solo quelli che shouldSendTelegram ha approvato
      if (companyMissing.length || telegramExpiry.length) {
        const msg = buildUnifiedMessage(companyMissing, telegramExpiry);
        await notifyExpiryAlert(companyId, msg).catch(() => {});
      }

      // Risolti: un solo messaggio aggregato
      const resolvedAll = [...(resolvedMissing || []), ...(resolvedExpiry || [])];
      if (resolvedAll.length) {
        await notifyResolved(companyId, resolvedAll, 'Documenti aggiornati').catch(() => {});
      }

      console.log(
        `[dailyDocCheck] ${companyId}: mancanti=${companyMissing.length}, ` +
        `scadenze TG=${telegramExpiry.length}, risolti=${resolvedAll.length}`
      );
    } catch (e) {
      console.error(`[dailyDocCheck] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[dailyDocCheck] completato.');
}

function startDailyDocCheckCron() {
  cron.schedule('5 7 * * *', async () => {
    try { await runDailyDocCheck(); }
    catch (e) { console.error('[dailyDocCheck] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] daily-doc-check attivo — 07:05 Europe/Rome');
}

module.exports = { startDailyDocCheckCron, runDailyDocCheck };
