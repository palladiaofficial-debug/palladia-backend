'use strict';
/**
 * services/expiryHelper.js
 * Utility condivise tra i cron di scadenza (worker, equipment, company docs, missing docs).
 */

const supabase = require('../lib/supabase');

// ── Date helpers ───────────────────────────────────────────────────────────────

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - Date.now()) / 86400000);
}

function today() { return new Date().toISOString().split('T')[0]; }

function inDays(n) { return new Date(Date.now() + n * 86400000).toISOString().split('T')[0]; }

// ── Severity ───────────────────────────────────────────────────────────────────

function severityFor(days) {
  if (days === null) return null;
  if (days < 0)  return 'critical';
  if (days <= 7) return 'warning';
  return 'info';
}

function severityLabel(days) {
  if (days === null) return '';
  if (days < 0)  return `scaduto ${Math.abs(days)} giorn${Math.abs(days) === 1 ? 'o' : 'i'} fa`;
  if (days === 0) return 'scade oggi';
  if (days === 1) return 'scade domani';
  return `scade in ${days} giorni`;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function getCompanyName(companyId) {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  return data?.name || 'la tua impresa';
}

async function getCompanyAdminEmails(companyId) {
  const { data: members } = await supabase
    .from('company_users')
    .select('user_id, role')
    .eq('company_id', companyId)
    .in('role', ['owner', 'admin', 'tech']);

  if (!members?.length) return [];

  const emails = [];
  for (const m of members) {
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(m.user_id);
      if (user?.email) emails.push(user.email);
    } catch { /* singolo fallimento non blocca */ }
  }
  return emails;
}

// ── Notifiche in-app ───────────────────────────────────────────────────────────

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

/**
 * Upsert una notifica.
 * Restituisce { isNew, escalated } — usati per decidere se inviare Telegram.
 *
 * Logica invio Telegram:
 *   - isNew     → prima volta che questo problema appare  → invia sempre
 *   - escalated → severity è peggiorata (info→warning o warning→critical) → invia sempre
 *   - severity = 'critical' → invia sempre (ogni giorno finché non risolto)
 *   - altrimenti           → non inviare (già notificato, non è peggiorato)
 */
async function upsertNotification({ companyId, type, severity, title, body, entityType, entityId }) {
  const { data: existing } = await supabase
    .from('notifications')
    .select('id, severity, read_by')
    .eq('company_id', companyId)
    .eq('entity_type', entityType)
    .eq('entity_id',   entityId)
    .eq('type',        type)
    .maybeSingle();

  const isNew      = !existing;
  const escalated  = !isNew && (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[existing.severity] ?? 0);

  const record = {
    company_id:  companyId,
    type,
    severity,
    title,
    body,
    entity_type: entityType,
    entity_id:   entityId,
    updated_at:  new Date().toISOString(),
    ...(escalated ? { read_by: [] } : {}), // severity peggiorata → riappare come non letta
  };

  await supabase
    .from('notifications')
    .upsert(record, { onConflict: 'company_id,entity_type,entity_id,type' });

  return { isNew, escalated };
}

/**
 * Determina se inviare la notifica Telegram in base a severity e metadati.
 */
function shouldSendTelegram(severity, { isNew, escalated }) {
  if (severity === 'critical') return true;  // critici: ogni giorno
  if (isNew || escalated)      return true;  // primo avviso o peggioramento
  return false;
}

/**
 * Rimuove notifiche per cui il problema non esiste più.
 * Restituisce { resolved } — lista di notifiche eliminate (per inviare "✅ Risolto" su Telegram).
 */
async function pruneNotifications(companyId, type, entityType, relevantEntityIds) {
  const { data: existing } = await supabase
    .from('notifications')
    .select('id, entity_id, title')
    .eq('company_id', companyId)
    .eq('type', type)
    .eq('entity_type', entityType);

  const toDelete = (existing || []).filter(n => !relevantEntityIds.has(n.entity_id));
  const resolved = toDelete.map(n => ({ id: n.id, title: n.title, entityId: n.entity_id }));

  if (toDelete.length) {
    await supabase.from('notifications').delete().in('id', toDelete.map(n => n.id));
  }

  return { resolved };
}

module.exports = {
  daysUntil,
  today,
  inDays,
  severityFor,
  severityLabel,
  getCompanyName,
  getCompanyAdminEmails,
  upsertNotification,
  shouldSendTelegram,
  pruneNotifications,
};
