'use strict';
/**
 * services/pushNotifications.js
 * Invia Web Push notifications ai dispositivi iscritti.
 * Gestisce automaticamente la pulizia delle subscription scadute (HTTP 410/404).
 */

const webpush  = require('web-push');
const supabase = require('../lib/supabase');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@palladia.net';

let ready = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  ready = true;
} else {
  console.warn('[push] VAPID keys mancanti — Web Push disabilitato.');
}

/**
 * Struttura payload:
 * {
 *   title: string,
 *   body:  string,
 *   tag?:  string,          // raggruppa notifiche dello stesso tipo
 *   url?:  string,          // dove navigare al click (relativo, es. "/risorse")
 *   icon?: string,
 * }
 */

async function sendPushToCompany(companyId, payload) {
  if (!ready) return;
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('company_id', companyId);
  await _dispatch(subs || [], payload);
}

async function sendPushToUser(userId, payload) {
  if (!ready) return;
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  await _dispatch(subs || [], payload);
}

async function _dispatch(subs, payload) {
  if (!subs.length) return;

  const message = JSON.stringify({
    title: payload.title || 'Palladia',
    body:  payload.body  || '',
    icon:  payload.icon  || '/icons/pwa-192.png',
    badge: '/icons/pwa-192.png',
    tag:   payload.tag   || 'palladia',
    data:  { url: payload.url || '/' },
  });

  const stale = [];
  await Promise.allSettled(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        message,
        { TTL: 86400 } // 24h TTL — se il device è offline riceve appena torna online
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        stale.push(sub.id); // subscription scaduta → rimuovi
      } else {
        console.error('[push] sendNotification error:', err.statusCode, err.message?.slice(0, 80));
      }
    }
  }));

  if (stale.length) {
    await supabase.from('push_subscriptions').delete().in('id', stale).catch(() => {});
    console.log(`[push] rimossi ${stale.length} subscription scadut${stale.length > 1 ? 'e' : 'a'}.`);
  }
}

module.exports = { sendPushToCompany, sendPushToUser };
