'use strict';
/**
 * scripts/generate-vapid.js
 * Esegui una sola volta: node scripts/generate-vapid.js
 * Copia i valori nelle env Railway: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL
 */
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\n=== VAPID Keys ===');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('VAPID_EMAIL=mailto:admin@palladia.net');
console.log('\nAggiungi queste tre variabili nelle env di Railway e nel frontend (.env).');
