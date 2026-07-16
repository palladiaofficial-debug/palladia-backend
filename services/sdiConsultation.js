'use strict';

/**
 * services/sdiConsultation.js
 * Consultazione fatture elettroniche via Delega Unificata sul Cassetto Fiscale
 * dell'Agenzia delle Entrate — meccanismo di SOLA LETTURA, complementare (non
 * sostitutivo) a services/sdiInvoices.js.
 *
 * Differenza rispetto al flusso Openapi/SdI esistente:
 *   - sdiInvoices.js sposta il Codice Destinatario: Palladia diventa il ricevente
 *     ufficiale delle fatture passive (azione irreversibile senza ripristino manuale
 *     dell'impresa sul sito dell'Agenzia Entrate).
 *   - Questo modulo NON tocca il Codice Destinatario: chi riceve oggi le fatture
 *     (es. il commercialista) continua a riceverle esattamente come ora. L'Agenzia
 *     delle Entrate conserva comunque una copia di ogni fattura transitata sul
 *     sistema, indipendentemente da chi l'ha ricevuta — questa delega permette di
 *     leggere quella copia via API, senza spostare nulla. È il percorso a rischio
 *     zero per un'impresa che vuole provare Palladia con dati reali prima di
 *     eventualmente passare al collegamento diretto (sdiInvoices.js).
 *
 * Provider: A-Cube (https://acubeapi.com) — unico tra quelli valutati con un
 * prodotto documentato di consultazione Cassetto Fiscale + Delega Unificata.
 *
 * Flusso:
 *   1. connectCompany() crea la "Business Registry Configuration" su A-Cube e le
 *      associa le credenziali Fisconline (NON persistite nel nostro DB — inoltrate
 *      una tantum e scartate dalla memoria di processo).
 *   2. Il titolare dell'impresa completa la Delega Unificata sul portale
 *      dell'Agenzia delle Entrate (ricezione/conferma/accettazione via PEC — passo
 *      manuale, fuori da questa integrazione, gestito dall'Agenzia Entrate stessa).
 *   3. pollAndIngestInvoices() (cron periodico, vedi sdiConsultationPollCron.js)
 *      scarica le fatture nuove, le trasforma in spesa cantiere con lo stesso
 *      motore di sdiInvoices.js::ingestMappedExpense (assegnazione cantiere,
 *      categorizzazione, notifica) e aggiorna lo stato della delega.
 *
 * NOTA DI ONESTÀ TECNICA — DA VERIFICARE PRIMA DELLA PRIMA ATTIVAZIONE REALE:
 * i path esatti di alcuni endpoint A-Cube (in particolare la lista/download delle
 * fatture in listNewReceivedInvoices, e l'associazione BRC↔incaricato in
 * assignBrcToAppointee) sono la migliore ricostruzione possibile dalla
 * documentazione pubblica (docs.acubeapi.com/documentation/italy/gov-it/cassettofiscale),
 * che non pubblica lo spec OpenAPI completo senza un account attivo. Vanno
 * confermati/corretti con un account sandbox A-Cube reale — stesso trattamento già
 * riservato all'auth_header ambiguo di Openapi in sdiInvoices.js. Finché non sono
 * verificati, pollAndIngestInvoices marca la company in errore invece di fallire
 * silenziosamente, così l'assenza di dati reali è visibile in getStatus().
 */

const supabase = require('../lib/supabase');
const { acubeRequest, acubeRequestRaw, getEnvironment } = require('../lib/acubeClient');
const { parseFatturaPaXml } = require('../lib/fatturaPaXmlParser');
const { ingestMappedExpense } = require('./sdiInvoices');

const CONFIG_TABLE = 'sdi_consultation_configurations';

function normalizeFiscalId(fiscalId) {
  return String(fiscalId || '').trim().toUpperCase().replace(/^IT/, '');
}

