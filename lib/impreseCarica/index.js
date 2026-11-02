'use strict';
/**
 * lib/impreseCarica/index.js — F-401 (AUDIT.md del frontend): «Carica documenti»
 * delle imprese in subappalto, tutti in un colpo.
 *
 *  crea()        → un caricamento (dalla pagina Imprese, o dalla scheda di un'impresa)
 *  aggiungi()    → un file: PDF, foto o ZIP (che si apre); parte la lettura
 *  lavora()      → in sottofondo: divide i PDF con più documenti, legge ogni
 *                  documento (./lettura.js), lo attribuisce e lo giudica (./attribuisci.js)
 *  stato()       → avanzamento e tutto in ordine (./ordina.js), con cosa manca ancora
 *                  a ogni impresa dopo il salvataggio
 *  correggi()    → tipo, impresa, operaio, cantiere, scadenza, «non salvarlo»
 *  salva()       → nelle tabelle vere (subcontractor_documents, sub_workers,
 *                  sub_worker_documenti), imprese e operai nuovi creati, date
 *                  dell'impresa portate avanti (mai indietro). F-415: quelli
 *                  della TUA impresa nei documenti dell'impresa, del cantiere o
 *                  nella scheda dell'operaio, come l'archiviazione di sempre
 *                  (services/chatDocumentAnalysis.archiveChatUpload)
 * Niente si salva prima che il titolare abbia visto. I file stanno in
 * `<azienda>/caricamenti-imprese/<id>/` finché non si salvano.
 */
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const supabase = require('../supabase');
const { extractPdfText } = require('../pdfExtract');
const { inspectPdf, extractPdfPages } = require('../pdfSplit');
const { paginaPerPagina } = require('../bustePaga/dividi');
const L = require('../impreseLink');
const { leggiDocumento, TIPI, righeBolla } = require('./lettura');
const { attribuisci, giudizio, PERSONA, FORNITORE, NOSTRA } = require('./attribuisci');
const { archiveChatUpload } = require('../../services/chatDocumentAnalysis');
const Conf = require('../confronto');
const { ordina, ETICHETTA } = require('./ordina');

const BUCKET = 'site-documents';
const MAX_DOCUMENTI = 300;
const PARALLELI = 3;
const IMMAGINI = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const CATEGORIA = { patente: 'patente_crediti', soa: 'soa', durc: 'durc', visura: 'visura', dvr: 'dvr', dichiarazione: 'dichiarazione_art14', attrezzature: 'attrezzature', dpi: 'dpi', assicurazione: 'insurance', pos: 'pos', altro: 'altro' };
const RICHIESTE = ['patente', 'durc', 'visura', 'dvr', 'dichiarazione'];  // obbligatorie per un'impresa nuova, come documentiStato (F-419: la patente a crediti)

class CaricaError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sicuro = (n) => String(n || 'file').normalize('NFKD').replace(/[^\w.-]/g, '_').slice(-80) || 'file';
const mimeDa = (nome, mime) => {
  const n = String(nome || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.heic') || n.endsWith('.heif')) return 'image/heic';
  if (n.endsWith('.zip')) return 'application/zip';
  return mime || 'application/octet-stream';
};

// ── Contesto: imprese, operai, cantieri dell'azienda ─────────────────────────
async function contesto(companyId) {
  const [imp, ops, cant, co, nostri, nostriCant] = await Promise.all([
    supabase.from('subcontractors').select('id, company_name, piva, da_completare').eq('company_id', companyId).eq('is_active', true).order('company_name'),
    supabase.from('sub_workers').select('id, full_name, fiscal_code, subcontractor_id').eq('company_id', companyId).is('deactivated_at', null),
    supabase.from('site_subcontractors').select('subcontractor_id, sites(id, name, address, status)').eq('company_id', companyId),
    supabase.from('companies').select('name, piva, vat_number').eq('id', companyId).maybeSingle(),
    // F-415: i tuoi operai (non quelli delle imprese, non chi non lavora più qui) e i tuoi cantieri
    supabase.from('workers').select('id, full_name, fiscal_code').eq('company_id', companyId).eq('is_active', true).is('subcontractor_id', null).is('cessato_il', null),
    supabase.from('sites').select('id, name, address').eq('company_id', companyId).eq('status', 'attivo').order('name'),
  ]);
  for (const r of [imp, ops, cant, co, nostri, nostriCant]) dbErr(r.error);
  const cantieriPer = {};
  for (const r of cant.data || []) {
    if (!r.sites || !['attivo', 'sospeso'].includes(r.sites.status)) continue;
    (cantieriPer[r.subcontractor_id] ||= []).push({ id: r.sites.id, nome: r.sites.name, indirizzo: r.sites.address || null });
  }
  cantieriPer[NOSTRA] = (nostriCant.data || []).map(c => ({ id: c.id, nome: c.name, indirizzo: c.address || null }));
  const pivaNostra = String(co.data?.piva || co.data?.vat_number || '').replace(/\D/g, '') || null;
  return {
    // F-415: la tua impresa è la prima delle imprese, con i tuoi operai e i tuoi cantieri
    imprese: [
      { id: NOSTRA, nome: co.data?.name || 'La tua impresa', piva: pivaNostra, daCompletare: false, nostra: true },
      ...(imp.data || []).map(i => ({ id: i.id, nome: i.da_completare ? 'Impresa da completare' : i.company_name, piva: i.piva ? String(i.piva).replace(/\D/g, '') : null, daCompletare: !!i.da_completare })),
    ],
    operai: [
      ...(nostri.data || []).map(o => ({ id: o.id, nome: o.full_name, cf: o.fiscal_code ? String(o.fiscal_code).toUpperCase() : null, subId: NOSTRA })),
      ...(ops.data || []).map(o => ({ id: o.id, nome: o.full_name, cf: o.fiscal_code, subId: o.subcontractor_id })),
    ],
    cantieriPer,
    pivaNostra,
  };
}

async function caricamento(companyId, id) {
  const { data, error } = await supabase.from('imprese_caricamenti').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
  dbErr(error);
  if (!data) throw new CaricaError(404, 'NOT_FOUND');
  return data;
}

async function crea(companyId, userId, { subcontractorId } = {}) {
  if (subcontractorId) {
    const { data } = await supabase.from('subcontractors').select('id').eq('id', subcontractorId).eq('company_id', companyId).eq('is_active', true).maybeSingle();
    if (!data) throw new CaricaError(404, 'IMPRESA_NON_TROVATA');
  }
  const { data, error } = await supabase.from('imprese_caricamenti').insert({ company_id: companyId, subcontractor_id: subcontractorId || null, created_by: userId || null }).select('id').single();
  dbErr(error);
  return { id: data.id };
}

async function salvaFile(companyId, carId, nome, buffer, mime) {
  const path = `${companyId}/caricamenti-imprese/${carId}/${crypto.randomUUID()}-${sicuro(nome)}`;
  const up = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: mime, upsert: false });
  if (up.error) throw new Error(up.error.message);
  return path;
}

