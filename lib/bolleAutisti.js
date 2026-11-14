'use strict';
/**
 * lib/bolleAutisti.js — F-500 (AUDIT.md del frontend): le bolle dei nostri autisti.
 * Disegno approvato il 14/11: https://claude.ai/artifact/LPH4yjojwZ2reVsnJ8Jhry
 *
 * L'autista fotografa la bolla dal badge (una o più pagine) e la manda: niente
 * modulo da compilare. Qui:
 *  - leggo fornitore, numero, data, destinazione e materiali (lib/impreseCarica/lettura);
 *  - il cantiere: quello scelto dall'autista, se no dove ha timbrato oggi, se no
 *    la destinazione scritta sulla bolla, se no nessuno (decide l'ufficio);
 *  - doppioni: lo stesso invio ripetuto senza rete (client_id), la stessa foto
 *    (content_hash) o lo stesso fornitore e numero → «c'è già», non due bolle;
 *  - se qualcosa non si legge, la bolla va «da controllare» con i dubbi; la foto
 *    non si perde mai, nemmeno se la lettura fallisce.
 * Finisce nella tabella `bolle` come quelle di «Carica»: Bolle del cantiere e
 * confronto con la fattura le vedono tutte.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { leggiPagine } = require('./impreseCarica/lettura');
const { cantierePer } = require('./impreseCarica/attribuisci');

const BUCKET = 'site-documents';
const MAX_PAGINE = 6;
const TIPI_FILE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
class BolleAutistiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const romaGiorno = (ts = Date.now()) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Il cantiere dove l'autista ha timbrato oggi (l'ultimo evento di oggi). */
async function cantiereDiOggi(worker) {
  const { data } = await supabase.from('presence_logs').select('site_id, timestamp_server')
    .eq('worker_id', worker.id).eq('company_id', worker.company_id)
    .gte('timestamp_server', `${romaGiorno()}T00:00:00+02:00`).order('timestamp_server', { ascending: false }).limit(5);
  const oggi = (data || []).find(l => l.site_id && romaGiorno(l.timestamp_server) === romaGiorno());
  return oggi?.site_id || null;
}

async function cantieriAperti(worker) {
  const [{ data: sites, error }, { data: miei }] = await Promise.all([
    supabase.from('sites').select('id, name, address').eq('company_id', worker.company_id).eq('status', 'attivo').order('name').limit(60),
    supabase.from('worksite_workers').select('site_id').eq('worker_id', worker.id).eq('status', 'active'),
  ]);
  dbErr(error);
  const assegnati = new Set((miei || []).map(m => m.site_id));
  return (sites || []).map(s => ({ id: s.id, nome: s.name, indirizzo: s.address || null, mio: assegnati.has(s.id) }))
    .sort((a, b) => Number(b.mio) - Number(a.mio));
}

/** Quello che serve alla pagina «Fotografa la bolla». */
async function info(worker) {
  const [{ data: w }, cantieri, oggiId, { data: mie }] = await Promise.all([
    supabase.from('workers').select('full_name').eq('id', worker.id).maybeSingle(),
    cantieriAperti(worker),
    cantiereDiOggi(worker),
    supabase.from('bolle').select('id, fornitore, numero, created_at, site_id, stato').eq('worker_id', worker.id)
      .gte('created_at', `${romaGiorno()}T00:00:00+02:00`).neq('stato', 'scartata').order('created_at', { ascending: false }).limit(20),
  ]);
  const nomeDi = (id) => cantieri.find(c => c.id === id)?.nome || null;
  return {
    nome: w?.full_name || null,
    cantiereOggi: oggiId ? { id: oggiId, nome: nomeDi(oggiId) } : null,
    cantieri: cantieri.map(({ id, nome, indirizzo }) => ({ id, nome, indirizzo })),
    oggi: (mie || []).filter(b => romaGiorno(b.created_at) === romaGiorno()).map(b => ({ id: b.id, fornitore: b.fornitore, numero: b.numero, cantiere: nomeDi(b.site_id), ora: new Date(b.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }) })),
  };
}

