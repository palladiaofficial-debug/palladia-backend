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

// Sottodominio dedicato — isolato dall'MX esistente di palladia.it, vedi Fase 1
// dell'analisi (nessun impatto sulla posta aziendale esistente).
const INBOUND_DOMAIN = process.env.EMAIL_INGEST_DOMAIN || 'fatture.palladia.it';

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
    .select('inbound_token, status, last_invoice_received_at, created_at')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    address: fullAddress(data.inbound_token),
    status: data.status,
    last_invoice_received_at: data.last_invoice_received_at,
    created_at: data.created_at,
  };
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
};