/** Un file dal titolare: PDF, foto o ZIP. Ritorna quanti file sono entrati. */
async function aggiungi(companyId, carId, file, opts = {}) {
  const car = await caricamento(companyId, carId);
  if (car.salvato_at) throw new CaricaError(409, 'GIA_SALVATO');
  if (!file?.buffer?.length) throw new CaricaError(400, 'FILE_REQUIRED');
  const { count } = await supabase.from('imprese_caricamento_doc').select('id', { count: 'exact', head: true }).eq('caricamento_id', carId);
  const mime = mimeDa(file.originalname, file.mimetype);
  let voci = [{ nome: file.originalname, buffer: file.buffer, mime }];
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed') {
    let zip;
    try { zip = new AdmZip(file.buffer); } catch { throw new CaricaError(400, 'ZIP_ROTTO'); }
    voci = zip.getEntries()
      .filter(e => !e.isDirectory && !/(^|\/)(__MACOSX|\.)/.test(e.entryName))
      .map(e => ({ nome: e.entryName.split('/').pop(), mime: mimeDa(e.entryName), e }))
      .filter(v => v.mime === 'application/pdf' || IMMAGINI.includes(v.mime) || v.mime === 'image/heic')
      .slice(0, MAX_DOCUMENTI)
      .map(v => ({ nome: v.nome, mime: v.mime, buffer: v.e.getData() }));
    if (!voci.length) throw new CaricaError(400, 'ZIP_VUOTO');
  } else if (mime !== 'application/pdf' && !IMMAGINI.includes(mime) && mime !== 'image/heic') {
    throw new CaricaError(400, 'TIPO_NON_VALIDO');
  }
  if ((count || 0) + voci.length > MAX_DOCUMENTI) throw new CaricaError(400, 'TROPPI_FILE');
  let ordine = count || 0;
  for (const v of voci) {
    // Le foto HEIC dell'iPhone non si leggono (e lo storage non le accetta): solo l'errore, col perché
    const heic = v.mime === 'image/heic';
    const path = heic ? '' : await salvaFile(companyId, carId, v.nome, v.buffer, v.mime);
    const { error } = await supabase.from('imprese_caricamento_doc').insert({
      caricamento_id: carId, company_id: companyId, livello: 'file', stato: heic ? 'errore' : 'in_coda',
      errore: heic ? 'Foto in formato HEIC (iPhone): salvala come JPG e ricaricala' : null,
      nome_file: String(v.nome || '').slice(0, 200), file_path: path, mime_type: v.mime, content_hash: sha(v.buffer), ordine: ordine++,
    });
    dbErr(error);
  }
  if (!opts.senzaLavoro) lavora(companyId, carId, opts).catch(err => console.error('[impreseCarica] lavora:', err.message));
  return { aggiunti: voci.length };
}

// ── La lettura, in sottofondo ────────────────────────────────────────────────
const attivi = new Set();

async function scarica(path) {
  const r = await supabase.storage.from(BUCKET).download(path);
  if (r.error) throw new Error(r.error.message);
  return Buffer.from(await r.data.arrayBuffer());
}

/** Come si divide un PDF con più documenti: lo dice il modello (services/smartImportAI). Iniettabile. */
async function dividiConModello({ buffer, pagine, companyId }) {
  const { classifySegments } = require('../../services/smartImportAI');
  const { segments } = await classifySegments({ buffer, mimeType: 'application/pdf', companyId, userId: null, pageCount: pagine });
  return segments.map(s => ({ da: s.start_page, a: s.end_page || pagine }));
}
// I pezzi devono stare nel file, in ordine e senza sovrapporsi; altrimenti è un documento solo
function pezziValidi(pezzi, pagine) {
  const ok = Array.isArray(pezzi) && pezzi.length > 1 && pezzi.every((p, i) => Number.isInteger(p.da) && Number.isInteger(p.a) && p.da >= 1 && p.a <= pagine && p.da <= p.a && (i === 0 || p.da > pezzi[i - 1].a));
  return ok ? pezzi : [{ da: 1, a: pagine }];
}

