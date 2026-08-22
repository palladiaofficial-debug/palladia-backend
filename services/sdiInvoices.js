'use strict';

/**
 * services/sdiInvoices.js
 * Motore di ingest condiviso da tutti i canali fatture fornitore attivi
 * (email — services/emailIngestWebhook.js, delega Cassetto Fiscale A-Cube —
 * services/sdiConsultation.js, importazione massiva storico —
 * services/sdiMassiveImport.js): dedup, assegnazione cantiere (euristica +
 * storico fornitore + Ladia come fallback), categorizzazione, audit log,
 * notifica in-app — tutto vive qui una volta sola, non in ciascun canale.
 *
 * Ospitava anche il canale "Codice Destinatario diretto" via il provider
 * Openapi (connect/webhook/status/disconnect) — rimosso il 2026-08-22, vedi
 * AUDIT.md F-063: mai attivato in produzione (OPENAPI_API_KEY mai configurata),
 * mai raggiungibile da nessuna UI, e con un bug latente sul CHECK constraint di
 * company_expenses.source che lo avrebbe rotto al primo uso reale. Il nome del
 * file resta per non rompere i molti import esistenti di ingestMappedExpense.
 */

const supabase = require('../lib/supabase');
const { auditLog } = require('../lib/audit');
const { generateSiteAssignmentProposal, categorizeInvoice } = require('./ladiaSmartProposal');

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

