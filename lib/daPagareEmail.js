'use strict';
// ── Da pagare: fatture inoltrate per email (F-338) ──────────────────────────
// Dopo l'importazione (services/emailIngestWebhook.js), con il modulo acceso:
//   - le spese create entrano nella lista (da_pagare = true). Quelle lette da
//     un PDF senza XML restano "da controllare" (pending_review) finché il
//     titolare non tocca "È giusto";
//   - a chi ha inoltrato, se è titolare/amministratore/tecnico, arriva la
//     risposta con quello che è stato letto, o "non ho trovato una fattura".
// Mai una risposta a un mittente esterno: non deve diventare un'eco verso
// chiunque scriva all'indirizzo.
const supabase = require('./supabase');
const { attivoPer } = require('./daPagare');

const SENZA_FATTURA = ['rejected_type', 'sdi_metadata_skipped', 'processing_error'];

async function segnaComeDaPagare({ companyId, expenseIds = [], outcome, rispondiA = null }) {
  if (!companyId || !(await attivoPer(companyId))) return { attivo: false };
  let righe = [];
  if (expenseIds.length) {
    const { error } = await supabase.from('company_expenses').update({ da_pagare: true }).in('id', expenseIds).eq('company_id', companyId);
    if (error) throw new Error(error.message);
    const { data } = await supabase.from('company_expenses')
      .select('supplier, amount, data_scadenza, invoice_number, pending_review').in('id', expenseIds).eq('company_id', companyId);
    righe = (data || []).map(r => ({
      fornitore: r.supplier, importo: Number(r.amount), scadenza: r.data_scadenza || null,
      numero: r.invoice_number || null, certa: !r.pending_review,
    }));
  }
  if (!rispondiA) return { attivo: true, righe };
  const { sendDaPagareReply } = require('../services/email');
  const { data: company } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  const azienda = company?.name || '';
  if (righe.length) await sendDaPagareReply({ to: rispondiA, righe, azienda });
  else if (outcome === 'duplicate') await sendDaPagareReply({ to: rispondiA, righe: [], giaPresente: true, azienda });
  else if (SENZA_FATTURA.includes(outcome)) await sendDaPagareReply({ to: rispondiA, righe: [], nessuna: true, azienda });
  return { attivo: true, righe };
}

module.exports = { segnaComeDaPagare };
