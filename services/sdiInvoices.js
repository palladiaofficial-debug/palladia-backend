'use strict';

/**
 * services/sdiInvoices.js
 * Ricezione automatica fatture fornitore via SdI (Sistema di Interscambio),
 * tramite il provider accreditato Openapi (https://openapi.com).
 *
 * ENV richieste:
 *   OPENAPI_API_KEY      — Bearer token (sandbox o produzione)
 *   OPENAPI_ENV           — 'sandbox' | 'production' (default 'sandbox')
 *   OPENAPI_WEBHOOK_URL   — URL pubblico del nostro webhook (es. https://.../api/v1/expenses/sdi/webhook)
 *
 * Flusso:
 *   1. L'impresa registra il proprio Codice Destinatario sul sito dell'Agenzia
 *      Entrate puntando al codice del provider (PIC7CPS per Openapi) — azione
 *      manuale, fuori da questa integrazione.
 *   2. connectCompany() registra l'azienda su Openapi (IT-configurations) e
 *      configura il webhook per l'evento fattura passiva.
 *   3. Ogni fattura fornitore in arrivo genera una chiamata al nostro webhook,
 *      già come oggetto JSON strutturato (non XML) — vedi mapInvoiceResponseToExpense.
 */

const crypto   = require('crypto');
const supabase = require('../lib/supabase');

const BASE_URL = {
  sandbox:    'https://test.invoice.openapi.com',
  production: 'https://invoice.openapi.com',
};

function getEnvironment() {
  return process.env.OPENAPI_ENV === 'production' ? 'production' : 'sandbox';
}

function getApiKey() {
  const key = process.env.OPENAPI_API_KEY;
  if (!key) throw new Error('OPENAPI_API_KEY non configurata');
  return key;
}

function getWebhookUrl() {
  const url = process.env.OPENAPI_WEBHOOK_URL;
  if (!url) throw new Error('OPENAPI_WEBHOOK_URL non configurata');
  return url;
}

async function openapiRequest(path, options = {}) {
  const base = BASE_URL[getEnvironment()];
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.message || `Openapi error ${res.status}`);
    err.status = res.status;
    err.body   = body;
    throw err;
  }
  return body;
}

// ── Collega una company al provider SdI ──────────────────────────────────────
// Registra la configurazione IT su Openapi con il webhook per fatture passive,
// e salva lo stato del collegamento in sdi_configurations.
async function connectCompany({ companyId, userId, fiscalId }) {
  const webhookSecret = crypto.randomBytes(24).toString('hex');

  const { data: existing } = await supabase
    .from('sdi_configurations')
    .select('id')
    .eq('company_id', companyId)
    .maybeSingle();

  const row = {
    company_id: companyId,
    fiscal_id:  fiscalId,
    provider:   'openapi',
    environment: getEnvironment(),
    status:     'pending',
    webhook_secret: webhookSecret,
    created_by: userId || null,
    error_message: null,
  };

  let configRow;
  if (existing) {
    const { data, error } = await supabase.from('sdi_configurations')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select().single();
    if (error) throw error;
    configRow = data;
  } else {
    const { data, error } = await supabase.from('sdi_configurations')
      .insert(row).select().single();
    if (error) throw error;
    configRow = data;
  }

  try {
    const providerConfig = await openapiRequest('/IT-configurations', {
      method: 'POST',
      body: JSON.stringify({
        fiscal_id: fiscalId,
        api_configurations: [{
          event: 'supplier-invoice',
          callback: {
            method:  'JSON',
            url:     getWebhookUrl(),
            headers: { 'x-sdi-webhook-secret': webhookSecret },
          },
        }],
      }),
    });

    await supabase.from('sdi_configurations').update({
      status: 'active',
      provider_configuration_id: providerConfig?.data?.fiscal_id || fiscalId,
      updated_at: new Date().toISOString(),
    }).eq('id', configRow.id);

    return { ok: true, status: 'active' };
  } catch (err) {
    await supabase.from('sdi_configurations').update({
      status: 'error',
      error_message: err.message,
      updated_at: new Date().toISOString(),
    }).eq('id', configRow.id);
    throw err;
  }
}

