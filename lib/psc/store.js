'use strict';
/**
 * lib/psc/store.js — F-270. Accesso al DB del modulo coordinatori: tutto
 * filtrato per company_id del coordinatore. Caricamento del PSC completo,
 * valori iniziali di un PSC nuovo, PDF con indice numerato (due passate),
 * presenze in cantiere lette (SOLO lettura) dalle timbrature delle imprese
 * collegate.
 */
const crypto = require('crypto');
const supabase = require('../supabase');
const { ORGANIZZAZIONE, USO_COMUNE, TESTI_PROPOSTI } = require('./catalog');
const { detect } = require('./interferenze');
const { riepilogo } = require('./costi');
const { controlla } = require('./controllo');
const documento = require('./documento');
const { extractPdfText } = require('../pdfExtract');

const BUCKET = 'psc-files';
const token = () => crypto.randomBytes(24).toString('base64url');

async function getProject(companyId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const { data } = await supabase.from('psc_projects').select('*').eq('id', id).eq('company_id', companyId).is('deleted_at', null).maybeSingle();
  return data || null;
}

async function loadAll(companyId, projectId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(projectId || ''))) return null;
  const [pr, lav, imp, costi, dec, rev] = await Promise.all([
    supabase.from('psc_projects').select('*').eq('id', projectId).eq('company_id', companyId).is('deleted_at', null).maybeSingle(),
    supabase.from('psc_lavorazioni').select('*').eq('project_id', projectId).eq('company_id', companyId).order('ordine'),
    supabase.from('psc_imprese').select('*').eq('project_id', projectId).eq('company_id', companyId).order('created_at'),
    supabase.from('psc_costi').select('*').eq('project_id', projectId).eq('company_id', companyId).order('ordine'),
    supabase.from('psc_interferenze').select('*').eq('project_id', projectId).eq('company_id', companyId),
    supabase.from('psc_revisions').select('id, revision, motivo, created_at, pdf_path, signed_path, signed_name, signer, open_points').eq('project_id', projectId).eq('company_id', companyId).order('revision'),
  ]);
  const project = pr.data;
  if (!project) return null;
  return {
    project,
    lavorazioni: lav.data || [],
    imprese: imp.data || [],
    costi: costi.data || [],
    decisioni: dec.data || [],
    revisioni: rev.data || [],
  };
}

async function library(companyId, kinds = null) {
  let q = supabase.from('psc_library').select('id, kind, sezione, scheda_id, titolo, testo, data, source_name, uses').eq('company_id', companyId).limit(5000);
  if (kinds) q = q.in('kind', kinds);
  const { data } = await q;
  return data || [];
}

/** Stato calcolato: interferenze, costi, controllo. */
async function stato(companyId, all) {
  const lib = await library(companyId, ['frase']);
  const inter = detect(all.lavorazioni, all.decisioni);
  const riep = riepilogo(all.costi, all.imprese);
  const ctrl = controlla({ ...all, interferenzeAperte: inter.aperte, library: lib, riep });
  return { interferenze: inter, costiRiepilogo: riep, controllo: ctrl };
}

/** Profilo del coordinatore (dal suo account) per precompilare il CSE. */
async function profiloCse(companyId, user) {
  const [{ data: c }, { data: u }] = await Promise.all([
    supabase.from('companies').select('name, phone, email, contact_email, address, city').eq('id', companyId).maybeSingle(),
    supabase.auth.admin.getUserById(user.id).catch(() => ({ data: null })),
  ]);
  const meta = (u && u.user && u.user.user_metadata) || {};
  return {
    nome: meta.full_name || meta.name || '',
    qualifica: meta.qualifica || '',
    telefono: (c && c.phone) || meta.phone || '',
    email: user.email || (c && (c.contact_email || c.email)) || '',
    pec: '',
    studio: (c && c.name) || '',
  };
}

/** Valori iniziali di un PSC nuovo: tutto proposto, niente approvato a sua insaputa. */
async function defaults(companyId, user) {
  const lib = await library(companyId, ['frase']);
  // parola: inizio del titolo cercato nel titolo/testo della frase (minuscolo)
  const mia = (sezione, parole) => lib.filter(l => l.sezione === sezione && (!parole || parole.some(w => `${l.titolo || ''} ${l.testo}`.toLowerCase().includes(w)))).sort((a, b) => (b.uses || 0) - (a.uses || 0))[0] || null;
  const cse = await profiloCse(companyId, user);
  const organizzazione = {};
  for (const o of ORGANIZZAZIONE) {
    const m = mia('organizzazione', [o.titolo.split(/[ ,]/)[0].slice(0, 6).toLowerCase()]);
    organizzazione[o.key] = m
      ? { attivo: true, testo: m.testo, fonte: 'mia', fonte_nome: m.source_name, approvata: false }
      : { attivo: true, testo: o.testo, fonte: 'palladia', approvata: false };
  }
  const riun = mia('coordinamento', ['riunion']);
  const emProc = mia('emergenze', ['infortun', 'incendi', '112', 'soccors']);
  return {
    soggetti: { cse: { ...cse }, csp: { nome: cse.nome, qualifica: cse.qualifica } },
    organizzazione,
    uso_comune: USO_COMUNE.filter(u => u.sempre).map(u => ({ key: u.key, titolo: u.titolo, testo: u.testo, fonte: 'palladia', approvata: false })),
    coordinamento: {
      riunioni: riun ? riun.testo : TESTI_PROPOSTI.coordinamento,
      riunioni_fonte: riun ? { fonte: 'mia', nome: riun.source_name } : { fonte: 'palladia' },
      informazione: TESTI_PROPOSTI.informazione,
      approvato: false,
    },
    emergenze: {
      procedura: emProc ? emProc.testo : TESTI_PROPOSTI.emergenze_procedura,
      gestione: TESTI_PROPOSTI.gestione_emergenze,
      numeri: [],
      approvato: false,
    },
    testi: { orari: TESTI_PROPOSTI.orari },
  };
}