async function dividiFile(companyId, f, opts) {
  const buffer = await scarica(f.file_path);
  const nuovo = (extra) => supabase.from('imprese_caricamento_doc').insert({
    caricamento_id: f.caricamento_id, company_id: companyId, livello: 'documento', file_id: f.id, stato: 'in_coda',
    nome_file: f.nome_file, mime_type: f.mime_type, ordine: f.ordine * 100 + (extra.n || 0), ...extra.riga,
  });
  if (IMMAGINI.includes(f.mime_type)) {
    dbErr((await nuovo({ riga: { file_path: f.file_path, content_hash: f.content_hash, pagine: '1' } })).error);
    return;
  }
  const ins = await inspectPdf(buffer);
  if (!ins.ok) throw new CaricaError(400, 'Il PDF è rovinato: fattelo rimandare');
  if (ins.encrypted) throw new CaricaError(400, 'Il PDF è protetto da password: fattelo mandare senza');
  const pagine = ins.pageCount;
  let pezzi = [{ da: 1, a: pagine }];
  if (pagine > 1) {
    try { pezzi = pezziValidi(await (opts.dividi || dividiConModello)({ buffer, pagine, companyId }), pagine); } catch { pezzi = [{ da: 1, a: pagine }]; }
  }
  if (pezzi.length === 1) {
    dbErr((await nuovo({ riga: { file_path: f.file_path, content_hash: f.content_hash, pagine: pagine === 1 ? '1' : `1–${pagine}` } })).error);
    return;
  }
  for (const [n, p] of pezzi.entries()) {
    const pezzo = await extractPdfPages(buffer, p.da, p.a);
    const path = await salvaFile(companyId, f.caricamento_id, f.nome_file, pezzo, 'application/pdf');
    dbErr((await nuovo({ n, riga: { file_path: path, content_hash: sha(pezzo), pagine: p.da === p.a ? `${p.da}` : `${p.da}–${p.a}` } })).error);
  }
}

async function leggiUno(companyId, d, ctx, pre, opts) {
  const buffer = await scarica(d.file_path);
  let pagine = 1, testoPagine = null;
  if (d.mime_type === 'application/pdf') {
    const ins = await inspectPdf(buffer);
    pagine = ins.pageCount || 1;
    if (pagine > 12) {
      const { text, numPages } = await extractPdfText(buffer, { maxPages: 400, minChars: 0 });
      testoPagine = paginaPerPagina(text, numPages).map(p => `--- Pagina ${p.n} ---\n${p.testo}`).filter(t => t.length > 20);
    }
  }
  const letto = await leggiDocumento({ buffer, mimetype: d.mime_type, pagine, testoPagine, companyId, chiedi: opts.chiedi });
  return { letto, proposta: attribuisci(letto, { ...ctx, pre }) };
}

/** Lavora finché c'è qualcosa in coda. Uno alla volta per caricamento. */
async function lavora(companyId, carId, opts = {}) {
  if (attivi.has(carId)) return;
  attivi.add(carId);
  try {
    const car = await caricamento(companyId, carId);
    // 1. dividere i file
    for (;;) {
      const { data: f } = await supabase.from('imprese_caricamento_doc').select('*').eq('caricamento_id', carId).eq('livello', 'file').eq('stato', 'in_coda').order('ordine').limit(1).maybeSingle();
      if (!f) break;
      await supabase.from('imprese_caricamento_doc').update({ stato: 'in_lettura', lettura_at: new Date().toISOString() }).eq('id', f.id);
      try {
        await dividiFile(companyId, f, opts);
        await supabase.from('imprese_caricamento_doc').update({ stato: 'diviso' }).eq('id', f.id);
      } catch (err) {
        await supabase.from('imprese_caricamento_doc').update({ stato: 'errore', errore: err instanceof CaricaError ? err.code : 'Non sono riuscito ad aprirlo' }).eq('id', f.id);
      }
    }
    // 2. leggere i documenti, qualcuno insieme
    const ctx = await contesto(companyId);
    for (;;) {
      const { data: lotto } = await supabase.from('imprese_caricamento_doc').select('*').eq('caricamento_id', carId).eq('livello', 'documento').eq('stato', 'in_coda').order('ordine').limit(PARALLELI);
      if (!lotto?.length) break;
      await supabase.from('imprese_caricamento_doc').update({ stato: 'in_lettura', lettura_at: new Date().toISOString() }).in('id', lotto.map(d => d.id));
      await Promise.all(lotto.map(async d => {
        try {
          const { letto, proposta } = await leggiUno(companyId, d, ctx, car.subcontractor_id, opts);
          await supabase.from('imprese_caricamento_doc').update({ stato: 'pronto', letto, proposta }).eq('id', d.id);
        } catch (err) {
          console.error('[impreseCarica] lettura:', err.message);
          await supabase.from('imprese_caricamento_doc').update({ stato: 'errore', errore: 'Non sono riuscito a leggerlo' }).eq('id', d.id);
        }
      }));
    }
  } finally { attivi.delete(carId); }
}

// ── Lo stato, in ordine ──────────────────────────────────────────────────────
async function righe(carId) {
  const { data, error } = await supabase.from('imprese_caricamento_doc').select('*').eq('caricamento_id', carId).order('ordine');
  dbErr(error);
  return data || [];
}

/** Quali file sono già in Palladia (stesso contenuto). */
async function giaPresenti(companyId, hashes) {
  if (!hashes.length) return new Set();
  // F-415: anche nelle schede della tua impresa e dei tuoi operai
  const tabelle = ['subcontractor_documents', 'sub_worker_documenti', 'company_documents', 'worker_documents', 'site_documents', 'bolle', 'fatture'];  // F-422, F-423: anche bolle e fatture
  const r = await Promise.all(tabelle.map(t => supabase.from(t).select('content_hash').eq('company_id', companyId).in('content_hash', hashes)));
  return new Set(r.flatMap(x => x.data || []).map(x => x.content_hash));
}

