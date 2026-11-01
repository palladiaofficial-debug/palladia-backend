'use strict';
/**
 * lib/prontoSubappalto.js — F-421 (AUDIT.md del frontend): «Pronta a lavorare»,
 * fase 3 — TU, quando lavori per un'altra impresa (schermate 5–8 del disegno).
 *
 *  statoTuo()      → sei pronto a fare da subappalto? Le stesse regole che Palladia
 *                    usa per le imprese che lavorano per te (documentiStato, F-419):
 *                    patente a crediti (o SOA di classe III o più ancora valida),
 *                    DURC, visura di meno di 6 mesi, DVR, dichiarazione art. 14; per
 *                    ogni operaio visita medica e corso sicurezza.
 *  crea()          → il link per l'impresa che ti prende: impresa, cantiere, quali
 *                    operai, il POS (facoltativo). Nel DB solo l'hash del token.
 *  pubblico()      → quello che vede chi apre il link: solo i documenti scelti,
 *                    sempre aggiornati (si ricalcola a ogni apertura).
 *  file() / pdf()  → un documento (link firmato di 5 minuti) o tutti in un PDF solo.
 *  elenco(), spegni()
 * Della visita medica va solo il giudizio di idoneità (il documento che Palladia
 * tiene: worker_documents idoneita_medica), mai una cartella sanitaria.
 */
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const supabase = require('./supabase');
const { stati, soaEsente } = require('./documentiStato');
const { extractStorageRef } = require('./companyStorageCleanup');

const BUCKET = 'site-documents';
const ETICHETTA = { patente: 'Patente a crediti', durc: 'DURC', visura: 'Visura camerale', dvr: 'DVR', dichiarazione: 'Dichiarazione che non è sospesa' };
const CATEGORIE = { patente: ['patente_crediti'], soa: ['soa'], durc: ['durc'], visura: ['visura'], dvr: ['dvr', 'duvri'], dichiarazione: ['dichiarazione_art14'] };
const ORDINE = ['patente', 'durc', 'visura', 'dvr', 'dichiarazione'];

