'use strict';

/**
 * services/sdiInvoices.js
 * Ricezione automatica fatture fornitore via SdI (Sistema di Interscambio),
 * tramite il provider accreditato Openapi (https://openapi.com), prodotto "SDI".
 *
 * ENV richieste:
 *   OPENAPI_API_KEY            — Bearer token (sandbox o produzione)
 *   OPENAPI_ENV                 — 'sandbox' | 'production' (default 'sandbox')
 *   OPENAPI_WEBHOOK_URL         — URL pubblico per l'evento supplier-invoice
 *   OPENAPI_LEGAL_STORAGE_WEBHOOK_URL — URL pubblico per la conferma di conservazione
 *
 * Flusso:
 *   1. L'impresa registra il proprio Codice Destinatario sul sito dell'Agenzia
 *      Entrate puntando al codice del provider (PIC7CPS per Openapi) — azione
 *      manuale, fuori da questa integrazione, spetta al titolare dell'impresa.
 *   2. connectCompany() registra l'azienda su Openapi con apply_legal_storage:true
 *      (conservazione sostitutiva a norma inclusa, non solo salvataggio del JSON)
 *      e configura i webhook per fattura passiva + conferma di conservazione.
 *   3. Ogni fattura fornitore in arrivo genera una chiamata al nostro webhook,
 *      già come oggetto JSON strutturato (non XML) — vedi mapInvoiceResponseToExpense.
 *   4. Quando il documento risulta effettivamente conservato, un secondo webhook
 *      conferma lo stato — vedi confirmLegalStorage.
 *
 * NOTA: il campo `auth_header` dell'API Openapi (usato per autenticare le
 * chiamate in ingresso al nostro webhook) è documentato in modo ambiguo nella
 * loro specifica pubblica ("nome dell'header" ma l'esempio mostra un valore
 * tipo "Bearer xxx"). Verifichiamo entrambe le interpretazioni lato nostro
 * (vedi resolveCompanyFromRequest) finché non c'è un account reale con cui
 * confermare il comportamento esatto.
 */

const crypto   = require('crypto');
const supabase = require('../lib/supabase');
const { auditLog } = require('../lib/audit');
const { generateSiteAssignmentProposal, categorizeInvoice } = require('./ladiaSmartProposal');

const SDI_BASE_URL = {
  sandbox:    'https://test.sdi.openapi.it',
  production: 'https://sdi.openapi.it',
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

function getLegalStorageWebhookUrl() {
  const url = process.env.OPENAPI_LEGAL_STORAGE_WEBHOOK_URL;
  if (!url) throw new Error('OPENAPI_LEGAL_STORAGE_WEBHOOK_URL non configurata');
  return url;
}

// Openapi vuole il fiscal_id SENZA il prefisso paese (es. "12345678901", non "IT12345678901")
function normalizeFiscalId(fiscalId) {
  return String(fiscalId || '').trim().toUpperCase().replace(/^IT/, '');
}

async function sdiRequest(path, options = {}) {
  const base = SDI_BASE_URL[getEnvironment()];
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
    const err = new Error(body?.message || body?.['hydra:description'] || `Openapi error ${res.status}`);
    err.status = res.status;
    err.body   = body;
    throw err;
  }
  return body;
}

