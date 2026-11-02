'use strict';
// ── Il PSC del coordinatore, letto e confrontato con il tuo POS (F-426) ───────
// Il PSC del cantiere (site_documents 'psc', l'ultimo PDF caricato) si legge con
// lib/pscExtract.js una volta sola per file e la lettura si salva in psc_letture:
// la usano la pagina «Il PSC del coordinatore», la catena della sicurezza
// (lib/sicurezzaCantieri.js), Oggi e il POS rapido.
// Copertura delle richieste del PSC nel tuo POS, senza IA:
//   nel_pos           — il tuo ultimo POS fatto con Palladia contiene la richiesta
//                       (pos_data.pscRichieste: un POS fatto con il PSC le ha tutte)
//   manca             — il POS è stato fatto senza questo PSC: «Aggiungile al POS»
//                       lo rifà come revisione, con il PSC dentro
//   non_controllabile — il tuo POS è un file caricato: non lo possiamo leggere
//   senza_pos         — il tuo POS non c'è ancora
// La lettura gira nel processo (come lib/impreseCarica): chi apre la pagina riceve
// «in_lettura» e ripassa; un errore resta per 10 minuti, poi si riprova.
const supabase = require('./supabase');
const logger = require('./logger');
const { extractPsc } = require('./pscExtract');

class PscError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const dbErr = (e) => { if (e) throw new Error(e.message); };
const norma = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const inCorso = new Map();   // site_document_id → Promise
const errori = new Map();    // site_document_id → { at, messaggio }

/** L'ultimo PSC (PDF) caricato nel cantiere. */
async function ultimoPsc(companyId, siteId) {
  const { data, error } = await supabase.from('site_documents').select('id, name, created_at, mime_type')
    .eq('company_id', companyId).eq('site_id', siteId).eq('category', 'psc').eq('mime_type', 'application/pdf')
    .order('created_at', { ascending: false }).limit(1);
  dbErr(error);
  return data?.[0] || null;
}

async function letturaSalvata(docId) {
  const { data, error } = await supabase.from('psc_letture').select('dati, created_at').eq('site_document_id', docId).maybeSingle();
  dbErr(error);
  return data || null;
}

/** Legge il PSC (una volta per file) e salva la lettura. */
function leggi(companyId, siteId, doc, deps = {}) {
  if (inCorso.has(doc.id)) return inCorso.get(doc.id);
  const p = (async () => {
    try {
      const { data: co } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
      const dati = await extractPsc(companyId, { siteId, documentId: doc.id, impresaName: co?.name || 'impresa esecutrice', lavori: '' }, deps);
      if (!dati.isPsc) throw Object.assign(new Error('NON_E_UN_PSC'), { status: 422 });
      const { error } = await supabase.from('psc_letture').upsert({ company_id: companyId, site_id: siteId, site_document_id: doc.id, dati }, { onConflict: 'site_document_id' });
      dbErr(error);
      errori.delete(doc.id);
      return dati;
    } catch (err) {
      errori.set(doc.id, { at: Date.now(), messaggio: err.message === 'NON_E_UN_PSC' ? 'Questo documento non sembra un PSC' : 'Non sono riuscito a leggere il PSC' });
      logger.warn({ err: err.message, siteId }, 'psc letto: lettura fallita');
      return null;
    } finally { inCorso.delete(doc.id); }
  })();
  inCorso.set(doc.id, p);
  return p;
}

