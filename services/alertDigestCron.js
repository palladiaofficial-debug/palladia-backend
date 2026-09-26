'use strict';
// F-240 — riepilogo unico delle 7:30 e rete di sicurezza delle 7:50.
// Sempre avviato: per le aziende con `alert_digest` spento non fa nulla
// (i loro automatismi inviano subito, come prima). Logica in lib/alertDigest.js.
const cron = require('node-cron');
const { runDigest, runWatchdog } = require('../lib/alertDigest');

function startAlertDigestCron() {
  cron.schedule('30 7 * * *', async () => {
    try { await runDigest(); }
    catch (e) { console.error('[alertDigest] errore riepilogo:', e.message); }
  }, { timezone: 'Europe/Rome' });

  cron.schedule('50 7 * * *', async () => {
    try { await runWatchdog(); }
    catch (e) { console.error('[alertDigest] errore controllo 7:50:', e.message); }
  }, { timezone: 'Europe/Rome' });

  console.log('[cron] alert-digest attivo — riepilogo 07:30, controllo 07:50 (Europe/Rome)');
}

module.exports = { startAlertDigestCron };
