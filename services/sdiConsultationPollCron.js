'use strict';

/**
 * services/sdiConsultationPollCron.js
 * Cron giornaliero (06:00 Rome) — scarica le nuove fatture per ogni company con
 * una consultazione Cassetto Fiscale attiva o in attesa di delega (vedi
 * services/sdiConsultation.js). A differenza del flusso Openapi (webhook push),
 * qui non c'è un evento in ingresso: la lettura è periodica per costruzione.
 *
 * Avvio: chiamare startSdiConsultationPollCron() da server.js al boot.
 */

const cron = require('node-cron');
const { pollAndIngestInvoices } = require('./sdiConsultation');

async function runPoll() {
  try {
    const result = await pollAndIngestInvoices();
    if (result.imported > 0 || result.errors > 0) {
      console.log(`[sdi-consultation-cron] verificate ${result.checked} aziende, importate ${result.imported} fatture, ${result.errors} errori`);
    }
  } catch (err) {
    console.error('[sdi-consultation-cron] errore:', err.message);
  }
}

function startSdiConsultationPollCron() {
  cron.schedule('0 6 * * *', runPoll, { timezone: 'Europe/Rome' });
}

module.exports = { startSdiConsultationPollCron, runPoll };
