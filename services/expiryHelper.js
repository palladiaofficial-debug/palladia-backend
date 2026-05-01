'use strict';
/**
 * services/expiryHelper.js
 * Utility condivise tra i cron di scadenza (worker, equipment, company docs).
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
  if (days < 0)  return 'critical'; // già scaduto
  if (days <= 7) return 'warning';  // scade entro 7 giorni
  return 'info';                    // scade entro 30 giorni
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
 * Upsert una notifica. Se severity peggiora, azzera read_by.
 */
async function upsertNotification({ companyId, type, severity, title, body, entityType, entityId }) {
  // Leggi se esiste già
  const { data: existing } = await supabase
    .from('notifications')
    .select('id, severity, read_by')
    .eq('company_id', companyId)
    .eq('entity_type', entityType)
    .eq('entity_id',   entityId)
    .eq('type',        type)
    .maybeSingle();

  const severityWorsened = existing
    && (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[existing.severity] ?? 0);

  const record = {
    company_id:  companyId,
    type,
    severity,
    title,
    body,
    entity_type: entityType,
    entity_id:   entityId,
    updated_at:  new Date().toISOString(),
    // Azzera read_by se severity peggiora → la notifica riappare come non letta
    ...(severityWorsened ? { read_by: [] } : {}),
  };

  await supabase
    .from('notifications')
    .upsert(record, { onConflict: 'company_id,entity_type,entity_id,type' });
}

/**
 * Rimuove notifiche di un tipo per cui non esiste più una scadenza imminente.
 * entityIds = set di ID ancora rilevanti (il resto viene eliminato).
 */
async function pruneNotifications(companyId, type, entityType, relevantEntityIds) {
  if (!relevantEntityIds.size) {
    // Nessuna scadenza rilevante → elimina tutte di quel tipo
    await supabase.from('notifications')
      .delete()
      .eq('company_id', companyId)
      .eq('type', type)
      .eq('entity_type', entityType);
    return;
  }

  // Recupera le notifiche esistenti per questo tipo
  const { data: existing } = await supabase
    .from('notifications')
    .select('id, entity_id')
    .eq('company_id', companyId)
    .eq('type', type)
    .eq('entity_type', entityType);

  const toDelete = (existing || [])
    .filter(n => !relevantEntityIds.has(n.entity_id))
    .map(n => n.id);

  if (toDelete.length) {
    await supabase.from('notifications').delete().in('id', toDelete);
  }
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
  pruneNotifications,
};