// ── Storage ────────────────────────────────────────────────────────────────────
async function upload(path, buffer, contentType) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
  return path;
}
async function download(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) throw error || new Error('file non trovato');
  return Buffer.from(await data.arrayBuffer());
}
async function signedUrl(path, seconds = 600, downloadName = null) {
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined);
  return data ? data.signedUrl : null;
}
async function dataUri(path, mime) {
  try { const b = await download(path); return `data:${mime};base64,${b.toString('base64')}`; } catch { return null; }
}

// ── PDF del PSC con indice numerato ───────────────────────────────────────────
async function renderPsc(all, deps = {}) {
  const render = deps.render || ((html, opts) => require('../../pdf-renderer').rendererPool.render(html, opts));
  const p = all.project;
  let layoutDataUri = null;
  if (p.layout_path && /\.(png|jpe?g|webp)$/i.test(p.layout_path)) {
    const ext = p.layout_path.split('.').pop().toLowerCase();
    layoutDataUri = await dataUri(p.layout_path, ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
  }
  const snap = { ...all, layoutDataUri };
  const cse = (p.soggetti && p.soggetti.cse) || {};
  const opts = {
    docTitle: `PSC · ${p.title}`,
    headerLeft: cse.studio || cse.nome || 'PSC',
    footerLeft: 'D.Lgs. 81/2008 · Allegato XV',
    revision: String(p.revision || 0), // stringa: il piè di pagina tratta 0 come "manca"
  };
  // 1ª passata: dove cade ogni sezione
  const first = await render(documento.pscHtml(snap), opts);
  const pagine = {};
  try {
    const { text } = await extractPdfText(first, { maxPages: 400, minChars: 1 });
    const pages = String(text || '').split(/--- Pagina (\d+) ---/);
    // pages = ['', '1', testo1, '2', testo2, ...]
    const byPage = [];
    for (let i = 1; i < pages.length; i += 2) byPage.push({ n: Number(pages[i]), t: pages[i + 1] || '' });
    for (const [n, titolo] of documento.SEZIONI) {
      // Prima "N Titolo" (il titolo di sezione), poi il solo titolo.
      const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ');
      const exact = `${n} ${titolo.slice(0, 24).toLowerCase()}`;
      const loose = titolo.slice(0, 28).toLowerCase();
      const hit = byPage.find(pg => pg.n > 1 && norm(pg.t).includes(exact)) || byPage.find(pg => pg.n > 1 && norm(pg.t).includes(loose));
      if (hit) pagine[n] = hit.n;
    }
  } catch { /* indice senza numeri piuttosto che nessun PDF */ }
  if (!Object.keys(pagine).length) return first;
  return render(documento.pscHtml(snap, { pagine }), opts);
}

// ── Presenze dalle timbrature delle imprese collegate (sola lettura) ─────────
async function presenzeOggi(imprese) {
  const linked = imprese.filter(i => i.linked_company_id && i.linked_site_id);
  if (!linked.length) return null;
  const startRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  startRome.setHours(0, 0, 0, 0);
  const since = new Date(Date.now() - 18 * 3600000).toISOString();
  const perImpresa = [];
  let totale = 0;
  for (const i of linked) {
    const { data } = await supabase.from('presence_logs')
      .select('worker_id, event_type, timestamp_server')
      .eq('company_id', i.linked_company_id).eq('site_id', i.linked_site_id)
      .gte('timestamp_server', since).order('timestamp_server', { ascending: true }).limit(2000);
    const last = new Map();
    for (const r of data || []) last.set(r.worker_id, r.event_type);
    const n = [...last.values()].filter(e => e === 'ENTRY').length;
    totale += n;
    perImpresa.push({ impresa_id: i.id, ragione_sociale: i.ragione_sociale, n });
  }
  return { totale, perImpresa, fonte: 'timbrature' };
}

module.exports = { BUCKET, token, getProject, loadAll, library, stato, defaults, profiloCse, upload, download, signedUrl, dataUri, renderPsc, presenzeOggi };
