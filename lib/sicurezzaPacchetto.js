'use strict';
// ── La sicurezza del cantiere mandata al coordinatore (F-428) ─────────────────
// «Manda al coordinatore»: un link senza registrazione con il tuo POS e i POS delle
// imprese a posto (dal link o fatti con Palladia, e che tornano col controllo
// dell'impresa principale, F-427, o che il titolare ha accettato). Quelli che non
// tornano restano fuori, «in attesa». Il contenuto si ferma al momento dell'invio;
// il coordinatore li apre uno per uno o tutti in un PDF. È anche la porta con cui i
// coordinatori esterni conoscono Palladia («Fai i PSC con Palladia»).
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const supabase = require('./supabase');
const { controlliPerDocumenti } = require('./posImprese');

const BUCKET = 'site-documents';
class PacchettoError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const dbErr = (e) => { if (e) throw new Error(e.message); };
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const base = () => (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
const giorno = (iso) => new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'Europe/Rome' });

/** Cosa si può mandare adesso: il tuo POS e i POS delle imprese a posto. */
async function daMandare(companyId, siteId) {
  const [siteR, coR, posR, fileR, assR, subDocR, letR] = await Promise.all([
    supabase.from('sites').select('id, name').eq('company_id', companyId).eq('id', siteId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    supabase.from('pos_documents').select('id, revision, created_at, pos_data').eq('company_id', companyId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(50),
    supabase.from('site_documents').select('id, name, created_at').eq('company_id', companyId).eq('site_id', siteId).eq('category', 'pos').order('created_at', { ascending: false }).limit(1),
    supabase.from('site_subcontractors').select('subcontractor_id, subcontractors(id, company_name, is_active)').eq('company_id', companyId).eq('site_id', siteId),
    supabase.from('subcontractor_documents').select('id, subcontractor_id, esito, dall_impresa, created_at').eq('company_id', companyId).eq('site_id', siteId).eq('category', 'pos').order('created_at', { ascending: false }),
    supabase.from('psc_letture').select('dati, created_at').eq('company_id', companyId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(1),
  ]);
  for (const r of [siteR, posR, fileR, assR, subDocR, letR]) dbErr(r.error);
  if (!siteR.data) throw new PacchettoError(404, 'NOT_FOUND');
  const pos = posR.data || [];
  const mio = pos.find(p => !p.pos_data?.subcontractorId);
  const contenuto = [];
  if (mio) contenuto.push({ tipo: 'tuo', posId: mio.id, revisione: mio.revision, richieste: (mio.pos_data?.pscRichieste || []).length });
  else if (fileR.data?.length) contenuto.push({ tipo: 'tuo', docId: fileR.data[0].id });
  if (!contenuto.length) throw new PacchettoError(400, 'SENZA_POS');

  const ultimo = new Map();
  for (const d of subDocR.data || []) if (!ultimo.has(d.subcontractor_id)) ultimo.set(d.subcontractor_id, d);
  const ctl = await controlliPerDocumenti(companyId, [...ultimo.values()].map(d => d.id));
  const inAttesa = [];
  const visti = new Set();
  for (const a of (assR.data || []).sort((x, y) => (x.subcontractors?.company_name || '').localeCompare(y.subcontractors?.company_name || '', 'it'))) {
    const sub = a.subcontractors;
    if (!sub || sub.is_active === false || visti.has(sub.id)) continue;
    visti.add(sub.id);
    const fatto = pos.find(p => p.pos_data?.subcontractorId === sub.id);
    const u = ultimo.get(sub.id);
    if (fatto && (!u || fatto.created_at >= u.created_at)) { contenuto.push({ tipo: 'impresa', nome: sub.company_name, posId: fatto.id, revisione: fatto.revision }); continue; }
    const c = u && ctl.get(u.id);
    const buono = u && u.esito !== 'non_va' && !(u.esito === null && u.dall_impresa) && (!c || c.esito === 'torna' || c.accettato);
    if (buono) contenuto.push({ tipo: 'impresa', nome: sub.company_name, docId: u.id, controllatoIl: c ? true : null });
    else inAttesa.push(sub.company_name);
  }
  const cse = letR.data?.[0]?.dati?.cse?.nome || null;
  return { site: siteR.data, azienda: coR.data?.name || '', contenuto, inAttesa, cse };
}

/** «Manda al coordinatore»: crea il link e il messaggio pronto. */
async function crea(companyId, userId, siteId) {
  const x = await daMandare(companyId, siteId);
  const token = crypto.randomBytes(24).toString('base64url');
  const { error } = await supabase.from('pacchetti_sicurezza').insert({
    company_id: companyId, site_id: siteId, token_hash: hash(token), destinatario: x.cse,
    contenuto: x.contenuto.map((c, i) => ({ ...c, chiave: `d${i}` })), in_attesa: x.inAttesa, created_by: userId || null,
  });
  dbErr(error);
  const url = `${base()}/sicurezza-per/${token}`;
  const imprese = x.contenuto.filter(c => c.tipo === 'impresa').map(c => c.nome);
  const testo = `Buongiorno${x.cse ? ` ${x.cse}` : ''}, sono di ${x.azienda}. Qui c'è il nostro POS per ${x.site.name}${imprese.length ? ` e quelli di ${imprese.join(', ')}, già controllati con il vostro PSC` : ''}. Li trovate tutti qui, anche in un PDF solo: ${url}`;
  return {
    url, testo, destinatario: x.cse, inAttesa: x.inAttesa,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(testo)}`,
    email: `mailto:?subject=${encodeURIComponent(`POS per ${x.site.name}`)}&body=${encodeURIComponent(testo)}`,
  };
}

async function daToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw new PacchettoError(404, 'NOT_FOUND');
  const { data, error } = await supabase.from('pacchetti_sicurezza').select('*, sites(name), companies(name)').eq('token_hash', hash(token)).maybeSingle();
  dbErr(error);
  if (!data) throw new PacchettoError(404, 'NOT_FOUND');
  if (data.spento_at) throw new PacchettoError(410, 'SPENTO');
  return data;
}

/** La pagina del coordinatore (senza registrazione). La prima apertura si segna. */
async function pubblico(token) {
  const p = await daToken(token);
  if (!p.aperto_at) await supabase.from('pacchetti_sicurezza').update({ aperto_at: new Date().toISOString() }).eq('id', p.id);
  const azienda = p.companies?.name || '';
  return {
    azienda, cantiere: p.sites?.name || '', destinatario: p.destinatario, data: p.created_at.slice(0, 10), inAttesa: p.in_attesa || [],
    documenti: (p.contenuto || []).map(c => ({
      chiave: c.chiave, tipo: c.tipo,
      titolo: c.tipo === 'tuo' ? `${azienda} · impresa principale` : c.nome,
      sotto: c.tipo === 'tuo'
        ? (c.posId ? `POS rev. ${c.revisione}${c.richieste ? ` · le ${c.richieste} richieste del PSC ci sono tutte` : ''}` : 'POS')
        : c.posId ? `POS fatto con Palladia, rev. ${c.revisione}` : `Controllato da ${azienda} il ${giorno(p.created_at)}`,
    })),
  };
}

async function pdfDelPos(posId) {
  const { data: pos, error } = await supabase.from('pos_documents').select('id, revision, content, pos_data, site_id, sites(name)').eq('id', posId).maybeSingle();
  dbErr(error);
  if (!pos) throw new PacchettoError(404, 'NOT_FOUND');
  const { generatePosHtml, posPdfOptions } = require('../pos-html-generator');
  const { selectSigns } = require('../sign-selector');
  const { rendererPool } = require('../pdf-renderer');
  const html = await generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', selectSigns(pos.pos_data || {}));
  return rendererPool.render(html, posPdfOptions(pos.pos_data, pos.revision, pos.sites?.name));
}

async function percorsoFile(p, c) {
  const t = c.tipo === 'tuo' ? 'site_documents' : 'subcontractor_documents';
  const { data, error } = await supabase.from(t).select('file_path').eq('id', c.docId).eq('company_id', p.company_id).maybeSingle();
  dbErr(error);
  if (!data?.file_path) throw new PacchettoError(404, 'NOT_FOUND');
  return data.file_path;
}

/** Un documento: link firmato per i file, PDF generato per i POS fatti con Palladia. */
async function file(token, chiave) {
  const p = await daToken(token);
  const c = (p.contenuto || []).find(x => x.chiave === chiave);
  if (!c) throw new PacchettoError(404, 'NOT_FOUND');
  if (c.posId) return { pdf: await pdfDelPos(c.posId), nome: `POS-${c.tipo === 'tuo' ? 'impresa' : c.nome}`.replace(/[^\w-]+/g, '_') };
  const r = await supabase.storage.from(BUCKET).createSignedUrl(await percorsoFile(p, c), 600);
  if (r.error) throw new Error(r.error.message);
  return { url: r.data.signedUrl };
}

/** Tutto in un PDF solo, nell'ordine della pagina. */
async function pdf(token) {
  const p = await daToken(token);
  const out = await PDFDocument.create();
  for (const c of p.contenuto || []) {
    try {
      const buf = c.posId ? await pdfDelPos(c.posId) : Buffer.from(await (await supabase.storage.from(BUCKET).download(await percorsoFile(p, c))).data.arrayBuffer());
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
    } catch { /* un file illeggibile non ferma gli altri */ }
  }
  return { pdf: Buffer.from(await out.save()), nome: `Sicurezza-${(p.sites?.name || 'cantiere').replace(/[^\w-]+/g, '_')}` };
}

/** Per la sicurezza del cantiere: l'ultimo invio al coordinatore. */
async function ultimoInvio(companyId, siteId) {
  const { data, error } = await supabase.from('pacchetti_sicurezza').select('destinatario, created_at, aperto_at, in_attesa')
    .eq('company_id', companyId).eq('site_id', siteId).is('spento_at', null).order('created_at', { ascending: false }).limit(1);
  dbErr(error);
  const d = data?.[0];
  return d ? { destinatario: d.destinatario, mandatoIl: d.created_at, apertoIl: d.aperto_at, inAttesa: d.in_attesa || [] } : null;
}

module.exports = { crea, pubblico, file, pdf, ultimoInvio, PacchettoError, _hash: hash };