// ── Collega una company al provider SdI ──────────────────────────────────────
// Due chiamate: registra l'anagrafica con conservazione a norma attiva, poi
// configura i webhook per fattura passiva e conferma di conservazione.
async function connectCompany({ companyId, userId, userEmail, fiscalId }) {
  const webhookSecret = crypto.randomBytes(24).toString('hex');
  const normalizedFiscalId = normalizeFiscalId(fiscalId);

  const { data: company } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();

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
    legal_storage_enabled: true,
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
    // 1. Anagrafica + conservazione a norma attiva (apply_legal_storage:true —
    //    non solo salvare il JSON, conservazione sostitutiva reale lato provider)
    await sdiRequest('/business_registry_configurations', {
      method: 'POST',
      body: JSON.stringify({
        fiscal_id: normalizedFiscalId,
        name:      company?.name || 'Azienda',
        email:     userEmail || 'noreply@palladia.net',
        apply_signature:     false, // riceviamo soltanto, non firmiamo/inviamo fatture per conto del cliente
        apply_legal_storage: true,
      }),
    });

    // 2. Webhook: fattura passiva ricevuta + conferma di conservazione
    await sdiRequest('/api_configurations', {
      method: 'POST',
      body: JSON.stringify({
        fiscal_id: normalizedFiscalId,
        callbacks: [
          { event: 'supplier-invoice',    url: getWebhookUrl(),              auth_header: `Bearer ${webhookSecret}` },
          { event: 'legal-storage-receipt', url: getLegalStorageWebhookUrl(), auth_header: `Bearer ${webhookSecret}` },
        ],
      }),
    });

    await supabase.from('sdi_configurations').update({
      status: 'active',
      provider_configuration_id: normalizedFiscalId,
      updated_at: new Date().toISOString(),
    }).eq('id', configRow.id);

    return { ok: true, status: 'active', legal_storage_enabled: true };
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
    .select('fiscal_id, provider, environment, status, legal_storage_enabled, last_invoice_received_at, error_message, created_at')
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

// ── Trova la company dal secret ricevuto sul webhook ──────────────────────────
// Openapi documenta auth_header in modo ambiguo — verifica sia "Authorization:
// Bearer <secret>" (interpretazione più probabile, coerente col loro esempio)
// sia l'header custom "x-sdi-webhook-secret" per compatibilità.
async function resolveCompanyFromHeaders(headers) {
  const authHeader = headers['authorization'] || '';
  const bearerSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const secret = bearerSecret || headers['x-sdi-webhook-secret'] || null;
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
    category:           categorizeByKeywords(supplierName, invoice.invoice_lines) || 'altro',
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
    sdi_legal_storage_status: 'to_be_stored',
  };
}

function mapPaymentMethod(paymentMeans) {
  const code = (paymentMeans?.mode || paymentMeans?.type || '').toUpperCase();
  if (code.includes('CONT')) return 'contanti';
  if (code.includes('ASSEG')) return 'assegno';
  if (code.includes('CARTA')) return 'carta';
  return 'bonifico'; // default ragionevole per fatture B2B — la maggior parte è bonifico/RIBA
}

// ── Categorizzazione automatica (euristica a costo zero) ──────────────────────
// Copre i casi comuni di un'impresa edile guardando fornitore + righe fattura,
// prima di ricorrere a Ladia (AI, a pagamento) come fallback in ingestSupplierInvoice.
// Ordine intenzionale: categorie con termini specifici prima, 'materiali' per ultima
// perché i suoi termini sono i più generici e più a rischio di falsi positivi.
const CATEGORY_KEYWORDS = {
  carburante:     ['carburante', 'gasolio', 'diesel', 'benzina', 'gpl', 'stazione di servizio', 'rifornimento carburante'],
  assicurazioni:  ['assicurazione', 'polizza', 'rc auto', 'premio assicurativo'],
  affitto:        ['canone di locazione', 'locazione immobile', 'affitto locali', 'affitto capannone'],
  subappalto:     ['subappalto', 'subappaltatore', 'lavori in subappalto'],
  consulenze:     ['consulenza', 'onorario', 'parcella', 'prestazione professionale', 'studio tecnico', 'commercialista'],
  attrezzature:   ['noleggio', 'nolo a caldo', 'nolo a freddo', 'noleggio attrezzatura', 'escavatore', 'gru', 'ponteggio', 'betoniera', 'piattaforma aerea'],
  manutenzione:   ['manutenzione', 'riparazione', 'tagliando', 'assistenza tecnica'],
  trasporti:      ['trasporto merci', 'spedizione', 'corriere', 'autotrasporto', 'nolo trasporto'],
  utenze:         ['energia elettrica', 'elettricità', 'gas naturale', 'metano', 'fornitura acqua', 'telefonia', 'canone internet', 'fibra ottica'],
  cancelleria:    ['cancelleria', 'materiale ufficio', 'toner', 'carta a4'],
  vitto_alloggio: ['ristorante', 'hotel', 'albergo', 'vitto', 'pernottamento', 'buoni pasto'],
  materiali:      ['cemento', 'calcestruzzo', 'sabbia', 'ghiaia', 'mattoni', 'laterizi', 'tondino', 'malta', 'intonaco', 'piastrelle', 'materiale edile', 'ferramenta', 'isolante', 'guaina', 'pittura edile'],
};

function categorizeByKeywords(supplierName, invoiceLines) {
  const text = [supplierName, ...(invoiceLines || []).map((l) => l.description)]
    .filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return null;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) return category;
  }
  return null;
}

