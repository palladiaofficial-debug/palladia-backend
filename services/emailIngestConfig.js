'use strict';

/**
 * services/emailIngestConfig.js
 * Configurazione per-company del canale fatture via inoltro email: indirizzo
 * dedicato (token casuale su un sottodominio dedicato), allowlist mittenti, e il
 * registro di ogni messaggio ricevuto. Vedi migrations/165_email_invoice_ingest.sql
 * e routes/v1/emailIngest.js.
 *
 * Stesso pattern di services/sdiInvoices.js (token per-company, generato con
 * crypto.randomBytes) e services/sdiConsultation.js — terzo canale sullo stesso
 * impianto, non una riscrittura.
 */

const crypto   = require('crypto');
const supabase = require('../lib/supabase');

// Zona palladia.net, catch-all Cloudflare Email Routing (non un sottodominio
// dedicato come da analisi iniziale — Mailgun/Resend risultati bloccati in fase di
// attivazione account, ripiegato su Cloudflare Email Routing già attivo sulla zona,
// vedi worker/emailIngestWorker.js). Gli indirizzi espliciti già in uso su
// palladia.net (es. info@) hanno priorità sulla regola catch-all — nessuna
// interferenza con la posta aziendale esistente.
const INBOUND_DOMAIN = process.env.EMAIL_INGEST_DOMAIN || 'palladia.net';

function generateToken() {
  return crypto.randomBytes(12).toString('hex'); // 24 caratteri esadecimali, non indovinabile
}

function fullAddress(token) {
  return `${token}@${INBOUND_DOMAIN}`;
}

// ── Configurazione canale ──────────────────────────────────────────────────────

async function connectCompany(companyId, userId) {
  const { data: existing } = await supabase
    .from('email_ingest_configurations')
    .select('id, inbound_token')
    .eq('company_id', companyId)
    .maybeSingle();

  if (existing) {
    // Già collegata in passato (magari disattivata) — riattiva senza generare un
    // nuovo indirizzo: l'utente potrebbe aver già comunicato quello attuale ai
    // propri fornitori/commercialista.
    const { data, error } = await supabase
      .from('email_ingest_configurations')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('inbound_token, status')
      .single();
    if (error) throw error;
    return { address: fullAddress(data.inbound_token), status: data.status };
  }

  const token = generateToken();
  const { data, error } = await supabase
    .from('email_ingest_configurations')
    .insert({ company_id: companyId, inbound_token: token, status: 'active', created_by: userId || null })
    .select('inbound_token, status')
    .single();
  if (error) throw error;
  return { address: fullAddress(data.inbound_token), status: data.status };
}

