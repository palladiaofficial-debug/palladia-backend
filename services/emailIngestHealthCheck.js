'use strict';

/**
 * services/emailIngestHealthCheck.js
 * Completezza verificabile senza consultare l'Agenzia delle Entrate: tre controlli
 * sulle fatture ricevute via email (source='email'), esposti da
 * GET /api/v1/expenses/email-ingest/health.
 *
 *  1. Salti di numerazione per fornitore (es. arrivano la 12 e la 14 → segnala
 *     "possibile fattura mancante").
 *  2. Anomalie di cadenza (fornitore regolare che salta un periodo).
 *  3. Salute del canale (data dell'ultima email ricevuta, con soglia sul silenzio
 *     anomalo per QUELLA azienda specifica, non una soglia fissa uguale per tutti).
 *
 * Calcolato on-read (volumi attesi bassi per una singola company) — un cron
 * dedicato è rimandabile se in futuro servisse.
 */

const supabase = require('../lib/supabase');

// Sotto questa soglia di fatture storiche per un fornitore non c'è abbastanza
// pattern per distinguere "fornitore sporadico" da "salto reale" — meglio tacere
// che dare un falso allarme.
const MIN_INVOICES_FOR_CADENCE_PATTERN = 4;
const CADENCE_ANOMALY_MULTIPLIER = 2; // il gap corrente supera 2x la mediana storica

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

// Il numero fattura è testo libero ("2026/014", "FT-14", "14"...) — estrae
// l'ULTIMO gruppo numerico come "numero d'ordine" plausibile: nel formato più
// diffuso in Italia (prefisso o anno seguito dal progressivo, es. "2026/12") è
// l'anno a comparire per primo e il progressivo per ultimo, non il contrario.
// Non è un parsing perfetto (non può esserlo su formati completamente liberi:
// un numero "12/2026" con la sequenza PRIMA dell'anno legge male), ma intercetta
// il caso comune senza inventare falsi allarmi sull'anno stesso.
function extractSequenceNumber(invoiceNumber) {
  const matches = String(invoiceNumber || '').match(/\d+/g);
  if (!matches || !matches.length) return null;
  return parseInt(matches[matches.length - 1], 10);
}

async function fetchEmailInvoices(companyId) {
  const { data, error } = await supabase
    .from('company_expenses')
    .select('supplier, supplier_vat, invoice_number, expense_date')
    .eq('company_id', companyId)
    .eq('source', 'email')
    .not('supplier_vat', 'is', null)
    .order('expense_date', { ascending: true });
  if (error) throw error;
  return data || [];
}

function detectNumberingGaps(invoices) {
  const bySupplier = new Map();
  for (const inv of invoices) {
    const seq = extractSequenceNumber(inv.invoice_number);
    if (seq == null) continue;
    if (!bySupplier.has(inv.supplier_vat)) bySupplier.set(inv.supplier_vat, []);
    bySupplier.get(inv.supplier_vat).push({ seq, invoice_number: inv.invoice_number, expense_date: inv.expense_date });
  }

  const gaps = [];
  for (const [supplierVat, entries] of bySupplier) {
    entries.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const curr = entries[i];
      if (curr.seq - prev.seq > 1 && curr.seq - prev.seq <= 50) { // oltre 50 è quasi certamente un cambio di serie/anno, non un buco
        gaps.push({
          supplier: invoices.find((x) => x.supplier_vat === supplierVat)?.supplier || supplierVat,
          supplier_vat: supplierVat,
          after_invoice: prev.invoice_number,
          before_invoice: curr.invoice_number,
          missing_count: curr.seq - prev.seq - 1,
        });
      }
    }
  }
  return gaps;
}

function detectCadenceAnomalies(invoices, today) {
  const bySupplier = new Map();
  for (const inv of invoices) {
    if (!bySupplier.has(inv.supplier_vat)) bySupplier.set(inv.supplier_vat, []);
    bySupplier.get(inv.supplier_vat).push(inv);
  }

  const anomalies = [];
  for (const [supplierVat, entries] of bySupplier) {
    if (entries.length < MIN_INVOICES_FOR_CADENCE_PATTERN) continue;
    entries.sort((a, b) => a.expense_date.localeCompare(b.expense_date));

    const gaps = [];
    for (let i = 1; i < entries.length; i++) gaps.push(daysBetween(entries[i - 1].expense_date, entries[i].expense_date));
    const typicalGap = median(gaps);
    if (!typicalGap) continue;

    const lastDate = entries[entries.length - 1].expense_date;
    const currentGap = daysBetween(lastDate, today);
    if (currentGap > typicalGap * CADENCE_ANOMALY_MULTIPLIER) {
      anomalies.push({
        supplier: entries[0].supplier,
        supplier_vat: supplierVat,
        typical_gap_days: Math.round(typicalGap),
        current_gap_days: currentGap,
        last_invoice_date: lastDate,
      });
    }
  }
  return anomalies;
}

async function getChannelHealth(companyId, invoices, today) {
  const { data: config } = await supabase
    .from('email_ingest_configurations')
    .select('status, last_invoice_received_at, created_at')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!config) return { connected: false };

  const dates = [...new Set(invoices.map((i) => i.expense_date))].sort();
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
  const typicalGapDays = median(gaps);

  const lastReceivedDate = config.last_invoice_received_at ? config.last_invoice_received_at.slice(0, 10) : null;
  const silentDays = lastReceivedDate ? daysBetween(lastReceivedDate, today) : null;

  // Senza abbastanza storico per stabilire un ritmo, usa una soglia fissa
  // ragionevole (10 giorni) invece di restare muti sulla salute del canale.
  const threshold = typicalGapDays ? typicalGapDays * CADENCE_ANOMALY_MULTIPLIER : 10;
  const silentLongerThanUsual = silentDays != null && silentDays > threshold;

  // Caso distinto e probabilmente più comune di "si è fermato dopo un po'":
  // il canale è attivo ma non ha MAI ricevuto nulla — inoltro mai configurato
  // correttamente, indirizzo sbagliato incollato, filtro non salvato. Senza
  // questo controllo silent_days resta null per sempre (nessun invio storico
  // da cui calcolarlo) e il problema non verrebbe mai segnalato. Soglia di
  // 3 giorni dall'attivazione per non disturbare chi si è appena iscritto.
  const daysSinceSetup = config.created_at ? daysBetween(config.created_at.slice(0, 10), today) : 0;
  const neverReceivedAfterSetup = config.status === 'active' && !lastReceivedDate && daysSinceSetup >= 3;

  return {
    connected: true,
    status: config.status,
    last_invoice_received_at: config.last_invoice_received_at,
    silent_days: silentDays,
    typical_gap_days: typicalGapDays ? Math.round(typicalGapDays) : null,
    silent_longer_than_usual: silentLongerThanUsual,
    never_received_after_setup: neverReceivedAfterSetup,
    days_since_setup: daysSinceSetup,
  };
}

async function getHealthReport(companyId) {
  const today = new Date().toISOString().slice(0, 10);
  const invoices = await fetchEmailInvoices(companyId);

  return {
    numbering_gaps: detectNumberingGaps(invoices),
    cadence_anomalies: detectCadenceAnomalies(invoices, today),
    channel_health: await getChannelHealth(companyId, invoices, today),
  };
}

module.exports = { getHealthReport };