/** Cosa mancherà ancora a ogni impresa dopo il salvataggio (lo stato di oggi + quello che va bene qui). */
async function dopo(companyId, gruppo, ctx) {
  const bene = new Set(gruppo.documenti.filter(d => d.esito === 'va_bene').map(d => (d.tipo === 'pos' ? `pos:${d.siteId}` : d.tipo)));
  const label = (k) => ETICHETTA[k] || k;
  if (gruppo.nostra) return { puoLavorare: true, mancano: [] };  // F-415: i requisiti sono quelli dei subappaltatori
  if (!gruppo.id) {
    const mancano = RICHIESTE.filter(k => !bene.has(k)).map(label);
    return { puoLavorare: mancano.length === 0, mancano };
  }
  const impresa = ctx.imprese.find(i => i.id === gruppo.id);
  const s = await L.statoImpresa(companyId, { id: gruppo.id, company_name: impresa?.nome, piva: impresa?.piva, da_completare: impresa?.daCompletare });
  const ok = (st) => st === 'ok' || st === 'in_scadenza';
  const mancano = [
    ...s.requisiti.filter(r => !r.consigliata && !ok(r.stato) && !bene.has(r.key)).map(r => r.label),
    ...s.pos.filter(r => !ok(r.stato) && !bene.has(`pos:${r.siteId}`)).map(r => r.label),
  ];
  return { puoLavorare: mancano.length === 0, mancano };
}

async function stato(companyId, carId, opts = {}) {
  const car = await caricamento(companyId, carId);
  let tutte = await righe(carId);
  // Una lettura rimasta a metà (server riavviato): torna in coda
  const vecchio = Date.now() - 3 * 60 * 1000;
  const ferme = tutte.filter(r => r.stato === 'in_lettura' && (!r.lettura_at || Date.parse(r.lettura_at) < vecchio) && !attivi.has(carId));
  if (ferme.length) {
    await supabase.from('imprese_caricamento_doc').update({ stato: 'in_coda' }).in('id', ferme.map(r => r.id));
    tutte = await righe(carId);
  }
  if (!car.salvato_at && tutte.some(r => r.stato === 'in_coda') && !attivi.has(carId)) lavora(companyId, carId, opts).catch(err => console.error('[impreseCarica] lavora:', err.message));

  const file = tutte.filter(r => r.livello === 'file');
  const docs = tutte.filter(r => r.livello === 'documento');
  const ctx = await contesto(companyId);
  const gia = await giaPresenti(companyId, [...new Set(docs.filter(d => d.stato === 'pronto').map(d => d.content_hash).filter(Boolean))]);
  const ord = ordina(docs.map(d => ({ ...d, gia: d.content_hash ? gia.has(d.content_hash) : false })), ctx);
  // Gli errori dei file (protetti, rovinati, HEIC) insieme a quelli dei documenti
  ord.errori.push(...file.filter(f => f.stato === 'errore').map(f => ({ id: f.id, nomeFile: f.nome_file, pagine: null, errore: f.errore })));
  const daLeggere = docs.filter(d => ['in_coda', 'in_lettura'].includes(d.stato)).length + file.filter(f => ['in_coda', 'in_lettura'].includes(f.stato)).length;
  for (const g of ord.imprese) g.dopo = await dopo(companyId, g, ctx);
  // F-423: per ogni fattura, il confronto con le bolle (anche quelle di questo caricamento, non ancora salvate)
  const fatture = ord.bolle.filter(v => v.tipo === 'fattura');
  if (fatture.length) {
    const qui = docs.filter(d => d.stato === 'pronto' && d.proposta?.tipo === 'bolla' && !d.proposta.scartato && d.proposta.siteId).map(d => ({
      id: `qui:${d.id}`, numero: d.proposta.numero ?? d.letto?.numero ?? null, fornitore: d.proposta.fornitore ?? d.letto?.ragioneSociale ?? null,
      fornitore_piva: d.letto?.piva || null, data: d.proposta.data ?? d.letto?.dataDocumento ?? null, righe: d.proposta.righe ?? d.letto?.righe ?? [], fattura_id: null,
    }));
    for (const v of fatture) {
      const d = docs.find(x => x.id === v.id);
      const f = { fornitore: d?.letto?.ragioneSociale, piva: d?.letto?.piva, data: d?.letto?.dataDocumento, bolle_citate: d?.letto?.bolleCitate || [] };
      const bolle = await Conf.abbina(companyId, f, qui).catch(() => []);
      const c = Conf.confronta(bolle, { righe: d?.letto?.righe || [] });
      v.fattura = { ...v.fattura, anteprima: { esito: c.esito, frase: c.frase, inPiuEuro: c.inPiuEuro, bolle: bolle.length } };
    }
  }
  return {
    id: car.id, subcontractorId: car.subcontractor_id, salvato: !!car.salvato_at, esito: car.esito || null,
    avanzamento: { file: file.length, documenti: docs.length, letti: docs.filter(d => ['pronto', 'errore', 'salvato', 'scartato'].includes(d.stato)).length, daLeggere, finito: daLeggere === 0 },
    ...ord,
    opzioni: {
      imprese: ctx.imprese.map(i => ({ id: i.id, nome: i.nostra ? 'La tua impresa' : i.nome })),
      operaiPer: ctx.operai.reduce((m, o) => { (m[o.subId] ||= []).push({ id: o.id, nome: o.nome }); return m; }, {}),
      cantieriPer: ctx.cantieriPer,
    },
  };
}

/** Il link (10 minuti) per guardare un documento del caricamento. */
async function apri(companyId, carId, docId) {
  const { data } = await supabase.from('imprese_caricamento_doc').select('file_path').eq('id', docId).eq('caricamento_id', carId).eq('company_id', companyId).maybeSingle();
  if (!data) throw new CaricaError(404, 'NOT_FOUND');
  const r = await supabase.storage.from(BUCKET).createSignedUrl(data.file_path, 600);
  if (r.error) throw new Error(r.error.message);
  return { url: r.data.signedUrl };
}

// ── Correggere ───────────────────────────────────────────────────────────────
const dataOk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

