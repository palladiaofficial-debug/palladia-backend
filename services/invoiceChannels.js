'use strict';

/**
 * services/invoiceChannels.js
 * Vista unica, sola lettura, sui tre canali fatture fornitore attivi: email
 * (email_ingest_configurations), delega Cassetto Fiscale A-Cube
 * (sdi_consultation_configurations), importazione massiva storico
 * (sdi_massive_import_batches). Nessuna migrazione dati, nessuna tabella nuova
 * di configurazione — le tre tabelle restano esattamente come sono, questo
 * modulo si limita a interrogarle e restituire una forma comune (Opzione 2 del
 * censimento del 2026-08-22, vedi AUDIT.md F-063: stesso pattern già adottato
 * per `documents` sopra le tabelle documentali).
 *
 * Distinzione esplicita mantenuta nella forma di risposta, non nascosta: email
 * e Cassetto Fiscale sono canali con stato persistente ("connesso"/"non
 * connesso"), l'importazione massiva è un'azione una tantum — ha una
 * cronologia di caricamenti, non uno stato "attivo" da spegnere.
 */

const { getStatus: getEmailStatus } = require('./emailIngestConfig');
const { getStatus: getConsultationStatus } = require('./sdiConsultation');
const { listRecentBatches } = require('./sdiMassiveImport');

async function getInvoiceChannelsStatus(companyId) {
  const [email, consultation, batches] = await Promise.all([
    getEmailStatus(companyId),
    getConsultationStatus(companyId),
    listRecentBatches(companyId, 3),
  ]);

  return {
    channels: [
      {
        channel_type: 'email',
        label: 'Fatture via Email',
        kind: 'persistent',
        connected: !!email && email.status === 'active',
        status: email?.status || 'not_connected',
        address: email?.address || null,
        last_invoice_received_at: email?.last_invoice_received_at || null,
        created_at: email?.created_at || null,
      },
      {
        channel_type: 'acube_consultation',
        label: 'Delega Cassetto Fiscale',
        kind: 'persistent',
        connected: !!consultation && consultation.status === 'active',
        status: consultation?.status || 'not_connected',
        last_invoice_received_at: consultation?.last_invoice_received_at || null,
        last_poll_at: consultation?.last_poll_at || null,
        error_message: consultation?.error_message || null,
        created_at: consultation?.created_at || null,
      },
      {
        channel_type: 'massive_import',
        label: 'Importazione storico (download AdE)',
        kind: 'one_shot',
        recent_batches: batches,
        last_batch_at: batches[0]?.created_at || null,
      },
    ],
  };
}

module.exports = {
  getInvoiceChannelsStatus,
};