class ProntoError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const dataSola = (v) => (v ? String(v).slice(0, 10) : null);
const piuGiorni = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const piuMesi = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const base = () => (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
const VA = (s) => s === 'ok' || s === 'in_scadenza';
function statoData(scad, oggi) {
  if (!scad) return 'ok';
  if (scad < oggi) return 'scaduto';
  return scad <= piuGiorni(oggi, 30) ? 'in_scadenza' : 'ok';
}

/** I documenti della tua impresa, il più recente per tipo. */
async function documentiImpresa(companyId) {
  const tutte = Object.values(CATEGORIE).flat();
  const { data, error } = await supabase.from('company_documents').select('id, category, name, file_path, mime_type, ai_expiry_date, created_at')
    .eq('company_id', companyId).in('category', tutte).order('created_at', { ascending: false }).limit(200);
  dbErr(error);
  const per = {};
  for (const [k, cats] of Object.entries(CATEGORIE)) per[k] = (data || []).find(d => cats.includes(d.category)) || null;
  return per;
}

/**
 * Puro: i requisiti della tua impresa dai documenti e dal profilo.
 * docs: { patente, soa, durc, visura, dvr, dichiarazione } (riga o null); co: { durc_expiry, soa_classifica, soa_expiry }
 */
function requisitiImpresa(docs, co, oggi = oggiRoma()) {
  return ORDINE.map(key => {
    const d = docs[key];
    const rif = d ? { tabella: 'company_documents', id: d.id } : null;
    if (key === 'patente') {
      const esente = !d ? soaEsente(co) : null;
      if (esente) return { key, label: `${ETICHETTA.patente} · esente (SOA classe ${esente.classe})`, stato: statoData(esente.scadenza, oggi), scadenza: esente.scadenza, esente: true, doc: docs.soa ? { tabella: 'company_documents', id: docs.soa.id } : null };
      return { key, label: ETICHETTA.patente, stato: d ? 'ok' : 'manca', scadenza: null, doc: rif };
    }
    if (key === 'durc') {
      const scad = [dataSola(co?.durc_expiry), dataSola(d?.ai_expiry_date)].filter(Boolean).sort().at(-1) || null;
      return { key, label: ETICHETTA.durc, stato: scad ? statoData(scad, oggi) : d ? 'ok' : 'manca', scadenza: scad, doc: rif };
    }
    if (key === 'visura') {
      // La visura non scade: dopo 6 mesi è troppo vecchia. Vale la data letta come validità, se c'è,
      // altrimenti 6 mesi da quando è stata caricata.
      const valida = d ? (dataSola(d.ai_expiry_date) || piuMesi(dataSola(d.created_at), 6)) : null;
      return { key, label: ETICHETTA.visura, stato: !d ? 'manca' : valida < oggi ? 'vecchia' : statoData(valida, oggi), scadenza: valida, doc: rif };
    }
    return { key, label: ETICHETTA[key], stato: d ? 'ok' : 'manca', scadenza: null, doc: rif };
  });
}

/** Puro: dal requisiti e dagli operai al verdetto, con le cose che mancano raggruppate. */
function verdettoTuo(impresa, operai) {
  const cose = impresa.filter(r => !VA(r.stato)).map(r => ({ dove: 'impresa', key: r.key, label: r.label.split(' · ')[0], stato: r.stato, scadenza: r.scadenza }));
  for (const [tipo, nome] of [['idoneita', 'Visita medica'], ['formazione', 'Corso sicurezza']]) {
    const no = operai.filter(o => !VA(o[tipo].stato));
    if (no.length) cose.push({ dove: 'operai', key: tipo, label: no.length === 1 ? `${nome} di ${no[0].nome}` : `${nome} di ${no.length} operai`, nomi: no.map(o => o.nome), stato: no.some(o => o[tipo].stato === 'scaduto') ? 'scaduto' : 'manca' });
  }
  const scad = [...impresa.map(r => r.scadenza), ...operai.flatMap(o => [o.idoneita.scadenza, o.formazione.scadenza])].filter(Boolean).sort();
  return { stato: cose.length ? 'no' : 'si', finoAl: cose.length ? null : scad[0] || null, cose };
}

/** I tuoi operai, con visita e corso (stesso stato di Documenti e del badge). */
async function operaiTuoi(companyId) {
  const { stati: tutti } = await stati(companyId);
  const STATO = { in_regola: 'ok', in_scadenza: 'in_scadenza', scaduto: 'scaduto', manca: 'manca' };
  const rif = (doc) => (doc ? { tabella: doc.source, id: doc.legacyId } : null);
  return tutti.filter(o => o.kind === 'lavoratori').map(o => {
    const r = (k) => o.requirements.find(x => x.key === k);
    const id = r('idoneita'), fo = r('formazione');
    return {
      id: o.id, nome: o.name,
      idoneita: { stato: STATO[id?.state] || 'manca', scadenza: id?.expiry || null, doc: rif(id?.doc) },
      formazione: { stato: STATO[fo?.state] || 'manca', scadenza: fo?.expiry || null, doc: rif(fo?.doc) },
    };
  }).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

async function statoTuo(companyId, { soloOperai = null } = {}) {
  const [{ data: co, error }, docs, operaiTutti] = await Promise.all([
    supabase.from('companies').select('name, piva, vat_number, address, legale_rappresentante, durc_expiry, soa_classifica, soa_expiry').eq('id', companyId).maybeSingle(),
    documentiImpresa(companyId),
    operaiTuoi(companyId),
  ]);
  dbErr(error);
  const impresa = requisitiImpresa(docs, co || {});
  const operai = soloOperai ? operaiTutti.filter(o => soloOperai.includes(o.id)) : operaiTutti;
  return { azienda: co?.name || null, impresa, operai, ...verdettoTuo(impresa, operai) };
}

// ── Il link per l'impresa che ti prende ─────────────────────────────────────
const linkDi = (token) => `${base()}/documenti-per/${token}`;

async function crea(companyId, userId, { destinatario, cantiere, operai = [], pos = null }) {
  const dest = String(destinatario || '').trim().slice(0, 160);
  if (dest.length < 2) throw new ProntoError(400, 'DESTINATARIO');
  const ids = [...new Set((Array.isArray(operai) ? operai : []).filter(x => /^[0-9a-f-]{36}$/i.test(String(x))))];
  if (ids.length) {
    const { data, error } = await supabase.from('workers').select('id').eq('company_id', companyId).in('id', ids);
    dbErr(error);
    if ((data || []).length !== ids.length) throw new ProntoError(400, 'OPERAIO_NON_VALIDO');
  }
  let posPath = null;
  if (pos?.buffer?.length) {
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(pos.mimetype)) throw new ProntoError(400, 'TIPO_NON_VALIDO');
    posPath = `${companyId}/pacchetti/${crypto.randomUUID()}-pos${pos.mimetype === 'application/pdf' ? '.pdf' : pos.mimetype === 'image/png' ? '.png' : '.jpg'}`;
    const up = await supabase.storage.from(BUCKET).upload(posPath, pos.buffer, { contentType: pos.mimetype, upsert: false });
    if (up.error) throw new Error(up.error.message);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const { data, error } = await supabase.from('pacchetti_documenti').insert({
    company_id: companyId, token_hash: hash(token), destinatario: dest, cantiere: String(cantiere || '').trim().slice(0, 200) || null,
    operai: ids, pos_path: posPath, pos_mime: posPath ? pos.mimetype : null, created_by: userId || null,
  }).select('id').single();
  if (error) { if (posPath) supabase.storage.from(BUCKET).remove([posPath]).catch(() => {}); throw new Error(error.message); }
  const st = await statoTuo(companyId, { soloOperai: ids });
  const az = st.azienda || 'la nostra impresa';
  const url = linkDi(token);
  const testo = `Buongiorno, sono di ${az}. Qui ci sono i nostri documenti per lavorare${cantiere ? ` in ${String(cantiere).trim()}` : ' nel vostro cantiere'}: patente a crediti, DURC, visura, DVR, dichiarazione${ids.length ? ' e i documenti dei nostri operai' : ''}${posPath ? ', e il POS' : ''}. Si aggiornano da soli: ${url}`;
  return {
    id: data.id, url, testo,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(testo)}`,
    email: `mailto:?subject=${encodeURIComponent(`Documenti di ${az}`)}&body=${encodeURIComponent(testo)}`,
    verdetto: { stato: st.stato, finoAl: st.finoAl, cose: st.cose },
  };
}

async function elenco(companyId) {
  const { data, error } = await supabase.from('pacchetti_documenti').select('id, destinatario, cantiere, operai, created_at, aperto_at, spento_at')
    .eq('company_id', companyId).order('created_at', { ascending: false }).limit(50);
  dbErr(error);
  return (data || []).map(p => ({ id: p.id, destinatario: p.destinatario, cantiere: p.cantiere, operai: p.operai.length, creato: p.created_at, aperto: p.aperto_at, spento: !!p.spento_at }));
}

async function spegni(companyId, id) {
  const { data, error } = await supabase.from('pacchetti_documenti').update({ spento_at: new Date().toISOString() }).eq('id', id).eq('company_id', companyId).is('spento_at', null).select('id');
  dbErr(error);
  if (!data?.length) throw new ProntoError(404, 'NOT_FOUND');
  return { spento: true };
}

async function daToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw new ProntoError(404, 'NOT_FOUND');
  const { data, error } = await supabase.from('pacchetti_documenti').select('*').eq('token_hash', hash(token)).maybeSingle();
  dbErr(error);
  if (!data) throw new ProntoError(404, 'NOT_FOUND');
  if (data.spento_at) throw new ProntoError(410, 'SPENTO');
  return data;
}

/** I documenti che il link mostra: [{ chiave, gruppo, label, sotto, rif }] — la chiave è quello che il link può aprire. */
function voci(st, p) {
  const out = [];
  for (const r of st.impresa) {
    if (!r.doc) continue;
    out.push({ chiave: `i-${r.key}`, gruppo: 'impresa', label: r.label, sotto: r.scadenza && r.key !== 'visura' ? `fino al ${r.scadenza}` : null, stato: r.stato, rif: r.doc });
  }
  if (p.pos_path) out.push({ chiave: 'pos', gruppo: 'impresa', label: `POS${p.cantiere ? ` per ${p.cantiere}` : ''}`, sotto: null, stato: 'ok', rif: { tabella: 'pacchetto', path: p.pos_path, mime: p.pos_mime } });
  for (const o of st.operai) {
    for (const [tipo, nome] of [['idoneita', 'giudizio di idoneità'], ['formazione', 'corso sicurezza']]) {
      if (o[tipo].doc) out.push({ chiave: `o-${o.id}-${tipo}`, gruppo: 'operai', label: `${o.nome} · ${nome}`, sotto: o[tipo].scadenza ? `fino al ${o[tipo].scadenza}` : null, stato: o[tipo].stato, rif: o[tipo].doc });
    }
  }
  return out;
}

async function pubblico(token) {
  const p = await daToken(token);
  if (!p.aperto_at) await supabase.from('pacchetti_documenti').update({ aperto_at: new Date().toISOString() }).eq('id', p.id);
  const st = await statoTuo(p.company_id, { soloOperai: p.operai });
  return {
    azienda: st.azienda, destinatario: p.destinatario, cantiere: p.cantiere, controllato: oggiRoma(),
    stato: st.stato, finoAl: st.finoAl, mancano: st.cose.map(c => c.label),
    documenti: voci(st, p).map(({ chiave, gruppo, label, sotto, stato }) => ({ chiave, gruppo, label, sotto, stato })),
  };
}

/** Dove sta il file di un documento (bucket, percorso, tipo). */
async function doveSta(rif, companyId) {
  if (rif.tabella === 'pacchetto') return { bucket: BUCKET, path: rif.path, mime: rif.mime };
  if (rif.tabella === 'company_documents' || rif.tabella === 'worker_documents') {
    const { data } = await supabase.from(rif.tabella).select('file_path, mime_type').eq('id', rif.id).eq('company_id', companyId).maybeSingle();
    return data?.file_path ? { bucket: BUCKET, path: data.file_path, mime: data.mime_type } : null;
  }
  if (rif.tabella === 'worker_certificates') {
    const { data } = await supabase.from('worker_certificates').select('pdf_url').eq('id', rif.id).eq('company_id', companyId).maybeSingle();
    const ref = data?.pdf_url ? extractStorageRef(data.pdf_url) : null;
    return ref ? { bucket: ref.bucket, path: ref.path, mime: /\.pdf$/i.test(ref.path) ? 'application/pdf' : null } : null;
  }
  return null;
}

async function file(token, chiave) {
  const p = await daToken(token);
  const st = await statoTuo(p.company_id, { soloOperai: p.operai });
  const v = voci(st, p).find(x => x.chiave === chiave);
  if (!v) throw new ProntoError(404, 'NOT_FOUND');
  const dove = await doveSta(v.rif, p.company_id);
  if (!dove) throw new ProntoError(404, 'NO_FILE');
  const r = await supabase.storage.from(dove.bucket).createSignedUrl(dove.path, 300);
  if (r.error) throw new Error(r.error.message);
  return { url: r.data.signedUrl, nome: v.label };
}

/** Tutti i documenti del link in un PDF solo: i PDF così come sono, le foto su una pagina A4. */
async function pdf(token) {
  const p = await daToken(token);
  const st = await statoTuo(p.company_id, { soloOperai: p.operai });
  const out = await PDFDocument.create();
  out.setTitle(`Documenti di ${st.azienda || ''} per ${p.destinatario}`);
  const font = await out.embedFont(StandardFonts.Helvetica), bold = await out.embedFont(StandardFonts.HelveticaBold);
  const copertina = out.addPage([595.28, 841.89]);
  let y = 770;
  const scrivi = (t, f = font, size = 12) => { copertina.drawText(String(t).slice(0, 95), { x: 56, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= size + 10; };
  scrivi(`Documenti di ${st.azienda || ''}`, bold, 20);
  scrivi(`Per ${p.destinatario}${p.cantiere ? ` · ${p.cantiere}` : ''}`, font, 13);
  scrivi(`Controllati il ${new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' })}`, font, 11);
  y -= 10;
  const saltati = [];
  for (const v of voci(st, p)) {
    scrivi(`· ${v.label}${v.sotto ? ` (${v.sotto})` : ''}`);
    try {
      const dove = await doveSta(v.rif, p.company_id);
      if (!dove) { saltati.push(v.label); continue; }
      const { data: blob, error } = await supabase.storage.from(dove.bucket).download(dove.path);
      if (error || !blob) { saltati.push(v.label); continue; }
      const buf = Buffer.from(await blob.arrayBuffer());
      const isPdf = (dove.mime || '').includes('pdf') || buf.slice(0, 4).toString() === '%PDF';
      if (isPdf) {
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
      } else {
        const img = buf[0] === 0x89 ? await out.embedPng(buf) : await out.embedJpg(buf);
        const pg = out.addPage([595.28, 841.89]);
        const s = Math.min(523 / img.width, 770 / img.height, 1);
        pg.drawImage(img, { x: (595.28 - img.width * s) / 2, y: (841.89 - img.height * s) / 2, width: img.width * s, height: img.height * s });
      }
    } catch { saltati.push(v.label); }
  }
  if (saltati.length) { y -= 8; scrivi(`Non inclusi (aprili dal link): ${saltati.join(', ')}`, font, 10); }
  scrivi('Controllati con Palladia · palladia.net', font, 9);
  return { buffer: Buffer.from(await out.save()), nome: `documenti-${(st.azienda || 'impresa').replace(/[^\w]+/g, '-').toLowerCase()}.pdf` };
}

module.exports = { statoTuo, requisitiImpresa, verdettoTuo, crea, elenco, spegni, pubblico, file, pdf, ProntoError, _hash: hash };