/** I campi da guardare: quelli che non si leggono. */
function dubbiDi(letto, siteId) {
  if (!letto) return ['lettura'];
  const d = [];
  if (letto.tipo !== 'bolla') d.push('tipo');
  if (!letto.ragioneSociale) d.push('fornitore');
  if (!letto.numero) d.push('numero');
  if (!letto.dataDocumento) d.push('data');
  if (!letto.righe?.length) d.push('materiali');
  if (!siteId) d.push('cantiere');
  return d;
}

/**
 * L'autista manda la bolla.
 * files: [{ buffer, mimetype, originalname }] (1–6 pagine); siteId: scelto da lui (facoltativo);
 * clientId: lo stesso a ogni nuovo tentativo dallo stesso telefono (senza rete).
 */
async function manda(worker, { files, siteId, clientId }, { leggi = leggiPagine } = {}) {
  const pagine = (files || []).filter(f => f?.buffer?.length);
  if (!pagine.length) throw new BolleAutistiError(400, 'FOTO_MANCANTE');
  if (pagine.length > MAX_PAGINE) throw new BolleAutistiError(400, 'TROPPE_PAGINE');
  if (pagine.some(f => !TIPI_FILE[f.mimetype])) throw new BolleAutistiError(400, 'FILE_NON_VALIDO');
  const cid = clientId ? String(clientId).slice(0, 64) : null;
  const companyId = worker.company_id;

  // Lo stesso invio ripetuto (la rete è tornata): la bolla c'è già
  if (cid) {
    const { data: gia } = await supabase.from('bolle').select('id, site_id, stato').eq('company_id', companyId).eq('client_id', cid).maybeSingle();
    if (gia) return { id: gia.id, doppione: false, stessoInvio: true, stato: gia.stato, cantiere: await nomeCantiere(gia.site_id) };
  }
  const hash = crypto.createHash('sha256').update(pagine[0].buffer).digest('hex');
  {
    const { data: gia } = await supabase.from('bolle').select('id, site_id').eq('company_id', companyId).eq('content_hash', hash).neq('stato', 'scartata').limit(1);
    if (gia?.length) return { id: gia[0].id, doppione: true, cantiere: await nomeCantiere(gia[0].site_id) };
  }

  // Il cantiere scelto dall'autista deve essere dell'azienda
  let site = null, cantiereDa = null;
  if (siteId) {
    if (!UUID.test(String(siteId))) throw new BolleAutistiError(400, 'CANTIERE_NON_VALIDO');
    const { data } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
    if (!data) throw new BolleAutistiError(400, 'CANTIERE_NON_VALIDO');
    site = data.id; cantiereDa = 'autista';
  }
  if (!site) { const t = await cantiereDiOggi(worker); if (t) { site = t; cantiereDa = 'timbratura'; } }

  // La lettura: se fallisce (rete del modello, credito) la bolla si salva lo stesso, da controllare
  let letto = null;
  try { letto = await leggi({ pagine: pagine.map(f => ({ buffer: f.buffer, mimetype: f.mimetype })), companyId, userId: null }); } catch { letto = null; }
  if (!site && letto) {
    const cantieri = (await cantieriAperti(worker)).map(c => ({ id: c.id, nome: c.nome, indirizzo: c.indirizzo }));
    const s = cantierePer(letto, cantieri);
    if (s && letto.cantiere) { site = s; cantiereDa = 'bolla'; }
  }

  // Stesso fornitore e stesso numero: è la stessa bolla
  if (letto?.numero && (letto.piva || letto.ragioneSociale)) {
    let q = supabase.from('bolle').select('id, site_id').eq('company_id', companyId).eq('numero', letto.numero).neq('stato', 'scartata').limit(1);
    q = letto.piva ? q.eq('fornitore_piva', letto.piva) : q.ilike('fornitore', letto.ragioneSociale);
    const { data: gia } = await q;
    if (gia?.length) return { id: gia[0].id, doppione: true, cantiere: await nomeCantiere(gia[0].site_id) };
  }

  // Le foto, poi la riga
  const salvate = [];
  try {
    for (let i = 0; i < pagine.length; i++) {
      const f = pagine[i];
      const path = `${companyId}/bolle/${crypto.randomUUID()}-p${i + 1}.${TIPI_FILE[f.mimetype]}`;
      const up = await supabase.storage.from(BUCKET).upload(path, f.buffer, { contentType: f.mimetype, upsert: false });
      if (up.error) throw new Error(up.error.message);
      salvate.push({ path, mime: f.mimetype });
    }
    const dubbi = dubbiDi(letto, site);
    const { data, error } = await supabase.from('bolle').insert({
      company_id: companyId, site_id: site, worker_id: worker.id, origine: 'badge', cantiere_da: cantiereDa,
      fornitore: letto?.ragioneSociale || null, fornitore_piva: letto?.piva || null, numero: letto?.numero || null,
      data: letto?.dataDocumento || null, firmata: letto?.firmato ?? null, righe: letto?.righe || [],
      file_path: salvate[0].path, mime_type: salvate[0].mime, pagine: salvate, content_hash: hash,
      stato: dubbi.length ? 'da_controllare' : 'a_posto', dubbi, client_id: cid,
    }).select('id, stato').single();
    if (error) {
      if (error.code === '23505' && cid) {
        const { data: gia } = await supabase.from('bolle').select('id, site_id, stato').eq('company_id', companyId).eq('client_id', cid).maybeSingle();
        await supabase.storage.from(BUCKET).remove(salvate.map(s => s.path)).catch(() => {});
        if (gia) return { id: gia.id, doppione: false, stessoInvio: true, stato: gia.stato, cantiere: await nomeCantiere(gia.site_id) };
      }
      throw new Error(error.message);
    }
    return { id: data.id, doppione: false, stato: data.stato, cantiere: await nomeCantiere(site), cantiereDa };
  } catch (e) {
    if (salvate.length) await supabase.storage.from(BUCKET).remove(salvate.map(s => s.path)).catch(() => {});
    throw e;
  }
}