async function correggi(companyId, carId, docId, b = {}) {
  const car = await caricamento(companyId, carId);
  if (car.salvato_at) throw new CaricaError(409, 'GIA_SALVATO');
  const { data: d } = await supabase.from('imprese_caricamento_doc').select('*').eq('id', docId).eq('caricamento_id', carId).eq('stato', 'pronto').maybeSingle();
  if (!d) throw new CaricaError(404, 'NOT_FOUND');
  const ctx = await contesto(companyId);
  const p = { ...d.proposta };
  if (b.tipo !== undefined) {
    if (!TIPI.includes(b.tipo)) throw new CaricaError(400, 'TIPO_NON_VALIDO');
    p.tipo = b.tipo;
    if (FORNITORE.has(p.tipo)) { p.impresa = null; p.operaio = null; }
    if (!PERSONA.has(p.tipo)) p.operaio = null;
    else if (!p.operaio && d.letto?.persona) p.operaio = { nuovo: { nome: d.letto.persona, cf: d.letto.cfPersona || null } };
    if (p.tipo !== 'pos') p.siteId = null;
  }
  if (b.impresa !== undefined) {
    if (b.impresa === null) p.impresa = null;
    else if (b.impresa.id) {
      if (!ctx.imprese.some(i => i.id === b.impresa.id)) throw new CaricaError(400, 'IMPRESA_NON_VALIDA');
      if (p.impresa?.id !== b.impresa.id) { p.impresa = { id: b.impresa.id }; p.siteId = null; if (p.operaio?.id) p.operaio = d.letto?.persona ? { nuovo: { nome: d.letto.persona, cf: d.letto.cfPersona || null } } : null; }
    } else if (b.impresa.nuova?.nome && (!b.impresa.nuova.piva || /^\d{11}$/.test(String(b.impresa.nuova.piva)))) {
      p.impresa = { nuova: { nome: String(b.impresa.nuova.nome).slice(0, 160), piva: b.impresa.nuova.piva || null, sede: b.impresa.nuova.sede || null } };
    } else throw new CaricaError(400, 'IMPRESA_NON_VALIDA');
    p.come = 'scelta';
  }
  if (b.operaio !== undefined) {
    if (!PERSONA.has(p.tipo)) throw new CaricaError(400, 'NON_E_DI_UN_OPERAIO');
    if (b.operaio === null) p.operaio = null;
    else if (b.operaio.id) {
      if (!ctx.operai.some(o => o.id === b.operaio.id && o.subId === p.impresa?.id)) throw new CaricaError(400, 'OPERAIO_NON_VALIDO');
      p.operaio = { id: b.operaio.id };
    } else if (p.impresa?.id === NOSTRA) throw new CaricaError(400, 'OPERAIO_NON_VALIDO');  // F-415: un tuo operaio non si crea da qui
    else if (String(b.operaio.nuovo?.nome || '').trim().length >= 3) p.operaio = { nuovo: { nome: String(b.operaio.nuovo.nome).trim().slice(0, 120), cf: null } };
    else throw new CaricaError(400, 'OPERAIO_NON_VALIDO');
  }
  if (b.siteId !== undefined) {
    const tra = ctx.cantieriPer[p.tipo === 'bolla' ? NOSTRA : p.impresa?.id] || [];  // F-422: una bolla va in un TUO cantiere
    if (b.siteId !== null && !tra.some(c => c.id === b.siteId)) throw new CaricaError(400, 'CANTIERE_NON_VALIDO');
    p.siteId = b.siteId;
  }
  // F-422: «Qualcosa è sbagliato» sulla bolla — fornitore, numero, data, materiali
  if (p.tipo === 'bolla') {
    if (b.fornitore !== undefined) p.fornitore = String(b.fornitore || '').trim().slice(0, 160) || null;
    if (b.numero !== undefined) p.numero = String(b.numero || '').trim().slice(0, 40) || null;
    if (b.data !== undefined) { if (b.data !== null && !dataOk(b.data)) throw new CaricaError(400, 'DATA_NON_VALIDA'); p.data = b.data; }
    if (b.righe !== undefined) { if (!Array.isArray(b.righe)) throw new CaricaError(400, 'RIGHE_NON_VALIDE'); p.righe = righeBolla(b.righe); }
  }
  if (b.scadenza !== undefined) {
    if (b.scadenza !== null && !dataOk(b.scadenza)) throw new CaricaError(400, 'DATA_NON_VALIDA');
    p.scadenzaScelta = b.scadenza;
  }
  if (b.scartato !== undefined) p.scartato = !!b.scartato;
  const nuova = { ...p, ...giudizio(p, d.letto || {}, ctx) };
  dbErr((await supabase.from('imprese_caricamento_doc').update({ proposta: nuova }).eq('id', d.id)).error);
  return { ok: true };
}

// ── Salvare ──────────────────────────────────────────────────────────────────
// F-415: un documento della tua impresa va dove va un documento caricato a mano
// o archiviato da Ladia — stessa funzione (archiveChatUpload), quindi stesse
// tabelle, stesse scadenze sincronizzate sull'operaio (visita, corso sicurezza)
// e stesso fascicolo unificato in Documenti.
const TIPO_OPERAIO = { idoneita: 'idoneita_medica', formazione: 'formazione_sicurezza' };
const CORSO_OPERAIO = { primo_soccorso: 'primo_soccorso', antincendio: 'antincendio', quota: 'lavori_quota', ponteggi: 'ponteggi' };
const TIPO_IMPRESA = { patente: 'patente_crediti', soa: 'soa', durc: 'durc', visura: 'visura', dvr: 'dvr', assicurazione: 'assicurazione', pos: 'altro', dichiarazione: 'dichiarazione_art14', attrezzature: 'altro', dpi: 'altro', altro: 'altro' };  // F-421: patente, SOA e dichiarazione della tua impresa