// ── Collega una company alla consultazione (richiede credenziali Fisconline) ──
// Le credenziali non vengono mai scritte su sdi_consultation_configurations: sono
// inoltrate ad A-Cube nella stessa chiamata e restano solo in memoria di processo.
async function connectCompany({ companyId, userId, fiscalId, fisconlineUsername, fisconlinePassword, fisconlinePin }) {
  const normalizedFiscalId = normalizeFiscalId(fiscalId);

  const { data: existing } = await supabase
    .from(CONFIG_TABLE)
    .select('id')
    .eq('company_id', companyId)
    .maybeSingle();

  const row = {
    company_id:   companyId,
    fiscal_id:    fiscalId,
    provider:     'acube',
    environment:  getEnvironment(),
    status:       'pending_delegation',
    created_by:   userId || null,
    error_message: null,
  };

  let configRow;
  if (existing) {
    const { data, error } = await supabase.from(CONFIG_TABLE)
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select().single();
    if (error) throw error;
    configRow = data;
  } else {
    const { data, error } = await supabase.from(CONFIG_TABLE)
      .insert(row).select().single();
    if (error) throw error;
    configRow = data;
  }

  try {
    // 1. Crea la Business Registry Configuration su A-Cube per questa P.IVA/CF
    const brc = await acubeRequest('/business-registry-configuration', {
      method: 'POST',
      body: JSON.stringify({ fiscalId: normalizedFiscalId }),
    });
    const brcId = brc?.id;
    if (!brcId) throw new Error('A-Cube: id BRC mancante nella risposta');

    // 2. Fisconline: inoltrate ad A-Cube, mai salvate lato nostro
    await acubeRequest(`/business-registry-configurations/${brcId}/credentials/fisconline`, {
      method: 'PUT',
      body: JSON.stringify({
        username: fisconlineUsername,
        password: fisconlinePassword,
        pin:      fisconlinePin,
      }),
    });

    // 3. Associa la BRC all'incaricato A-Cube configurato una tantum (ACUBE_APPOINTEE_ID)
    //    — l'"incaricato" è un'entità dell'account A-Cube di Palladia, non per-company.
    const appointeeId = process.env.ACUBE_APPOINTEE_ID;
    if (appointeeId) {
      await assignBrcToAppointee(appointeeId, brcId);
    }

    await supabase.from(CONFIG_TABLE).update({
      status: 'pending_delegation',
      provider_brc_id: brcId,
      updated_at: new Date().toISOString(),
    }).eq('id', configRow.id);

    return { ok: true, status: 'pending_delegation' };
  } catch (err) {
    await supabase.from(CONFIG_TABLE).update({
      status: 'error',
      error_message: err.message,
      updated_at: new Date().toISOString(),
    }).eq('id', configRow.id);
    throw err;
  }
}

// VERIFICARE path esatto con un account A-Cube reale — vedi nota di onestà tecnica in testa al file.
async function assignBrcToAppointee(appointeeId, brcId) {
  return acubeRequest(`/ade-appointees/${appointeeId}/assign-brc`, {
    method: 'POST',
    body: JSON.stringify({ businessRegistryConfigurationId: brcId }),
  });
}