/**
 * Dopo l'invio, se il cantiere non si è capito: l'autista lo sceglie dalla lista.
 * Solo le sue bolle di oggi ancora senza cantiere.
 */
async function scegliCantiere(worker, id, siteId) {
  if (!UUID.test(String(id || ''))) throw new BolleAutistiError(404, 'NOT_FOUND');
  if (!UUID.test(String(siteId || ''))) throw new BolleAutistiError(400, 'CANTIERE_NON_VALIDO');
  const { data: b } = await supabase.from('bolle').select('id, site_id, dubbi, created_at').eq('id', id)
    .eq('company_id', worker.company_id).eq('worker_id', worker.id).maybeSingle();
  if (!b || romaGiorno(b.created_at) !== romaGiorno()) throw new BolleAutistiError(404, 'NOT_FOUND');
  if (b.site_id) throw new BolleAutistiError(409, 'CANTIERE_GIA_SCELTO');
  const { data: s } = await supabase.from('sites').select('id, name').eq('id', siteId).eq('company_id', worker.company_id).neq('status', 'eliminato').maybeSingle();
  if (!s) throw new BolleAutistiError(400, 'CANTIERE_NON_VALIDO');
  const dubbi = (Array.isArray(b.dubbi) ? b.dubbi : []).filter(d => d !== 'cantiere');
  const patch = { site_id: s.id, cantiere_da: 'autista', dubbi };
  if (!dubbi.length) patch.stato = 'a_posto';
  const { error } = await supabase.from('bolle').update(patch).eq('id', b.id).eq('company_id', worker.company_id).is('site_id', null);
  dbErr(error);
  return { id: b.id, cantiere: s.name };
}

async function nomeCantiere(siteId) {
  if (!siteId) return null;
  const { data } = await supabase.from('sites').select('name').eq('id', siteId).maybeSingle();
  return data?.name || null;
}

module.exports = { info, manda, scegliCantiere, dubbiDi, cantiereDiOggi, BolleAutistiError, MAX_PAGINE };
