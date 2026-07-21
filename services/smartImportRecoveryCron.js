'use strict';
/**
 * services/smartImportRecoveryCron.js
 * Rimette in coda gli import_items rimasti bloccati in 'processing' (crash
 * o riavvio Railway a metà elaborazione) e riprende il batch. Gira una volta
 * all'avvio (recovery da un riavvio) e poi ogni 15 minuti come rete di
 * sicurezza.
 */
const cron = require('node-cron');
const { reclaimStuckItems } = require('./smartImportPipeline');

function startSmartImportRecoveryCron() {
  reclaimStuckItems().catch(e => console.error('[smartImportRecovery] avvio fallito:', e.message));
  cron.schedule('*/15 * * * *', () => {
    reclaimStuckItems().catch(e => console.error('[smartImportRecovery] fallito:', e.message));
  });
}

module.exports = { startSmartImportRecoveryCron };