async function getConnectionStatus(companyId) {
  const { data, error } = await supabase
    .from('sdi_configurations')
    .select('fiscal_id, provider, environment, status, last_invoice_received_at, error_message, created_at')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function disconnectCompany(companyId) {
  const { error } = await supabase
    .from('sdi_configurations')
    .update({ status: 'disabled', updated_at: new Date().toISOString() })
    .eq('company_id', companyId);
  if (error) throw error;
}

// ── Trova la company dal webhook_secret ricevuto ─────────────────────────────
async function resolveCompanyByWebhookSecret(secret) {
  if (!secret) return null;
  const { data } = await supabase
    .from('sdi_configurations')
    .select('company_id, status')
    .eq('webhook_secret', secret)
    .maybeSingle();
  if (!data || data.status === 'disabled') return null;
  return data.company_id;
}

// ── Mappa una InvoiceResponse (schema Openapi) in una riga company_expenses ──
// Funzione pura, testabile senza rete: la fattura arriva già strutturata
// (sender/recipient/invoice_lines/importi separati), non XML da parsare.
function mapInvoiceResponseToExpense(companyId, invoice) {
  if (!invoice || typeof invoice !== 'object') {
    throw new Error('Invoice payload mancante o non valido');
  }
  if (invoice.direction && invoice.direction !== 'incoming') {
    return null; // ignora le fatture emesse (outgoing), qui ci interessano solo quelle passive
  }

  const amount = invoice.total_gross_amount ?? invoice.total_amount_including_tax ?? invoice.total_payable_amount;
  if (!amount || amount <= 0) {
    throw new Error('Fattura senza importo totale valido');
  }

  const supplierName = invoice.sender?.name || 'Fornitore sconosciuto';
  const docNumber     = invoice.document_number || null;

  const paymentMeans = Array.isArray(invoice.payment_means) ? invoice.payment_means[0] : null;
  const paymentMethod = mapPaymentMethod(paymentMeans);

  return {
    company_id:        companyId,
    amount:             Math.round(amount * 100) / 100,
    description:        docNumber ? `Fattura ${docNumber} — ${supplierName}` : `Fattura — ${supplierName}`,
    category:           'altro', // categorizzazione automatica: possibile evoluzione futura, non in questa prima versione
    payment_method:      paymentMethod,
    supplier:            supplierName,
    supplier_vat:         invoice.sender?.vat_id || invoice.sender?.tax_code || null,
    expense_date:        invoice.issue_date || new Date().toISOString().slice(0, 10),
    invoice_number:       docNumber,
    is_deductible:       true,
    notes:               'Importata automaticamente da fattura elettronica (SdI)',
    source:              'sdi_auto',
    sdi_invoice_id:       invoice.id,
    sdi_raw_invoice:      invoice,
  };
}

function mapPaymentMethod(paymentMeans) {
  const code = (paymentMeans?.mode || paymentMeans?.type || '').toUpperCase();
  if (code.includes('CONT')) return 'contanti';
  if (code.includes('ASSEG')) return 'assegno';
  if (code.includes('CARTA')) return 'carta';
  return 'bonifico'; // default ragionevole per fatture B2B — la maggior parte è bonifico/RIBA
}

// ── Ingest: dedup + salvataggio spesa ─────────────────────────────────────────
// Idempotente: la stessa fattura (stesso sdi_invoice_id) non crea mai due spese,
// anche se il provider ritenta la consegna del webhook.
async function ingestSupplierInvoice(companyId, invoice) {
  const expenseRow = mapInvoiceResponseToExpense(companyId, invoice);
  if (!expenseRow) return { ok: true, skipped: true, reason: 'not_incoming' };

  const { data: existing } = await supabase
    .from('company_expenses')
    .select('id')
    .eq('company_id', companyId)
    .eq('sdi_invoice_id', expenseRow.sdi_invoice_id)
    .maybeSingle();

  if (existing) {
    return { ok: true, skipped: true, reason: 'duplicate', expense_id: existing.id };
  }

  const { data, error } = await supabase
    .from('company_expenses')
    .insert(expenseRow)
    .select('id, amount, supplier, expense_date')
    .single();

  if (error) throw error;

  await supabase.from('sdi_configurations')
    .update({ last_invoice_received_at: new Date().toISOString() })
    .eq('company_id', companyId);

  return { ok: true, skipped: false, expense: data };
}

module.exports = {
  connectCompany,
  getConnectionStatus,
  disconnectCompany,
  resolveCompanyByWebhookSecret,
  mapInvoiceResponseToExpense,
  ingestSupplierInvoice,
};
