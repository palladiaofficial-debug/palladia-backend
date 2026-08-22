'use strict';

/**
 * lib/fatturaCandidateMapper.js
 * Trasforma un candidato estratto da lib/fatturaPaEnvelopeParser.js::extractInvoiceCandidates
 * in una riga pronta per services/sdiInvoices.js::ingestMappedExpense — condiviso tra
 * il canale email (services/emailIngestWebhook.js) e l'importazione massiva dello
 * storico (services/sdiMassiveImport.js). Stesso XML, stesso parsing: unica fonte
 * per evitare che le due origini producano spese con forma leggermente diversa.
 */

const supabase = require('./supabase');

function normalizeSupplierName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Confronto con le spese caricate a mano (OCR/manuale): stesso fornitore, importo in
// tolleranza, data vicina → non importare in silenzio, segnala e fai scegliere. Usato
// sia dal canale email sia dall'importazione massiva — quest'ultima è particolarmente
// esposta: un'azienda che usa Palladia da mesi potrebbe aver già inserito a mano
// alcune delle fatture storiche che ora ricarica in blocco dallo ZIP dell'Agenzia Entrate.
async function checkOcrOverlap(companyId, { supplierName, amount, issueDate }) {
  if (!supplierName || !amount || !issueDate) return null;

  const { data } = await supabase
    .from('company_expenses')
    .select('id, supplier, amount, expense_date')
    .eq('company_id', companyId)
    .eq('source', 'manual')
    .gte('expense_date', addDaysIso(issueDate, -5))
    .lte('expense_date', addDaysIso(issueDate, 5));

  const targetSupplier = normalizeSupplierName(supplierName);
  const tolerance = Math.max(1, Number(amount) * 0.02);
  return (data || []).find((e) =>
    normalizeSupplierName(e.supplier) === targetSupplier &&
    Math.abs(Number(e.amount) - amount) <= tolerance,
  ) || null;
}

function toInvoiceShapeForAi(parsed) {
  return {
    sender: { name: parsed.supplierName },
    invoice_lines: (parsed.lineDescriptions || []).map((description) => ({ description })),
  };
}

/**
 * @param {string} companyId
 * @param {object} candidate — { parsed, contentHash } da extractInvoiceCandidates
 * @param {{ source?: string, notes?: string }} [overrides] — 'email' di default
 *   (comportamento storico invariato); l'importazione massiva passa 'sdi_massive'
 *   e una nota diversa.
 */
function mapCandidateToExpenseRow(companyId, candidate, overrides = {}) {
  const source = overrides.source || 'email';
  const notes  = overrides.notes || "Importata automaticamente da un'email inoltrata";
  const p = candidate.parsed;
  return {
    company_id:        companyId,
    amount:            p.amount,
    description:       p.docNumber ? `Fattura ${p.docNumber} — ${p.supplierName}` : `Fattura — ${p.supplierName}`,
    category:          'altro',
    payment_method:    p.paymentMethod,
    supplier:          p.supplierName,
    supplier_vat:      p.supplierVat,
    expense_date:      p.issueDate || new Date().toISOString().slice(0, 10),
    invoice_number:    p.docNumber,
    is_deductible:     true,
    notes,
    source,
    content_hash:      candidate.contentHash,
    sdi_document_type: p.documentType,
    is_credit_note:    !!p.isCreditNote,
    sdi_raw_invoice:   p,
  };
}

module.exports = { toInvoiceShapeForAi, mapCandidateToExpenseRow, checkOcrOverlap };