async function salvaNostro(companyId, userId, d, p, buf) {
  const persona = PERSONA.has(p.tipo);
  const nelCantiere = p.tipo === 'pos' && p.siteId;
  const destination = persona ? 'worker_documents' : nelCantiere ? 'site_documents' : 'company_documents';
  const category = persona ? (TIPO_OPERAIO[p.tipo] || CORSO_OPERAIO[p.corso] || 'altro') : nelCantiere ? 'pos' : (TIPO_IMPRESA[p.tipo] || 'altro');
  const path = `${companyId}/chat-uploads/${crypto.randomUUID()}-${sicuro(d.nome_file)}`;
  const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: d.mime_type, upsert: false });
  if (up.error) throw new Error(up.error.message);
  const { data: u, error } = await supabase.from('chat_uploads').insert({
    company_id: companyId, user_id: userId, original_name: d.nome_file || 'documento', mime_type: d.mime_type, storage_path: path, size_bytes: buf.length,
  }).select('id').single();
  if (error) { supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
  const r = await archiveChatUpload({
    uploadId: u.id, companyId, userId, destination,
    name: ETICHETTA[p.tipo] || p.titolo || 'Documento',
    siteId: nelCantiere ? p.siteId : null, workerId: persona ? p.operaio.id : null,
    category, expiryDate: p.scadenza || null, issueDate: d.letto?.dataDocumento || null, contentHash: d.content_hash,
  });
  if (r?.error) throw new Error(r.error);
  // F-421: la SOA della tua impresa porta classe e scadenza (esenzione dalla patente), se più recente
  if (p.tipo === 'soa' && p.esito === 'va_bene' && d.letto?.classifica && p.scadenza) {
    const { data: co } = await supabase.from('companies').select('soa_expiry').eq('id', companyId).maybeSingle();
    if (!co?.soa_expiry || String(co.soa_expiry).slice(0, 10) <= p.scadenza) await supabase.from('companies').update({ soa_classifica: d.letto.classifica, soa_expiry: p.scadenza }).eq('id', companyId);
  }
  // Il DURC buono porta avanti la data dell'impresa (mai indietro), come per i subappaltatori
  if (p.tipo === 'durc' && p.esito === 'va_bene' && p.scadenza) {
    const { data: co } = await supabase.from('companies').select('durc_expiry').eq('id', companyId).maybeSingle();
    if (!co?.durc_expiry || String(co.durc_expiry).slice(0, 10) < p.scadenza) await supabase.from('companies').update({ durc_expiry: p.scadenza }).eq('id', companyId);
  }
  return { tabella: destination, id: r.doc_id };
}

function datiBollaSalvata(d, ctx) {
  const p = d.proposta, l = d.letto || {};
  const cantiere = (ctx.cantieriPer[NOSTRA] || []).find(c => c.id === p.siteId);
  return {
    fornitore: p.fornitore ?? l.ragioneSociale ?? null, piva: l.piva || null, numero: p.numero ?? l.numero ?? null, data: p.data ?? l.dataDocumento ?? null,
    firmata: l.firmato ?? null, righe: p.righe ?? l.righe ?? [], cantiere: cantiere?.nome || null,
  };
}

