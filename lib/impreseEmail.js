'use strict';
/**
 * lib/impreseEmail.js — F-410 (AUDIT.md del frontend): l'indirizzo email per i
 * documenti delle imprese in subappalto.
 *
 * Ogni azienda ha documenti-{nome}-{codice}@palladia.net. Arriva sullo stesso
 * catch-all Cloudflare delle fatture (services/emailIngestWebhook.js, che passa
 * qui i destinatari documenti-…). Gli allegati diventano un caricamento F-401
 * (lib/impreseCarica): divisi, letti, attribuiti. Niente finisce nelle schede
 * finché il titolare non guarda e salva, quindi non serve un elenco di mittenti
 * autorizzati: l'indirizzo ha un codice casuale e c'è un tetto giornaliero
 * (ogni allegato costa una lettura AI).
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const K = require('./impreseCarica');
const { slugifyCompanyName } = require('./emailIngestSlug');
const { isFeatureEnabled } = require('./featureFlags');

const PREFISSO = 'documenti-';
const DOMINIO = process.env.EMAIL_INGEST_DOMAIN || 'palladia.net';
const MAX_EMAIL_AL_GIORNO = 30;
const MAX_ALLEGATI = 60;
// Loghi e icone nelle firme delle email (image001.png…): sotto questa misura non sono documenti
const MIN_IMMAGINE = 20 * 1024;
const ESTENSIONI = /\.(pdf|jpe?g|png|webp|heic|zip)$/i;
const MIME = /^(application\/pdf|image\/(jpeg|jpg|png|webp|heic)|application\/(x-)?zip(-compressed)?)$/i;

const eDocumenti = (token) => typeof token === 'string' && token.startsWith(PREFISSO);
const indirizzoDi = (token) => `${token}@${DOMINIO}`;
const mittente = (raw) => { const m = String(raw || '').match(/<([^>]+)>/); return (m ? m[1] : String(raw || '')).trim().toLowerCase() || null; };

function documento(f) {
  if (!f?.buffer?.length) return false;
  const nome = f.originalname || '';
  if (!ESTENSIONI.test(nome) && !MIME.test(f.mimetype || '')) return false;
  const immagine = /^image\//i.test(f.mimetype || '') || /\.(jpe?g|png|webp|heic)$/i.test(nome);
  return !(immagine && f.buffer.length < MIN_IMMAGINE);
}

/** L'indirizzo dell'azienda; la prima volta lo crea. */
async function indirizzo(companyId, userId) {
  const { data: c } = await supabase.from('imprese_email_indirizzi').select('token').eq('company_id', companyId).maybeSingle();
  if (c) return { indirizzo: indirizzoDi(c.token) };
  const { data: az } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  const slug = slugifyCompanyName(az?.name || '') || 'impresa';
  const token = `${PREFISSO}${slug}-${crypto.randomBytes(3).toString('hex')}`;
  const { error } = await supabase.from('imprese_email_indirizzi').insert({ company_id: companyId, token, created_by: userId || null });
  if (error && error.code !== '23505') throw new Error(error.message);
  // 23505: creato nello stesso momento da un'altra richiesta, vale quello
  const { data: ora } = await supabase.from('imprese_email_indirizzi').select('token').eq('company_id', companyId).single();
  return { indirizzo: indirizzoDi(ora.token) };
}

/**
 * Un'email arrivata a documenti-…: { token, da, oggetto, files } (files come multer).
 * Esiti: ricevuto | sconosciuto | spento | troppe | senza_allegati.
 */
async function ricevi({ token, da, oggetto, files = [] }, opts = {}) {
  const { data: c } = await supabase.from('imprese_email_indirizzi').select('company_id').eq('token', String(token || '').toLowerCase()).maybeSingle();
  if (!c) return { esito: 'sconosciuto' };
  const companyId = c.company_id;
  if (!(await isFeatureEnabled(companyId, 'subappaltatori').catch(() => false))) return { esito: 'spento', companyId };

  const ieri = new Date(Date.now() - 864e5).toISOString();
  const { count } = await supabase.from('imprese_caricamenti').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('origine', 'email').gte('created_at', ieri);
  if ((count || 0) >= MAX_EMAIL_AL_GIORNO) return { esito: 'troppe', companyId };

  const buoni = files.filter(documento).slice(0, MAX_ALLEGATI);
  if (!buoni.length) return { esito: 'senza_allegati', companyId };

  const { id } = await K.crea(companyId, null, {});
  const { error } = await supabase.from('imprese_caricamenti')
    .update({ origine: 'email', email_da: mittente(da), email_oggetto: String(oggetto || '').slice(0, 300) || null }).eq('id', id);
  if (error) throw new Error(error.message);
  const male = [];
  for (const [i, f] of buoni.entries()) {
    // la lettura parte una volta sola, dopo l'ultimo file
    const ultimo = i === buoni.length - 1;
    try { await K.aggiungi(companyId, id, f, { ...opts, senzaLavoro: opts.senzaLavoro || !ultimo }); }
    catch (err) { male.push(`${f.originalname}: ${err.code || err.message}`); }
  }
  if (male.length && !opts.senzaLavoro) K.lavora(companyId, id, opts).catch(err => console.error('[impreseEmail] lavora:', err.message));
  supabase.from('admin_audit_log').insert([{
    company_id: companyId, user_id: null, user_role: 'email', action: 'imprese.email_ricevuta',
    target_type: 'imprese_caricamento', target_id: id,
    payload: { da: mittente(da), oggetto: String(oggetto || '').slice(0, 300), allegati: files.length, documenti: buoni.length, non_caricati: male },
  }]).then(({ error: e }) => { if (e) console.error('[impreseEmail] audit:', e.message); });
  return { esito: 'ricevuto', companyId, caricamentoId: id, documenti: buoni.length - male.length };
}

/** Le email arrivate e non ancora salvate, dalla più recente. */
async function arrivati(companyId) {
  const { data, error } = await supabase.from('imprese_caricamenti').select('id, created_at, email_da, email_oggetto')
    .eq('company_id', companyId).eq('origine', 'email').is('salvato_at', null).order('created_at', { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  if (!data?.length) return [];
  const { data: righe } = await supabase.from('imprese_caricamento_doc').select('caricamento_id, livello, stato')
    .in('caricamento_id', data.map(d => d.id));
  return data.map(d => {
    const mie = (righe || []).filter(r => r.caricamento_id === d.id);
    const docs = mie.filter(r => r.livello === 'documento' && r.stato !== 'scartato');
    return {
      id: d.id, arrivato: d.created_at, da: d.email_da, oggetto: d.email_oggetto,
      file: mie.filter(r => r.livello === 'file').length,
      documenti: docs.length,
      inLettura: mie.some(r => r.stato === 'in_coda' || r.stato === 'in_lettura'),
    };
  }).filter(d => d.file > 0);
}

module.exports = { indirizzo, ricevi, arrivati, eDocumenti, PREFISSO };