/** Il tuo ultimo POS: fatto con Palladia (con le richieste del PSC che contiene) o caricato come file. */
async function tuoPos(companyId, siteId) {
  const [posR, fileR] = await Promise.all([
    supabase.from('pos_documents').select('id, revision, created_at, pos_data').eq('company_id', companyId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(20),
    supabase.from('site_documents').select('id, created_at').eq('company_id', companyId).eq('site_id', siteId).eq('category', 'pos').limit(1),
  ]);
  dbErr(posR.error); dbErr(fileR.error);
  const mio = (posR.data || []).find(d => !d.pos_data?.subcontractorId);
  if (mio) return { stato: 'palladia', posId: mio.id, revisione: mio.revision, data: mio.created_at.slice(0, 10), dentro: new Set((mio.pos_data?.pscRichieste || []).map(r => norma(r.titolo))) };
  if (fileR.data?.length) return { stato: 'file', data: fileR.data[0].created_at.slice(0, 10) };
  return { stato: 'manca' };
}

/** Le richieste del PSC con lo stato rispetto al tuo POS. */
function copertura(richieste, pos) {
  const out = richieste.map(r => ({
    titolo: r.titolo, dettaglio: r.dettaglio || '', pagina: r.pagina ?? null,
    stato: pos.stato === 'palladia' ? (pos.dentro.has(norma(r.titolo)) ? 'nel_pos' : 'manca') : pos.stato === 'file' ? 'non_controllabile' : 'senza_pos',
  }));
  return { richieste: out, mancano: pos.stato === 'palladia' ? out.filter(r => r.stato === 'manca').length : null };
}

/**
 * La pagina «Il PSC del coordinatore». Stato: nessuno | in_lettura | errore | letto.
 * Con attendi=true aspetta la lettura (per i test); altrimenti la avvia e risponde subito.
 */
async function scheda(companyId, siteId, { deps = {}, attendi = false } = {}) {
  const { data: site, error } = await supabase.from('sites').select('id, name').eq('company_id', companyId).eq('id', siteId).maybeSingle();
  dbErr(error);
  if (!site) throw new PscError(404, 'NOT_FOUND');
  const doc = await ultimoPsc(companyId, siteId);
  const pos = await tuoPos(companyId, siteId);
  const posPub = { stato: pos.stato, posId: pos.posId || null, revisione: pos.revisione ?? null, data: pos.data || null };
  const base = { cantiere: { id: site.id, nome: site.name }, pos: posPub };
  if (!doc) return { ...base, stato: 'nessuno', doc: null, richieste: [], mancano: null };
  const docPub = { id: doc.id, nome: doc.name, data: doc.created_at.slice(0, 10) };
  let salvata = await letturaSalvata(doc.id);
  if (!salvata) {
    const err = errori.get(doc.id);
    if (err && Date.now() - err.at < 10 * 60 * 1000 && !attendi) return { ...base, stato: 'errore', errore: err.messaggio, doc: docPub, richieste: [], mancano: null };
    const p = leggi(companyId, siteId, doc, deps);
    if (!attendi) return { ...base, stato: 'in_lettura', doc: docPub, richieste: [], mancano: null };
    await p;
    salvata = await letturaSalvata(doc.id);
    if (!salvata) return { ...base, stato: 'errore', errore: errori.get(doc.id)?.messaggio || 'Non sono riuscito a leggere il PSC', doc: docPub, richieste: [], mancano: null };
  }
  const d = salvata.dati;
  return {
    ...base, stato: 'letto', doc: { ...docPub, pagine: d.numPages || null },
    riferimento: d.riferimento || '', committente: d.committente || '', cse: d.cse?.nome || '',
    ...copertura(d.richieste || [], pos),
    dati: d,
  };
}

/** Per la catena e Oggi, senza IA: per cantiere {chiede, mancano} dalla lettura salvata del PSC più recente. */
async function coperturePerCantiere(companyId, siteIds) {
  const out = new Map();
  if (!siteIds.length) return out;
  const [docR, letR, posR] = await Promise.all([
    supabase.from('site_documents').select('id, site_id, created_at').eq('company_id', companyId).eq('category', 'psc').eq('mime_type', 'application/pdf').in('site_id', siteIds).order('created_at', { ascending: false }),
    supabase.from('psc_letture').select('site_document_id, site_id, dati').eq('company_id', companyId).in('site_id', siteIds),
    supabase.from('pos_documents').select('site_id, created_at, pos_data').eq('company_id', companyId).in('site_id', siteIds).order('created_at', { ascending: false }),
  ]);
  for (const r of [docR, letR, posR]) dbErr(r.error);
  const ultimo = new Map();
  for (const d of docR.data || []) if (!ultimo.has(d.site_id)) ultimo.set(d.site_id, d.id);
  const lett = new Map((letR.data || []).map(l => [l.site_document_id, l.dati]));
  const mio = new Map();
  for (const p of posR.data || []) if (!p.pos_data?.subcontractorId && !mio.has(p.site_id)) mio.set(p.site_id, p);
  for (const sid of siteIds) {
    const dati = lett.get(ultimo.get(sid));
    if (!dati) continue;
    const p = mio.get(sid);
    const pos = p ? { stato: 'palladia', dentro: new Set((p.pos_data?.pscRichieste || []).map(r => norma(r.titolo))) } : { stato: 'altro' };
    const c = copertura(dati.richieste || [], pos);
    out.set(sid, { chiede: c.richieste.length, mancano: c.mancano, primaMancante: c.richieste.find(r => r.stato === 'manca')?.titolo || null });
  }
  return out;
}

/** Dopo il caricamento di un PSC: lo legge subito, senza far aspettare nessuno. */
function avvia(companyId, siteId) {
  ultimoPsc(companyId, siteId).then(doc => (doc ? letturaSalvata(doc.id).then(s => (s ? null : leggi(companyId, siteId, doc))) : null))
    .catch(err => logger.warn({ err: err.message, siteId }, 'psc letto: avvio fallito'));
}

module.exports = { scheda, coperturePerCantiere, avvia, PscError };