async function salva(companyId, userId, carId) {
  const car = await caricamento(companyId, carId);
  if (car.salvato_at) throw new CaricaError(409, 'GIA_SALVATO');
  const tutte = await righe(carId);
  if (tutte.some(r => ['in_coda', 'in_lettura'].includes(r.stato))) throw new CaricaError(409, 'ANCORA_IN_LETTURA');
  const ctx = await contesto(companyId);
  const docs = tutte.filter(r => r.livello === 'documento');
  const gia = await giaPresenti(companyId, docs.map(d => d.content_hash).filter(Boolean));
  const ord = ordina(docs.map(d => ({ ...d, gia: d.content_hash ? gia.has(d.content_hash) : false })), ctx);
  const daSalvare = new Set(ord.daSalvare);
  if (!daSalvare.size) throw new CaricaError(400, 'NIENTE_DA_SALVARE');

  const ora = new Date().toISOString();
  // F-420: il verdetto prima del salvataggio delle imprese che ci sono già, per avvisare «ora può entrare»
  const giaNote = [...new Set(docs.filter(x => daSalvare.has(x.id)).map(x => x.proposta.impresa?.id).filter(id => id && id !== NOSTRA))];
  const primaDi = new Map(await Promise.all(giaNote.map(async id => [id, await L.statoImpresa(companyId, { id }).then(s => s.verdetto.stato).catch(() => null)])));
  const impreseNuove = new Map(), operaiNuovi = new Map();
  const cfUsati = new Set(ctx.operai.map(o => o.cf).filter(Boolean));
  const perImpresa = new Map();
  const conta = (subId, nome, esito) => { const x = perImpresa.get(subId) || { id: subId, nome, salvati: 0, nonVanno: 0 }; x.salvati++; if (esito === 'non_va') x.nonVanno++; perImpresa.set(subId, x); };
  const salvati = [];

  const bolleSalvate = [], fattureSalvate = [];
  const ordine = (x) => (x.proposta?.tipo === 'bolla' ? 0 : x.proposta?.tipo === 'fattura' ? 2 : 1);
  for (const d of docs.filter(x => daSalvare.has(x.id)).sort((a, b) => ordine(a) - ordine(b))) {
    const p = d.proposta;
    // F-423: la fattura, confrontata con le sue bolle (quelle salvate prima compreso)
    if (p.tipo === 'fattura') {
      const l = d.letto || {};
      const f = { fornitore: l.ragioneSociale, piva: l.piva, data: l.dataDocumento, bolle_citate: l.bolleCitate || [] };
      const bolle = await Conf.abbina(companyId, f);
      const c = Conf.confronta(bolle, { righe: l.righe || [] });
      const buf = await scarica(d.file_path);
      const path = `${companyId}/fatture/${crypto.randomUUID()}-${sicuro(d.nome_file)}`;
      const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: d.mime_type, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { data, error } = await supabase.from('fatture').insert({
        company_id: companyId, fornitore: l.ragioneSociale || null, fornitore_piva: l.piva || null, numero: l.numero || null, data: l.dataDocumento || null,
        totale: l.totale ?? null, righe: l.righe || [], bolle_citate: l.bolleCitate || [], esito: c.esito, confronto: c,
        file_path: path, mime_type: d.mime_type, content_hash: d.content_hash, origine: car.origine === 'email' ? 'email' : 'carica', created_by: userId || null,
      }).select('id').single();
      if (error) { supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
      if (bolle.length) dbErr((await supabase.from('bolle').update({ fattura_id: data.id }).in('id', bolle.map(b => b.id)).eq('company_id', companyId)).error);
      salvati.push({ tabella: 'fatture', id: data.id });
      fattureSalvate.push({ id: data.id, fornitore: l.ragioneSociale || null, esito: c.esito, frase: c.frase, bolle: bolle.length });
      await supabase.from('imprese_caricamento_doc').update({ stato: 'salvato' }).eq('id', d.id);
      continue;
    }
    // F-422: la bolla nel suo cantiere, con i materiali
    if (p.tipo === 'bolla') {
      const v = datiBollaSalvata(d, ctx);
      const buf = await scarica(d.file_path);
      const path = `${companyId}/bolle/${crypto.randomUUID()}-${sicuro(d.nome_file)}`;
      const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: d.mime_type, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { data, error } = await supabase.from('bolle').insert({
        company_id: companyId, site_id: p.siteId, fornitore: v.fornitore, fornitore_piva: v.piva, numero: v.numero, data: v.data,
        firmata: v.firmata, righe: v.righe, file_path: path, mime_type: d.mime_type, content_hash: d.content_hash,
        origine: car.origine === 'email' ? 'email' : 'carica', created_by: userId || null,
      }).select('id').single();
      if (error) { supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
      salvati.push({ tabella: 'bolle', id: data.id });
      bolleSalvate.push({ id: data.id, siteId: p.siteId, cantiere: v.cantiere, fornitore: v.fornitore });
      await supabase.from('imprese_caricamento_doc').update({ stato: 'salvato' }).eq('id', d.id);
      continue;
    }
    if (p.impresa.id === NOSTRA) {
      salvati.push(await salvaNostro(companyId, userId || car.created_by, d, p, await scarica(d.file_path)));
      await supabase.from('imprese_caricamento_doc').update({ stato: 'salvato' }).eq('id', d.id);
      conta(NOSTRA, 'La tua impresa', p.esito);
      continue;
    }
    // L'impresa (nuova: una sola volta per partita IVA)
    let subId = p.impresa.id;
    if (!subId) {
      const k = p.impresa.nuova.piva || p.impresa.nuova.nome.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!impreseNuove.has(k)) {
        const { data, error } = await supabase.from('subcontractors').insert({
          company_id: companyId, company_name: p.impresa.nuova.nome, piva: p.impresa.nuova.piva || null, legal_address: p.impresa.nuova.sede || null, is_active: true,
        }).select('id').single();
        dbErr(error);
        impreseNuove.set(k, data.id);
      }
      subId = impreseNuove.get(k);
    }
    const nomeImpresa = ctx.imprese.find(i => i.id === subId)?.nome || p.impresa.nuova?.nome;
    const buf = await scarica(d.file_path);
    const nomeFile = sicuro(d.nome_file);
    if (PERSONA.has(p.tipo)) {
      // L'operaio (nuovo: uno solo per nome o codice fiscale)
      let opId = p.operaio?.id;
      if (!opId) {
        const nome = p.operaio?.nuovo?.nome || d.letto?.persona || 'Operaio senza nome';
        const cf = p.operaio?.nuovo?.cf && !cfUsati.has(p.operaio.nuovo.cf) ? p.operaio.nuovo.cf : null;
        const k = `${subId}|${cf || nome.toLowerCase()}`;
        if (!operaiNuovi.has(k)) {
          const { data, error } = await supabase.from('sub_workers').insert({ company_id: companyId, subcontractor_id: subId, full_name: nome, fiscal_code: cf, added_via: 'ufficio' }).select('id').single();
          dbErr(error);
          if (cf) cfUsati.add(cf);
          operaiNuovi.set(k, data.id);
        }
        opId = operaiNuovi.get(k);
      }
      const path = `${companyId}/sub_workers/${opId}/${crypto.randomUUID()}-${nomeFile}`;
      const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: d.mime_type, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { data, error } = await supabase.from('sub_worker_documenti').insert({
        company_id: companyId, sub_worker_id: opId, tipo: p.tipo === 'attestato' ? 'altro' : p.tipo, titolo: p.tipo === 'attestato' ? p.titolo : null,
        scadenza: p.scadenza || null, file_path: path, mime_type: d.mime_type, dall_impresa: false,
        esito: p.esito, esito_motivo: p.motivo ? JSON.stringify(p.motivo) : null, content_hash: d.content_hash,
      }).select('id').single();
      dbErr(error);
      salvati.push({ tabella: 'sub_worker_documenti', id: data.id });
    } else {
      const path = `${companyId}/subcontractors/${subId}/${crypto.randomUUID()}-${nomeFile}`;
      const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: d.mime_type, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const cantiere = p.siteId ? (ctx.cantieriPer[subId] || []).find(c => c.id === p.siteId) : null;
      const { data, error } = await supabase.from('subcontractor_documents').insert({
        company_id: companyId, subcontractor_id: subId, site_id: p.tipo === 'pos' ? p.siteId : null,
        name: p.tipo === 'pos' && cantiere ? `POS · ${cantiere.nome}` : ETICHETTA[p.tipo] || p.titolo || 'Documento',
        category: CATEGORIA[p.tipo] || 'altro', file_path: path, file_size: buf.length, mime_type: d.mime_type,
        valid_until: p.esito === 'va_bene' ? p.scadenza || null : null,
        ai_validity_ok: p.esito === 'non_va' ? false : p.esito === 'va_bene' ? true : null, ai_analyzed_at: ora,
        dall_impresa: false, visto_at: ora, uploaded_by: userId || null,
        esito: p.esito, esito_motivo: p.motivo ? JSON.stringify(p.motivo) : null, content_hash: d.content_hash,
      }).select('id').single();
      dbErr(error);
      salvati.push({ tabella: 'subcontractor_documents', id: data.id });
      // F-427: il POS per un cantiere lo controlla subito l'impresa principale (in background)
      if (p.tipo === 'pos' && p.siteId) require('../posImprese').avvia(companyId, p.siteId, subId);
      // Un documento buono porta avanti la data sull'impresa (mai indietro), come dal link
      if (p.esito === 'va_bene') {
        const campo = p.tipo === 'durc' ? ['durc_expiry', p.scadenza] : p.tipo === 'visura' ? ['visura_date', d.letto?.dataDocumento] : p.tipo === 'assicurazione' ? ['insurance_expiry', p.scadenza] : null;
        if (campo && campo[1]) {
          const { data: row } = await supabase.from('subcontractors').select(campo[0]).eq('id', subId).maybeSingle();
          if (!row?.[campo[0]] || String(row[campo[0]]) < campo[1]) await supabase.from('subcontractors').update({ [campo[0]]: campo[1] }).eq('id', subId);
        }
        if (p.tipo === 'soa') await L.portaAvantiSoa(subId, d.letto?.classifica, p.scadenza);  // F-419: esenzione dalla patente
        // Un'impresa «da completare»: la visura o il DURC buoni portano nome, partita IVA e sede
        const imp = ctx.imprese.find(i => i.id === subId);
        if (imp?.daCompletare && ['visura', 'durc'].includes(p.tipo) && d.letto?.ragioneSociale && d.letto?.piva) {
          await supabase.from('subcontractors').update({ company_name: d.letto.ragioneSociale, piva: d.letto.piva, legal_address: d.letto.sede || null, da_completare: false }).eq('id', subId);
        }
      }
    }
    await supabase.from('imprese_caricamento_doc').update({ stato: 'salvato' }).eq('id', d.id);
    conta(subId, nomeImpresa, p.esito);
  }

  // Il resto non si salva: via i file del caricamento
  await supabase.from('imprese_caricamento_doc').update({ stato: 'scartato' }).eq('caricamento_id', carId).eq('livello', 'documento').eq('stato', 'pronto');
  const paths = [...new Set(tutte.map(r => r.file_path).filter(Boolean))];
  for (let i = 0; i < paths.length; i += 100) await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100)).catch(() => {});

  // Verifica: le righe ci sono davvero
  const perTabella = salvati.reduce((m, x) => { (m[x.tabella] ||= []).push(x.id); return m; }, {});
  const conteggi = await Promise.all(Object.entries(perTabella).map(([t, ids]) => supabase.from(t).select('id', { count: 'exact', head: true }).in('id', ids.filter(Boolean))));
  const verificati = conteggi.reduce((t, c) => t + (c.count || 0), 0);
  const imprese = [...perImpresa.values()];
  const nonVanno = imprese.reduce((t, x) => t + x.nonVanno, 0);
  // F-422: le bolle, per cantiere
  const perCantiere = new Map();
  for (const b of bolleSalvate) { const x = perCantiere.get(b.siteId) || { siteId: b.siteId, cantiere: b.cantiere, n: 0 }; x.n++; perCantiere.set(b.siteId, x); }
  const bolle = [...perCantiere.values()];
  const esito = { salvati: salvati.length, imprese, bolle, fatture: fattureSalvate, impreseNuove: impreseNuove.size, operaiNuovi: operaiNuovi.size, nonVanno };
  await supabase.from('imprese_caricamenti').update({ salvato_at: ora, esito }).eq('id', carId);
  const { avvisaSeOraPronta } = require('../impreseAvviso');
  for (const [id, prima] of primaDi) if (prima && prima !== 'si') await avvisaSeOraPronta(companyId, id, prima);
  const nDoc = salvati.length - bolleSalvate.length - fattureSalvate.length;
  const nonTornano = fattureSalvate.filter(x => x.esito === 'non_torna').length;
  const frase = [
    nDoc ? `${nDoc === 1 ? 'Un documento salvato' : `${nDoc} documenti salvati`} per ${imprese.length === 1 ? (imprese[0].id === NOSTRA ? 'la tua impresa' : imprese[0].nome) : `${imprese.length} imprese`}` : null,
    bolle.length ? `${bolleSalvate.length === 1 ? 'una bolla' : `${bolleSalvate.length} bolle`} ${bolle.length === 1 ? `nel cantiere ${bolle[0].cantiere}` : `in ${bolle.length} cantieri`}` : null,
    fattureSalvate.length ? `${fattureSalvate.length === 1 ? 'una fattura' : `${fattureSalvate.length} fatture`}${nonTornano ? ` (${nonTornano === 1 ? 'una non torna' : `${nonTornano} non tornano`} con le bolle)` : ''}` : null,
    impreseNuove.size ? `${impreseNuove.size === 1 ? 'un\'impresa nuova aggiunta' : `${impreseNuove.size} imprese nuove aggiunte`}` : null,
    operaiNuovi.size ? `${operaiNuovi.size === 1 ? 'un operaio nuovo' : `${operaiNuovi.size} operai nuovi`}` : null,
  ].filter(Boolean).join(', ');
  return {
    ...esito,
    resultCard: {
      id: carId, title: 'Documenti salvati',
      fatto: {
        verified: verificati === salvati.length, verdict: { kind: 'none' },
        after: `${frase}.${nonVanno ? ` ${nonVanno === 1 ? 'Uno non va' : `${nonVanno} non vanno`}: lo trovi nella scheda dell'impresa, col motivo.` : ''}`,
        ...(verificati === salvati.length ? {} : { mismatchWarning: `Ne risultano ${verificati} su ${salvati.length}: ricarica la pagina dell'impresa.` }),
      },
    },
  };
}

module.exports = { crea, aggiungi, lavora, stato, apri, correggi, salva, contesto, pezziValidi, CaricaError };
