#!/usr/bin/env node
/**
 * Anteprima del riepilogo delle 7:30 (F-240) per un'azienda, SENZA inviare
 * nulla e senza scrivere nel DB: stampa il messaggio così come arriverebbe
 * su Telegram. Uso: node scripts/preview_alert_digest.js <company_id>
 */
'use strict';
require('dotenv').config();
const { buildDigest, isDigestEnabled } = require('../lib/alertDigest');

(async () => {
  const companyId = process.argv[2];
  if (!companyId) { console.error('uso: node scripts/preview_alert_digest.js <company_id>'); process.exit(1); }
  const d = await buildDigest(companyId, { queue: [] });
  console.log(`riepilogo acceso per questa azienda: ${await isDigestEnabled(companyId)}`);
  if (!d) { console.log('Nessuna riga nuova: domani mattina nessun messaggio.'); return; }
  console.log('\n----- Telegram -----\n' + d.text.replace(/<\/?[bi]>/g, ''));
  console.log(`\n----- Notifica app -----\n${d.push.title}\n${d.push.body}`);
  console.log(`\n(${d.freshIds.length} righe nuove, ${d.total} aperte in tutto)`);
})().catch(e => { console.error(e.message); process.exit(1); });