// Rigenerazione manuale — recupero da compromissione (l'indirizzo è finito nelle
// mani sbagliate, o un fornitore lo ha diffuso oltre l'uso previsto).
async function rotateToken(companyId) {
  const token = generateToken();
  const { data, error } = await supabase
    .from('email_ingest_configurations')
    .update({ inbound_token: token, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .select('inbound_token')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Canale email non collegato per questa azienda');
  return { address: fullAddress(data.inbound_token) };
}

async function getStatus(companyId) {
  const { data, error } = await supabase
    .from('email_ingest_configurations')
    .select('inbound_token, status, last_invoice_received_at, created_at, pending_test_nonce, pending_test_expires_at, last_test_verified_at')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const testPending = !!data.pending_test_nonce && new Date(data.pending_test_expires_at) > new Date();
  return {
    address: fullAddress(data.inbound_token),
    status: data.status,
    last_invoice_received_at: data.last_invoice_received_at,
    created_at: data.created_at,
    last_test_verified_at: data.last_test_verified_at,
    test_pending: testPending,
  };
}

// Prova dell'indirizzo: genera un nonce non indovinabile, valido 10 minuti, da
// includere nel subject dell'email di prova. Il webhook lo riconosce e conferma la
// riuscita SENZA passare dall'allowlist mittente — l'autenticità qui la garantisce
// il nonce (solo noi possiamo averlo generato), non l'identità del mittente reale
// (che con provider come Resend è un indirizzo envelope VERP imprevedibile).
const TEST_NONCE_TTL_MS = 10 * 60 * 1000;

async function startTest(companyId) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const expiresAt = new Date(Date.now() + TEST_NONCE_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from('email_ingest_configurations')
    .update({ pending_test_nonce: nonce, pending_test_expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('status', 'active')
    .select('inbound_token')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Canale email non attivo per questa azienda');
  return { address: fullAddress(data.inbound_token), nonce };
}

// Chiamata dal webhook: se il subject contiene un nonce di prova valido e non
// scaduto per QUALSIASI company, la consuma (mai riutilizzabile) e conferma.
// Ritorna il company_id a cui apparteneva, o null se nessun nonce corrisponde.
async function consumeTestNonce(token, subject) {
  const match = String(subject || '').match(/PALLADIA-TEST-([a-f0-9]{16})/);
  if (!match) return null;
  const nonce = match[1];
  const { data } = await supabase
    .from('email_ingest_configurations')
    .select('company_id, pending_test_nonce, pending_test_expires_at')
    .eq('inbound_token', token)
    .maybeSingle();
  if (!data || data.pending_test_nonce !== nonce) return null;
  if (new Date(data.pending_test_expires_at) <= new Date()) return null;

  await supabase
    .from('email_ingest_configurations')
    .update({ pending_test_nonce: null, pending_test_expires_at: null, last_test_verified_at: new Date().toISOString() })
    .eq('company_id', data.company_id);
  return data.company_id;
}

async function disconnectCompany(companyId) {
  const { error } = await supabase
    .from('email_ingest_configurations')
    .update({ status: 'disabled', updated_at: new Date().toISOString() })
    .eq('company_id', companyId);
  if (error) throw error;
}

// Risolve la company dal token nella parte locale del destinatario (recipient
// Mailgun). Ritorna null anche se la company esiste ma il canale è disabilitato —
// stesso trattamento di un token sconosciuto, entrambi finiscono loggati come tali
// dal chiamante (routes/v1/emailIngest.js).
async function resolveCompanyByToken(token) {
  if (!token) return null;
  const { data } = await supabase
    .from('email_ingest_configurations')
    .select('company_id, status')
    .eq('inbound_token', token)
    .maybeSingle();
  if (!data || data.status !== 'active') return null;
  return data.company_id;
}

// ── Allowlist mittenti ──────────────────────────────────────────────────────────

async function listAllowedSenders(companyId) {
  const { data, error } = await supabase
    .from('email_ingest_allowed_senders')
    .select('id, email_address, action, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Usata sia dalle rotte azienda (gestione manuale allowlist) sia dall'azione
// "autorizza sempre questo mittente"/"blocca" lanciata dall'interfaccia di
// quarantena — upsert perché l'utente potrebbe correggere una decisione precedente.
async function upsertAllowedSender(companyId, userId, emailAddress, action) {
  const normalized = String(emailAddress).trim().toLowerCase();
  const { data, error } = await supabase
    .from('email_ingest_allowed_senders')
    .upsert(
      { company_id: companyId, email_address: normalized, action, created_by: userId || null },
      { onConflict: 'company_id,email_address' },
    )
    .select('id, email_address, action, created_at')
    .single();
  if (error) throw error;
  return data;
}

async function removeAllowedSender(companyId, senderId) {
  const { error } = await supabase
    .from('email_ingest_allowed_senders')
    .delete()
    .eq('company_id', companyId)
    .eq('id', senderId);
  if (error) throw error;
}

// null = mittente mai visto per questa company → quarantena per default.
async function getSenderRule(companyId, emailAddress) {
  const normalized = String(emailAddress || '').trim().toLowerCase();
  const { data } = await supabase
    .from('email_ingest_allowed_senders')
    .select('action')
    .eq('company_id', companyId)
    .eq('email_address', normalized)
    .maybeSingle();
  return data?.action || null;
}

// ── Registro (ogni messaggio, accettato o no) ────────────────────────────────────

// Non deve mai far fallire il webhook che la richiama — un errore di log non deve
// impedire la risposta 200 a Mailgun (che altrimenti ritenterebbe all'infinito).
async function logIngestEvent(entry) {
  const { error } = await supabase.from('email_ingest_log').insert(entry);
  if (error) console.error('[email-ingest] log insert error:', error.message);
}

async function listIngestLog(companyId, { outcome, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from('email_ingest_log')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (outcome) query = query.eq('outcome', outcome);

  const { data, error, count } = await query;
  if (error) throw error;
  return { items: data || [], total: count || 0 };
}

module.exports = {
  INBOUND_DOMAIN,
  connectCompany,
  rotateToken,
  getStatus,
  disconnectCompany,
  resolveCompanyByToken,
  listAllowedSenders,
  upsertAllowedSender,
  removeAllowedSender,
  getSenderRule,
  logIngestEvent,
  listIngestLog,
  startTest,
  consumeTestNonce,
};