// Normalizza un numero fattura per il confronto di identità fiscale (dedup canale
// email/massivo): stesso numero scritto "2024/001", "2024-001" o "2024 001" deve
// confrontare uguale — tiene solo lettere/cifre, minuscolo.
function normalizeInvoiceNumber(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Notifica in-app ────────────────────────────────────────────────────────────
// Stessa tabella già in uso per scadenze/alert — compare nel centro notifiche
// indipendentemente dal fatto che qualcuno abbia la pagina Spese aperta o meno
// (l'auto-refresh via Realtime copre solo chi ce l'ha già aperta in quel momento).
async function notifyExpenseImported(companyId, expense, { ambiguous, suggestion, viaHistory, pendingReview, pendingReviewReason }) {
  const title = pendingReview
    ? 'Possibile fattura già presente — verifica'
    : ambiguous
      ? 'Fattura fornitore da assegnare a un cantiere'
      : 'Nuova fattura fornitore importata';
  const body = pendingReview
    ? `${expense.supplier} · ${expense.amount}€ — ${pendingReviewReason || 'sembra già presente come spesa caricata a mano, verifica prima di tenerle entrambe.'}`
    : ambiguous
      ? (suggestion
          ? `${expense.supplier} · ${expense.amount}€ — Ladia pensa sia per un cantiere specifico, conferma o correggi.`
          : `${expense.supplier} · ${expense.amount}€ — non sono riuscito a capire per quale cantiere, assegnala tu.`)
      : (viaHistory
          ? `${expense.supplier} · ${expense.amount}€ — assegnata come sempre allo stesso cantiere di questo fornitore, nessuna azione richiesta.`
          : `${expense.supplier} · ${expense.amount}€ — assegnata automaticamente, nessuna azione richiesta.`);

  await supabase.from('notifications').insert({
    company_id:  companyId,
    type:        pendingReview ? 'email_invoice_possible_duplicate' : 'sdi_invoice_received',
    severity:    (ambiguous || pendingReview) ? 'warning' : 'info',
    title,
    body,
    entity_type: 'company_expense',
    entity_id:   expense.id,
  }).then(null, (e) => console.error('[sdi] notification insert error:', e.message));
}

// Azione di audit per canale.
const INGEST_AUDIT_ACTION = {
  acube:       'expense.acube_import',
  email:       'expense.email_import',
  sdi_massive: 'expense.sdi_massive_import',
};

// ── Ingest condiviso tra canali (email, A-Cube, importazione massiva) ────────
// `invoiceForAi` è nella forma { sender: { name }, invoice_lines: [{ description }] }
// attesa da generateSiteAssignmentProposal/categorizeInvoice.
// `configTable` indica quale tabella di configurazione aggiornare con
// last_invoice_received_at/last_poll_at a fine importazione — `null` per i
// chiamanti senza uno stato canale persistente (l'importazione massiva è un
// caricamento una tantum, non un canale con uno stato proprio).
// `dedupExtra: true` (canale email/massivo) sostituisce la dedup per
// sdi_invoice_id — che questi canali non hanno, nessun provider assegna un id —
// con dedup per hash contenuto (match esatto, indice unico lato DB) poi per
// identità fiscale (P.IVA + numero documento normalizzato + data emissione): lo
// stesso documento arrivato in formati diversi (XML e p7m dello stesso
// contenuto) ha hash diversi ma identità fiscale identica. A-Cube resta sul
// dedup per sdi_invoice_id, invariato.
// `silent: true` salta la notifica in-app per singola spesa — usata
// dall'importazione massiva per non riempire il centro notifiche con centinaia
// di righe: il riepilogo lì è un'unica schermata a fine caricamento, non un
// flusso di notifiche.
async function ingestMappedExpense(companyId, expenseRow, invoiceForAi, { configTable = null, dedupExtra = false, silent = false } = {}) {
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

  if (dedupExtra) {
    if (expenseRow.content_hash) {
      const { data: byHash } = await supabase
        .from('company_expenses')
        .select('id')
        .eq('company_id', companyId)
        .eq('content_hash', expenseRow.content_hash)
        .maybeSingle();
      if (byHash) return { ok: true, skipped: true, reason: 'duplicate_hash', expense_id: byHash.id };
    }
    if (expenseRow.supplier_vat && expenseRow.invoice_number && expenseRow.expense_date) {
      const normalized = normalizeInvoiceNumber(expenseRow.invoice_number);
      const { data: sameDay } = await supabase
        .from('company_expenses')
        .select('id, invoice_number')
        .eq('company_id', companyId)
        .eq('supplier_vat', expenseRow.supplier_vat)
        .eq('expense_date', expenseRow.expense_date);
      const match = (sameDay || []).find((c) => normalizeInvoiceNumber(c.invoice_number) === normalized);
      if (match) return { ok: true, skipped: true, reason: 'duplicate_fiscal_identity', expense_id: match.id };
    }
  } else if (expenseRow.sdi_invoice_id) {
    // Guardia esplicita: senza questo `if`, un expenseRow senza sdi_invoice_id (mai il
    // caso oggi per A-Cube, ma da non dare per scontato) farebbe .eq(..., undefined),
    // che supabase-js ignora silenziosamente — la query perderebbe il filtro e
    // "trovarebbe" la prima riga qualunque della company, segnalando un falso doppione.
    const { data: existing } = await supabase
      .from('company_expenses')
      .select('id')
      .eq('company_id', companyId)
      .eq('sdi_invoice_id', expenseRow.sdi_invoice_id)
      .maybeSingle();

    if (existing) {
      return { ok: true, skipped: true, reason: 'duplicate', expense_id: existing.id };
    }
  }

  const { data, error } = await supabase
    .from('company_expenses')
    .insert(expenseRow)
    .select('id, amount, supplier, expense_date, site_id')
    .single();

  if (error) throw error;

  if (configTable) {
    await supabase.from(configTable)
      .update({ last_invoice_received_at: new Date().toISOString() })
      .eq('company_id', companyId);
  }

  auditLog({
    companyId,
    action:     INGEST_AUDIT_ACTION[expenseRow.source] || 'expense.email_import',
    targetType: 'company_expense',
    targetId:   data.id,
    payload:    { amount: data.amount, supplier: data.supplier, sdi_invoice_id: expenseRow.sdi_invoice_id },
  });

  if (!silent) {
    await notifyExpenseImported(companyId, data, {
      ambiguous, suggestion, viaHistory,
      pendingReview:       expenseRow.pending_review || false,
      pendingReviewReason: expenseRow.pending_review_reason || null,
    });
  }

  return { ok: true, skipped: false, expense: data, ambiguous, viaHistory };
}

module.exports = {
  ingestMappedExpense,
};
