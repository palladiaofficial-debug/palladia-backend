'use strict';
const CACHE_VERSION = 'palladia-app-v3';

const PRECACHE_URLS = [
  '/',
  '/icon-pwa-192.png',
  '/icon-pwa-512.png',
  '/offline.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(cached => cached || caches.match('/offline.html'))
      )
  );
});

self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    const options = {
      body:               data.body || '',
      icon:               data.icon || '/icon-pwa-192.png',
      badge:              '/icon-pwa-192.png',
      tag:                data.tag || 'palladia',
      data:               { url: data.url || '/' },
      requireInteraction: data.requireInteraction || false,
      silent:             data.silent || false,
    };
    if (data.actions) options.actions = data.actions;
    e.waitUntil(self.registration.showNotification(data.title || 'Palladia', options));
  } catch { /* ignore malformed push */ }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/';
  const actionUrl = e.notification.data?.actionUrls?.[e.action];
  const url = actionUrl || targetUrl;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