// ── Assegnazione automatica al cantiere ───────────────────────────────────────
// Euristica deterministica, zero costo AI: se la company ha UN SOLO cantiere
// attivo, la spesa è quasi certamente sua — assegnala. Con più cantieri attivi
// contemporaneamente non si può indovinare con certezza da una sola fattura,
// resta "generale" (site_id null) per revisione manuale invece di sbagliare.
const ACTIVE_SITE_STATUSES = ['attivo', 'sospeso'];

// Ritorna { siteId, activeSites }: siteId valorizzato solo se c'è un solo
// cantiere attivo; activeSites (fino a 10) serve a Ladia per la proposta
// quando siteId è null e ce n'è più di uno.
async function resolveSiteAssignment(companyId) {
  const { data: sites } = await supabase
    .from('sites')
    .select('id, name, address')
    .eq('company_id', companyId)
    .in('status', ACTIVE_SITE_STATUSES)
    .limit(10);

  if (sites && sites.length === 1) return { siteId: sites[0].id, activeSites: sites };
  return { siteId: null, activeSites: sites || [] };
}

// ── Assegnazione da storico fornitore (più affidabile di un'ipotesi testuale) ─
// Se le fatture precedenti dello stesso fornitore (per partita IVA) sono SEMPRE
// state assegnate allo stesso cantiere, è un pattern reale confermato da un
// umano — non un'ipotesi — quindi si può assegnare in automatico senza chiedere
// conferma. Richiede almeno 2 precedenti concordi, altrimenti non rischia.
async function resolveSiteFromSupplierHistory(companyId, supplierVat, activeSiteIds) {
  if (!supplierVat || !activeSiteIds?.length) return null;

  const { data: past } = await supabase
    .from('company_expenses')
    .select('site_id')
    .eq('company_id', companyId)
    .eq('supplier_vat', supplierVat)
    .not('site_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!past || past.length < 2) return null;

  const distinctSites = [...new Set(past.map((p) => p.site_id))];
  if (distinctSites.length !== 1) return null; // pattern non consistente, meglio non indovinare

  const siteId = distinctSites[0];
  if (!activeSiteIds.includes(siteId)) return null; // il cantiere di sempre non è più attivo

  return { siteId, occurrences: past.length };
}

// ── Notifica in-app ────────────────────────────────────────────────────────────
// Stessa tabella già in uso per scadenze/alert — compare nel centro notifiche
// indipendentemente dal fatto che qualcuno abbia la pagina Spese aperta o meno
// (l'auto-refresh via Realtime copre solo chi ce l'ha già aperta in quel momento).
async function notifyExpenseImported(companyId, expense, { ambiguous, suggestion, viaHistory }) {
  const title = ambiguous
    ? 'Fattura fornitore da assegnare a un cantiere'
    : 'Nuova fattura fornitore importata';
  const body = ambiguous
    ? (suggestion
        ? `${expense.supplier} · ${expense.amount}€ — Ladia pensa sia per un cantiere specifico, conferma o correggi.`
        : `${expense.supplier} · ${expense.amount}€ — non sono riuscito a capire per quale cantiere, assegnala tu.`)
    : (viaHistory
        ? `${expense.supplier} · ${expense.amount}€ — assegnata come sempre allo stesso cantiere di questo fornitore, nessuna azione richiesta.`
        : `${expense.supplier} · ${expense.amount}€ — assegnata automaticamente, nessuna azione richiesta.`);

  await supabase.from('notifications').insert({
    company_id:  companyId,
    type:        'sdi_invoice_received',
    severity:    ambiguous ? 'warning' : 'info',
    title,
    body,
    entity_type: 'company_expense',
    entity_id:   expense.id,
  }).then(null, (e) => console.error('[sdi] notification insert error:', e.message));
}

// ── Ingest: dedup + salvataggio spesa ─────────────────────────────────────────
// Idempotente: la stessa fattura (stesso sdi_invoice_id) non crea mai due spese,
// anche se il provider ritenta la consegna del webhook.
async function ingestSupplierInvoice(companyId, invoice) {
  const expenseRow = mapInvoiceResponseToExpense(companyId, invoice);
  if (!expenseRow) return { ok: true, skipped: true, reason: 'not_incoming' };
  return ingestMappedExpense(companyId, expenseRow, invoice);
}

// ── Ingest condiviso tra provider (Openapi via webhook, A-Cube via consultazione) ──
// `invoiceForAi` è nella forma { sender: { name }, invoice_lines: [{ description }] }
// attesa da generateSiteAssignmentProposal/categorizeInvoice — services/sdiConsultation.js
// costruisce un oggetto equivalente a partire dallo XML FatturaPA, senza dover
// modificare quelle funzioni pensate originariamente per il payload Openapi.
// `configTable` indica quale tabella di configurazione aggiornare con
// last_invoice_received_at/last_poll_at a fine importazione.
async function ingestMappedExpense(companyId, expenseRow, invoiceForAi, { configTable = 'sdi_configurations' } = {}) {
  const { siteId, activeSites } = await resolveSiteAssignment(companyId);
  expenseRow.site_id = siteId;

  let viaHistory = false;
  if (!expenseRow.site_id && activeSites.length >= 2) {
    // Prima lo storico: se questo fornitore è sempre andato sullo stesso
    // cantiere, è un pattern reale confermato da un umano — più affidabile
    // di un'ipotesi letta dal testo della fattura, e non richiede conferma.
    const historical = await resolveSiteFromSupplierHistory(
      companyId, expenseRow.supplier_vat, activeSites.map((s) => s.id),
    ).catch(() => null);
    if (historical) {
      expenseRow.site_id = historical.siteId;
      expenseRow.notes += ' — cantiere assegnato in automatico: le fatture precedenti di questo fornitore erano sempre per questo cantiere.';
      viaHistory = true;
    }
  }

  const ambiguous = !expenseRow.site_id && activeSites.length >= 2;
  const needsCategoryGuess = expenseRow.category === 'altro';
  let suggestion = null;

  if (ambiguous || needsCategoryGuess) {
    // Se non è bastata l'euristica, un'ultima chiamata Ladia copre insieme
    // cantiere (solo se ancora ambiguo) e categoria (solo se ancora 'altro') —
    // una sola chiamata invece di due quando servono entrambe.
    if (ambiguous) {
      suggestion = await generateSiteAssignmentProposal(invoiceForAi, activeSites, companyId).catch(() => null);
      if (suggestion) {
        expenseRow.suggested_site_id = suggestion.site_id;
        expenseRow.suggested_site_reason = suggestion.reason;
      }
    }
    if (needsCategoryGuess) {
      const aiCategory = await categorizeInvoice(invoiceForAi, companyId).catch(() => null);
      if (aiCategory) expenseRow.category = aiCategory;
    }
  }

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
    .select('id, amount, supplier, expense_date, site_id')
    .single();

  if (error) throw error;

  await supabase.from(configTable)
    .update({ last_invoice_received_at: new Date().toISOString() })
    .eq('company_id', companyId);

  auditLog({
    companyId,
    action:     expenseRow.source === 'sdi_consultation' ? 'expense.sdi_consultation_import' : 'expense.sdi_auto_import',
    targetType: 'company_expense',
    targetId:   data.id,
    payload:    { amount: data.amount, supplier: data.supplier, sdi_invoice_id: expenseRow.sdi_invoice_id },
  });

  await notifyExpenseImported(companyId, data, { ambiguous, suggestion, viaHistory });

  return { ok: true, skipped: false, expense: data };
}

// ── Conferma di conservazione a norma ─────────────────────────────────────────
// Callback separata dal provider quando il documento risulta effettivamente
// archiviato (o fallito) presso il servizio di conservazione sostitutiva.
async function confirmLegalStorage(companyId, payload) {
  const objectId = payload?.object_id || payload?.data?.object_id;
  const status   = payload?.status    || payload?.data?.status;
  if (!objectId) return { ok: true, skipped: true, reason: 'missing_object_id' };

  const patch = {
    sdi_legal_storage_status: status || 'stored',
    sdi_legal_storage_object_id: payload?.preserved_object_id || payload?.data?.preserved_object_id || null,
  };
  if (status === 'stored') patch.sdi_legal_storage_confirmed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('company_expenses')
    .update(patch)
    .eq('company_id', companyId)
    .eq('sdi_invoice_id', objectId)
    .select('id')
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: true, skipped: true, reason: 'expense_not_found' };
  return { ok: true, expense_id: data.id };
}

module.exports = {
  connectCompany,
  getConnectionStatus,
  disconnectCompany,
  resolveCompanyFromHeaders,
  mapInvoiceResponseToExpense,
  ingestSupplierInvoice,
  ingestMappedExpense,
  confirmLegalStorage,
};
