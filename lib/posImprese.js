'use strict';
// ── Il POS di un'impresa, controllato dall'impresa principale (F-427) ─────────
// Prima di mandarlo al coordinatore l'impresa principale controlla il POS di ogni
// impresa in subappalto (art. 97 c. 3-ter D.Lgs. 81/2008). Il controllo è quello
// che fa il coordinatore (lib/psc/posVerify.js): contenuti minimi dell'Allegato XV,
// prescrizioni del PSC recepite (dalla lettura salvata del PSC, lib/pscLetto.js),
// abilitazioni per le attrezzature, verifiche periodiche. Si fa una volta per file
// (pos_controlli) e in background; un POS fatto con Palladia non si rilegge.
// «Non torna» solo se manca qualcosa (esito 'manca'); «da verificare» non blocca.
const supabase = require('./supabase');
const logger = require('./logger');
const { verifica } = require('./psc/posVerify');

const BUCKET = 'site-documents';
class PosImpreseError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const dbErr = (e) => { if (e) throw new Error(e.message); };
const inCorso = new Map();  // subcontractor_document_id → Promise
const errori = new Map();   // subcontractor_document_id → { at, messaggio }

async function contesto(companyId, siteId, subId) {
  const [siteR, subR, coR, linkR] = await Promise.all([
    supabase.from('sites').select('id, name').eq('company_id', companyId).eq('id', siteId).maybeSingle(),
    supabase.from('subcontractors').select('id, company_name, phone, email').eq('company_id', companyId).eq('id', subId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    supabase.from('site_subcontractors').select('site_id').eq('company_id', companyId).eq('site_id', siteId).eq('subcontractor_id', subId).limit(1),
  ]);
  for (const r of [siteR, subR, linkR]) dbErr(r.error);
  if (!siteR.data || !subR.data || !linkR.data?.length) throw new PosImpreseError(404, 'NOT_FOUND');
  return { site: siteR.data, sub: subR.data, azienda: coR.data?.name || '' };
}

/** L'ultimo POS dell'impresa per il cantiere: fatto con Palladia o mandato come file. */
async function ultimoPos(companyId, siteId, subId) {
  const [palR, fileR] = await Promise.all([
    supabase.from('pos_documents').select('id, created_at, pos_data').eq('company_id', companyId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(50),
    supabase.from('subcontractor_documents').select('id, name, file_path, mime_type, created_at').eq('company_id', companyId).eq('subcontractor_id', subId).eq('site_id', siteId).eq('category', 'pos').order('created_at', { ascending: false }).limit(1),
  ]);
  dbErr(palR.error); dbErr(fileR.error);
  const pal = (palR.data || []).find(d => d.pos_data?.subcontractorId === subId) || null;
  const file = fileR.data?.[0] || null;
  if (pal && (!file || pal.created_at >= file.created_at)) return { tipo: 'palladia', id: pal.id, data: pal.created_at.slice(0, 10) };
  if (file) return { tipo: 'file', ...file, data: file.created_at.slice(0, 10) };
  return null;
}

/** Le prescrizioni del PSC del cantiere (dalla lettura salvata), nella forma di posVerify. */
async function prescrizioni(companyId, siteId) {
  const { data } = await supabase.from('psc_letture').select('dati, created_at').eq('company_id', companyId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(1);
  const d = data?.[0]?.dati;
  if (!d) return [];
  return [...(d.richieste || []), ...(d.interferenze || [])].slice(0, 16)
    .map((r, i) => ({ id: `p${i}`, titolo: r.titolo, testo: r.dettaglio || r.titolo, paginaPsc: r.pagina ?? null }));
}

function leggi(companyId, ctx, doc, deps = {}) {
  if (inCorso.has(doc.id)) return inCorso.get(doc.id);
  const p = (async () => {
    try {
      const buffer = deps.download ? await deps.download(doc.file_path)
        : Buffer.from(await (await supabase.storage.from(BUCKET).download(doc.file_path)).data.arrayBuffer());
      const presc = await prescrizioni(companyId, ctx.site.id);
      const out = await verifica({ buffer, mime: doc.mime_type || 'application/pdf', companyId, impresa: ctx.sub.company_name, lavorazioniImpresa: [], prescrizioni: presc }, deps.ai ? { ai: deps.ai } : {});
      if (!out.isPos) throw Object.assign(new Error('NON_E_UN_POS'), { status: 422 });
      // La pagina del PSC accanto alle prescrizioni non recepite
      const controlli = out.checks.map(c => {
        const pr = c.key.startsWith('presc_') ? presc.find(x => `presc_${x.id}` === c.key) : null;
        return { ...c, paginaPsc: pr?.paginaPsc ?? null };
      });
      const esito = controlli.some(c => c.esito === 'manca') ? 'non_torna' : 'torna';
      const { error } = await supabase.from('pos_controlli').upsert({ company_id: companyId, site_id: ctx.site.id, subcontractor_id: ctx.sub.id, subcontractor_document_id: doc.id, esito, controlli }, { onConflict: 'subcontractor_document_id' });
      dbErr(error);
      errori.delete(doc.id);
    } catch (err) {
      errori.set(doc.id, { at: Date.now(), messaggio: err.message === 'NON_E_UN_POS' ? 'Questo documento non sembra un POS' : 'Non sono riuscito a leggere il POS' });
      logger.warn({ err: err.message, siteId: ctx.site.id }, 'pos imprese: controllo fallito');
    } finally { inCorso.delete(doc.id); }
  })();
  inCorso.set(doc.id, p);
  return p;
}

function messaggio({ impresa, cantiere, azienda, controlli }) {
  const problemi = controlli.filter(c => c.esito === 'manca');
  const righe = problemi.map(c => `- ${c.titolo}${c.pagina ? ` (vostro POS, pag. ${c.pagina})` : ''}${c.paginaPsc ? ` (PSC pag. ${c.paginaPsc})` : ''}`).join('\n');
  return `Buongiorno ${impresa},\nho controllato il vostro POS per ${cantiere} con il nostro POS e con il PSC. Prima di mandarlo al coordinatore vi chiedo di integrarlo con:\n${righe}\n\nPotete rimandarlo dallo stesso link.\nGrazie,\n${azienda}`;
}

/** La pagina del controllo. Stato: nessuno | in_lettura | errore | letto | palladia. */
async function controllo(companyId, siteId, subId, { deps = {}, attendi = false } = {}) {
  const ctx = await contesto(companyId, siteId, subId);
  const base = { cantiere: { id: ctx.site.id, nome: ctx.site.name }, impresa: { id: ctx.sub.id, nome: ctx.sub.company_name } };
  const doc = await ultimoPos(companyId, siteId, subId);
  if (!doc) return { ...base, stato: 'nessuno', doc: null, controlli: [] };
  if (doc.tipo === 'palladia') return { ...base, stato: 'palladia', esito: 'torna', titolo: 'Fatto con Palladia', doc: { id: doc.id, data: doc.data }, controlli: [] };
  const docPub = { id: doc.id, nome: doc.name, data: doc.data };
  const cerca = () => supabase.from('pos_controlli').select('esito, controlli, accettato_at').eq('subcontractor_document_id', doc.id).maybeSingle().then(r => { dbErr(r.error); return r.data; });
  let c = await cerca();
  if (!c) {
    const err = errori.get(doc.id);
    if (err && Date.now() - err.at < 10 * 60 * 1000 && !attendi) return { ...base, stato: 'errore', errore: err.messaggio, doc: docPub, controlli: [] };
    const p = leggi(companyId, ctx, doc, deps);
    if (!attendi) return { ...base, stato: 'in_lettura', doc: docPub, controlli: [] };
    await p;
    c = await cerca();
    if (!c) return { ...base, stato: 'errore', errore: errori.get(doc.id)?.messaggio || 'Non sono riuscito a leggere il POS', doc: docPub, controlli: [] };
  }
  const ordine = { manca: 0, da_verificare: 1, ok: 2 };
  const controlli = [...c.controlli].sort((a, b) => (ordine[a.esito] ?? 3) - (ordine[b.esito] ?? 3));
  // La cosa più grave prima: un'abilitazione che manca, poi il resto
  const peggio = controlli.filter(x => x.esito === 'manca').sort((a, b) => (b.key.startsWith('abil_') ? 1 : 0) - (a.key.startsWith('abil_') ? 1 : 0))[0];
  const testo = c.esito === 'non_torna' ? messaggio({ impresa: ctx.sub.company_name, cantiere: ctx.site.name, azienda: ctx.azienda, controlli }) : null;
  const tel = String(ctx.sub.phone || '').replace(/\D/g, '');
  return {
    ...base, stato: 'letto', doc: docPub, esito: c.esito, accettato: !!c.accettato_at,
    titolo: peggio ? peggio.titolo : 'Torna su tutto', controlli,
    chiedi: testo ? {
      testo,
      whatsapp: `https://wa.me/${tel ? (tel.startsWith('39') ? tel : `39${tel}`) : ''}?text=${encodeURIComponent(testo)}`,
      email: `mailto:${ctx.sub.email || ''}?subject=${encodeURIComponent(`POS per ${ctx.site.name}: da integrare`)}&body=${encodeURIComponent(testo)}`,
    } : null,
  };
}

/** «Va bene così»: la decisione è del titolare. */
async function vaBene(companyId, siteId, subId) {
  await contesto(companyId, siteId, subId);
  const doc = await ultimoPos(companyId, siteId, subId);
  if (!doc || doc.tipo !== 'file') throw new PosImpreseError(404, 'NOT_FOUND');
  const { error } = await supabase.from('pos_controlli').update({ accettato_at: new Date().toISOString() }).eq('subcontractor_document_id', doc.id).eq('company_id', companyId);
  dbErr(error);
  return { ok: true };
}

/** Per la catena e Oggi: subcontractor_document_id → { esito, accettato, titolo }. */
async function controlliPerDocumenti(companyId, docIds) {
  const out = new Map();
  if (!docIds.length) return out;
  const { data, error } = await supabase.from('pos_controlli').select('subcontractor_document_id, esito, accettato_at, controlli').eq('company_id', companyId).in('subcontractor_document_id', docIds);
  dbErr(error);
  for (const c of data || []) {
    const m = (c.controlli || []).find(x => x.esito === 'manca');
    out.set(c.subcontractor_document_id, { esito: c.esito, accettato: !!c.accettato_at, titolo: m?.titolo || null });
  }
  return out;
}

/** Dopo che arriva il POS di un'impresa: lo controlla subito, senza far aspettare nessuno. */
function avvia(companyId, siteId, subId) {
  controllo(companyId, siteId, subId).catch(err => logger.warn({ err: err.message, siteId }, 'pos imprese: avvio fallito'));
}

module.exports = { controllo, vaBene, controlliPerDocumenti, avvia, PosImpreseError };
