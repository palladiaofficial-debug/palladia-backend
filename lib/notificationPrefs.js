'use strict';
/**
 * lib/notificationPrefs.js
 * Preferenze notifiche per utente — filtra destinatari in base a canale.
 *
 * Default: tutto abilitato. Se un utente non ha riga in notification_preferences,
 * riceve su tutti i canali (backward-compatible).
 */

const supabase = require('./supabase');

async function getPrefsMap(companyId) {
  const { data } = await supabase
    .from('notification_preferences')
    .select('user_id, email_enabled, telegram_enabled, push_enabled')
    .eq('company_id', companyId);

  const map = new Map();
  for (const row of data || []) {
    map.set(row.user_id, row);
  }
  return map;
}

function isChannelEnabled(prefsMap, userId, channel) {
  const pref = prefsMap.get(userId);
  if (!pref) return true;
  switch (channel) {
    case 'email':    return pref.email_enabled !== false;
    case 'telegram': return pref.telegram_enabled !== false;
    case 'push':     return pref.push_enabled !== false;
    default:         return true;
  }
}

async function filterUserIdsByChannel(companyId, userIds, channel) {
  if (!userIds.length) return [];
  const prefsMap = await getPrefsMap(companyId);
  return userIds.filter(uid => isChannelEnabled(prefsMap, uid, channel));
}

module.exports = { getPrefsMap, isChannelEnabled, filterUserIdsByChannel };