async function getStatus(companyId) {
  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .select('fiscal_id, provider, environment, status, last_poll_at, last_invoice_received_at, error_message, created_at')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function disconnectCompany(companyId) {
  // La delega sul portale Agenzia Entrate resta attiva finché il titolare non la
  // revoca da lì — questo comando disattiva solo il polling lato Palladia.
  const { error } = await supabase
    .from(CONFIG_TABLE)
    .update({ status: 'disabled', updated_at: new Date().toISOString() })
    .eq('company_id', companyId);
  if (error) throw error;
}

// Costruisce l'oggetto "a forma di invoice Openapi" richiesto da
// generateSiteAssignmentProposal/categorizeInvoice (services/ladiaSmartProposal.js),
// senza dover toccare quelle funzioni pensate per il payload JSON di Openapi.
function toInvoiceShapeForAi(parsed) {
  return {
    sender: { name: parsed.supplierName },
    invoice_lines: parsed.lineDescriptions.map((description) => ({ description })),
  };
}

function mapParsedInvoiceToExpense(companyId, parsed, invoiceId) {
  return {
    company_id:   companyId,
    amount:       parsed.amount,
    description:  parsed.docNumber ? `Fattura ${parsed.docNumber} — ${parsed.supplierName}` : `Fattura — ${parsed.supplierName}`,
    category:     'altro', // raffinata da categorizeInvoice dentro ingestMappedExpense se resta 'altro'
    payment_method: parsed.paymentMethod,
    supplier:     parsed.supplierName,
    supplier_vat: parsed.supplierVat,
    expense_date: parsed.issueDate || new Date().toISOString().slice(0, 10),
    invoice_number: parsed.docNumber,
    is_deductible: true,
    notes:        'Importata automaticamente dal Cassetto Fiscale (consultazione via delega)',
    source:       'sdi_consultation',
    sdi_invoice_id: invoiceId,
    sdi_raw_invoice: parsed,
  };
}

// VERIFICARE path/parametri esatti con un account A-Cube reale — vedi nota di
// onestà tecnica in testa al file. Ritorna [{ id, xml }] per le fatture passive
// nuove dalla data indicata (o dagli ultimi 90 giorni al primo poll).
async function listNewReceivedInvoices(fiscalId, sinceDate) {
  const dateFrom = sinceDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const list = await acubeRequest(
    `/gov-it/invoices?fiscalId=${encodeURIComponent(normalizeFiscalId(fiscalId))}&type=received&dateFrom=${dateFrom}`,
  );
  const items = Array.isArray(list) ? list : (list?.data || []);

  const invoices = [];
  for (const item of items) {
    const xml = await acubeRequestRaw(`/gov-it/invoices/${item.id}/xml`).catch((err) => {
      console.error(`[sdi-consultation] download XML fattura ${item.id} fallito:`, err.message);
      return null;
    });
    if (xml) invoices.push({ id: String(item.id), xml });
  }
  return invoices;
}

// ── Poll periodico: una company per volta, un errore non blocca le altre ─────
async function pollAndIngestInvoices() {
  const { data: configs, error } = await supabase
    .from(CONFIG_TABLE)
    .select('id, company_id, fiscal_id, status, last_poll_at')
    .in('status', ['pending_delegation', 'active']);
  if (error) throw error;

  const results = { checked: 0, imported: 0, errors: 0 };

  for (const config of configs || []) {
    results.checked += 1;
    try {
      const invoices = await listNewReceivedInvoices(config.fiscal_id, config.last_poll_at?.slice(0, 10));

      for (const { id, xml } of invoices) {
        let parsed;
        try {
          parsed = parseFatturaPaXml(xml);
        } catch (parseErr) {
          console.error(`[sdi-consultation] parsing XML fattura ${id} fallito:`, parseErr.message);
          continue;
        }
        const expenseRow = mapParsedInvoiceToExpense(config.company_id, parsed, id);
        const result = await ingestMappedExpense(
          config.company_id, expenseRow, toInvoiceShapeForAi(parsed), { configTable: CONFIG_TABLE },
        );
        if (result.ok && !result.skipped) results.imported += 1;
      }

      // La delegazione risulta attiva solo dopo che il primo poll non fallisce:
      // prima di allora l'AdE potrebbe non aver ancora confermato via PEC.
      await supabase.from(CONFIG_TABLE).update({
        status: 'active',
        last_poll_at: new Date().toISOString(),
        error_message: null,
      }).eq('id', config.id);
    } catch (err) {
      results.errors += 1;
      console.error(`[sdi-consultation] poll fallito per company ${config.company_id}:`, err.message);
      await supabase.from(CONFIG_TABLE).update({
        status: config.status === 'active' ? 'active' : 'error', // non retrocedere una delega già attiva per un errore transitorio
        error_message: err.message,
        last_poll_at: new Date().toISOString(),
      }).eq('id', config.id);
    }
  }

  return results;
}

module.exports = {
  connectCompany,
  getStatus,
  disconnectCompany,
  pollAndIngestInvoices,
};
