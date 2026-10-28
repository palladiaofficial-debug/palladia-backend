'use strict';
/**
 * lib/contratti/index.js — F-398 (AUDIT.md del frontend): «Fai il contratto»
 * da Imprese › scheda dell'impresa.
 *
 *  prepara()     → i dati già noti (azienda dal profilo, impresa dalla sua scheda),
 *                  cosa manca, i cantieri, le clausole con le scelte dell'ultima volta
 *  visura()      → legge la visura (nome, P.IVA, sede, REA, PEC, legale rappresentante)
 *                  e la salva anche come «Visura camerale» dell'impresa, col controllo di sempre
 *  genera()      → controlla i dati (P.IVA vere, MAI la stessa per le due parti: F-398),
 *                  scrive il PDF, lo archivia (impresa e cantiere) e ricorda chi firma
 *  elenco(), scarica()
 *
 * Prima (fino al 28/10) il contratto lo scriveva Ladia a mano in chat, col
 * generatore congelato: è venuto fuori con la P.IVA dell'impresa in subappalto
 * anche sull'affidataria. Qui i due blocchi di dati vengono da due posti
 * diversi e il codice rifiuta una partita IVA uguale o non valida.
 */
const crypto = require('crypto');
const supabase = require('../supabase');
const { renderHtmlToPdf } = require('../../pdf-renderer');
const L = require('../impreseLink');
const C = require('./clausole');
const { contrattoHtml } = require('./documento');
const { leggiVisura } = require('./visura');

const BUCKET = 'site-documents';
class ContrattoError extends Error { constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; Object.assign(this, extra); } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const t = (v, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);
const dataOk = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);

async function azienda(companyId) {
  const { data, error } = await supabase.from('companies')
    .select('id, name, piva, vat_number, address, city, province, legale_rappresentante').eq('id', companyId).maybeSingle();
  dbErr(error);
  if (!data) throw new ContrattoError(404, 'NOT_FOUND');
  const piva = C.pivaPulita(data.piva || data.vat_number);
  const sede = [data.address, data.city, data.province ? `(${data.province})` : null].filter(Boolean).join(', ').replace(', (', ' (') || null;
  return { ragioneSociale: data.name, piva: piva || null, sede, citta: data.city || null, legaleRappresentante: data.legale_rappresentante || null };
}

async function impresa(companyId, subId) {
  const { data, error } = await supabase.from('subcontractors')
    .select('id, company_name, piva, legal_address, codice_fiscale, rea, pec, legale_rappresentante, durc_expiry, visura_date, da_completare')
    .eq('id', subId).eq('company_id', companyId).eq('is_active', true).maybeSingle();
  dbErr(error);
  if (!data) throw new ContrattoError(404, 'NOT_FOUND');
  return data;
}
const datiImpresa = (s) => ({
  ragioneSociale: s.da_completare ? null : s.company_name, piva: C.pivaPulita(s.piva) || null, sede: s.legal_address || null,
  codiceFiscale: s.codice_fiscale || null, rea: s.rea || null, pec: s.pec || null, legaleRappresentante: s.legale_rappresentante || null,
});
const mancanti = (p) => ['ragioneSociale', 'piva', 'sede', 'legaleRappresentante'].filter(k => !p[k] || (k === 'piva' && !C.pivaValida(p[k])));

async function prepara(companyId, subId) {
  const [A, S] = await Promise.all([azienda(companyId), impresa(companyId, subId)]);
  const [sitiRes, suoiRes, precRes, ultimaRes] = await Promise.all([
    supabase.from('sites').select('id, name, address, city, client_name').eq('company_id', companyId).in('status', ['attivo', 'sospeso']).order('name'),
    supabase.from('site_subcontractors').select('site_id').eq('company_id', companyId).eq('subcontractor_id', subId),
    supabase.from('contratti_subappalto').select('id, site_id, created_at, dati').eq('company_id', companyId).eq('subcontractor_id', subId).order('created_at', { ascending: false }).limit(10),
    supabase.from('contratti_subappalto').select('clausole').eq('company_id', companyId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const r of [sitiRes, suoiRes, precRes, ultimaRes]) dbErr(r.error);
  const suoi = new Set((suoiRes.data || []).map(r => r.site_id));
  const cantieri = (sitiRes.data || []).map(s => ({
    id: s.id, nome: s.name, indirizzo: [s.address, s.city].filter(Boolean).join(', ') || s.name, committente: s.client_name || null, suo: suoi.has(s.id),
  })).sort((a, b) => Number(b.suo) - Number(a.suo));
  const sub = datiImpresa(S);
  return {
    affidataria: A, subappaltatrice: sub,
    mancano: { affidataria: mancanti(A), subappaltatrice: mancanti(sub) },
    nome: S.company_name, durcScadenza: S.durc_expiry || null, visuraData: S.visura_date ? String(S.visura_date).slice(0, 10) : null,
    cantieri,
    clausole: C.CLAUSOLE, sempre: C.SEMPRE,
    // Le scelte dell'ultimo contratto fatto: chi ha le sue abitudini non le rifà ogni volta
    scelte: C.scelteComplete(ultimaRes.data?.clausole), comeUltimaVolta: !!ultimaRes.data,
    precedenti: (precRes.data || []).map(c => ({ id: c.id, at: c.created_at, cantiere: c.dati?.lavoro?.cantiere || null, lavoro: c.dati?.lavoro?.descrizione || null })),
  };
}

/** La visura: legge i dati per il contratto e la archivia come documento dell'impresa. */
async function visura(companyId, userId, subId, file, { chiedi, chiediControllo } = {}) {
  const S = await impresa(companyId, subId);
  const letto = await leggiVisura({ file, companyId, chiedi });
  if (!letto.eUnaVisura) throw new ContrattoError(422, 'NON_E_UNA_VISURA');
  const pivaNota = C.pivaPulita(S.piva);
  const altraImpresa = !!(letto.piva && pivaNota && C.pivaValida(pivaNota) && letto.piva !== pivaNota);
  let documento = null;
  if (!altraImpresa) {
    try {
      const r = await L.caricaDalTitolare(companyId, userId, subId, { tipo: 'visura', file }, chiediControllo);
      documento = { esito: r.esito, scadenza: r.scadenza };
    } catch (err) { documento = { esito: null, errore: err.message }; }
  }
  return { letto, altraImpresa, documento };
}

/** Normalizza e controlla il corpo di «Prepara il contratto». Puro. */
function controlla(b, { pivaAzienda } = {}) {
  const parte = (p = {}) => ({
    ragioneSociale: t(p.ragioneSociale, 200), piva: C.pivaPulita(t(p.piva, 20)) || null, sede: t(p.sede, 250),
    codiceFiscale: t(p.codiceFiscale, 20)?.toUpperCase() || null, rea: t(p.rea, 30)?.toUpperCase() || null,
    pec: t(p.pec, 120)?.toLowerCase() || null, legaleRappresentante: t(p.legaleRappresentante, 120), citta: t(p.citta, 80),
  });
  const A = parte(b.affidataria), S = parte(b.subappaltatrice);
  const lw = b.lavoro || {};
  const lavoro = {
    siteId: typeof lw.siteId === 'string' && /^[0-9a-f-]{36}$/i.test(lw.siteId) ? lw.siteId : null,
    cantiere: t(lw.cantiere, 250), committente: t(lw.committente, 200), descrizione: t(lw.descrizione, 1500),
    inizio: dataOk(lw.inizio), fine: dataOk(lw.fine),
    durataGiorni: Number.isInteger(lw.durataGiorni) && lw.durataGiorni > 0 && lw.durataGiorni < 2000 ? lw.durataGiorni : null,
    costiSicurezza: lw.costiSicurezza === null || lw.costiSicurezza === undefined || lw.costiSicurezza === '' ? null : Number(lw.costiSicurezza),
    cig: t(lw.cig, 20), cup: t(lw.cup, 20),
  };
  const pr = b.prezzo || {};
  const modo = ['corpo', 'misura', 'tabella'].includes(pr.modo) ? pr.modo : null;
  const voci = Array.isArray(pr.voci) ? pr.voci.slice(0, 40).map(v => ({
    descrizione: t(v?.descrizione, 200), um: t(v?.um, 12), quantita: Number(v?.quantita), prezzo: Number(v?.prezzo),
  })) : [];
  const prezzo = { modo, importo: modo === 'corpo' ? Number(pr.importo) : null, voci: modo === 'misura' ? voci : [] };

  const campi = [];
  for (const [nome, p] of [['affidataria', A], ['subappaltatrice', S]]) {
    for (const k of ['ragioneSociale', 'sede', 'legaleRappresentante']) if (!p[k]) campi.push(`${nome}.${k}`);
    if (!p.piva || !C.pivaValida(p.piva)) campi.push(`${nome}.piva`);
  }
  if (!lavoro.descrizione) campi.push('lavoro.descrizione');
  if (!lavoro.cantiere) campi.push('lavoro.cantiere');
  if (lavoro.inizio && lavoro.fine && lavoro.fine < lavoro.inizio) campi.push('lavoro.fine');
  if (lavoro.costiSicurezza != null && !(lavoro.costiSicurezza >= 0)) campi.push('lavoro.costiSicurezza');
  if (!modo) campi.push('prezzo.modo');
  if (modo === 'corpo' && !(prezzo.importo > 0)) campi.push('prezzo.importo');
  if (modo === 'misura' && (!voci.length || voci.some(v => !v.descrizione || !(v.quantita > 0) || !(v.prezzo > 0)))) campi.push('prezzo.voci');
  if (campi.length) throw new ContrattoError(400, 'DATI_MANCANTI', { campi });
  // F-398: la stessa partita IVA su tutte e due le parti è l'errore del 28/10
  if (A.piva === S.piva) throw new ContrattoError(400, 'STESSA_PIVA');
  // L'affidataria siamo noi: la sua P.IVA è quella del profilo, se il profilo ce l'ha
  if (pivaAzienda && C.pivaValida(pivaAzienda) && A.piva !== pivaAzienda) throw new ContrattoError(400, 'PIVA_AZIENDA_DIVERSA');
  return { affidataria: A, subappaltatrice: S, lavoro, prezzo, luogo: t(b.luogo, 80) || A.citta || null, scelte: C.scelteComplete(b.scelte) };
}

async function genera(companyId, userId, subId, body, { render = renderHtmlToPdf } = {}) {
  const [Adb, S] = await Promise.all([azienda(companyId), impresa(companyId, subId)]);
  const d = controlla(body, { pivaAzienda: Adb.piva });
  d.affidataria.citta = d.affidataria.citta || Adb.citta;
  if (d.lavoro.siteId) {
    const { data: site, error } = await supabase.from('sites').select('id, name').eq('id', d.lavoro.siteId).eq('company_id', companyId).maybeSingle();
    dbErr(error);
    if (!site) d.lavoro.siteId = null;
    else d.lavoro.cantiereNome = site.name;
  }
  const html = contrattoHtml(d, d.scelte);
  const pdf = await render(html, { docTitle: 'Contratto di subappalto', footerLeft: `Contratto di subappalto — ${d.subappaltatrice.ragioneSociale}` });
  const path = `${companyId}/subcontractors/${subId}/contratti/${crypto.randomUUID()}.pdf`;
  const up = await supabase.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(up.error.message);
  const { scelte, ...dati } = d;
  const ins = await supabase.from('contratti_subappalto').insert({
    company_id: companyId, subcontractor_id: subId, site_id: d.lavoro.siteId, dati, clausole: scelte, file_path: path, created_by: userId || null,
  }).select('id, created_at').single();
  if (ins.error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(ins.error.message); }

  const titolo = `Contratto di subappalto — ${d.subappaltatrice.ragioneSociale}`;
  // Anche tra i documenti del cantiere, dove lo cerca chi apre il cantiere
  let nelCantiere = false;
  if (d.lavoro.siteId) {
    const { error } = await supabase.from('site_documents').insert({
      company_id: companyId, site_id: d.lavoro.siteId, name: titolo, category: 'contratto',
      file_path: path, mime_type: 'application/pdf', file_size: pdf.length,
    });
    nelCantiere = !error;
  }
  // Chi firma resta scritto: la prossima volta i dati sono già lì
  const sub = d.subappaltatrice;
  await supabase.from('subcontractors').update({
    company_name: sub.ragioneSociale, piva: sub.piva, legal_address: sub.sede, codice_fiscale: sub.codiceFiscale,
    rea: sub.rea, pec: sub.pec, legale_rappresentante: sub.legaleRappresentante, da_completare: false,
  }).eq('id', S.id).eq('company_id', companyId);
  const perAzienda = { legale_rappresentante: d.affidataria.legaleRappresentante };
  // Il profilo si completa, non si sovrascrive: P.IVA e sede solo se mancavano
  if (!Adb.piva) perAzienda.piva = d.affidataria.piva;
  if (!Adb.sede) perAzienda.address = d.affidataria.sede;
  await supabase.from('companies').update(perAzienda).eq('id', companyId);

  // Verifica: la riga c'è davvero e il file si scarica
  const { data: check } = await supabase.from('contratti_subappalto').select('id').eq('id', ins.data.id).maybeSingle();
  const firmata = await supabase.storage.from(BUCKET).createSignedUrl(path, 600);
  const dove = [`nei documenti di ${S.company_name || sub.ragioneSociale}`, nelCantiere ? `del cantiere ${d.lavoro.cantiereNome}` : null].filter(Boolean).join(' e ');
  return {
    id: ins.data.id,
    url: firmata.data?.signedUrl || null,
    suggerimenti: C.suggerimenti(d, scelte, { durcScadenza: S.durc_expiry, visuraData: S.visura_date ? String(S.visura_date).slice(0, 10) : null }),
    resultCard: {
      id: ins.data.id,
      title: 'Contratto pronto',
      fatto: { verified: !!check && !!firmata.data?.signedUrl, verdict: { kind: 'none' }, after: `Salvato ${dove}.` },
      inMano: { label: 'Contratto di subappalto (PDF)', downloadUrl: firmata.data?.signedUrl || undefined, exportType: 'contratto_subappalto' },
    },
  };
}

async function elenco(companyId, subId) {
  const { data, error } = await supabase.from('contratti_subappalto').select('id, created_at, dati')
    .eq('company_id', companyId).eq('subcontractor_id', subId).order('created_at', { ascending: false }).limit(20);
  dbErr(error);
  return (data || []).map(c => ({ id: c.id, at: c.created_at, cantiere: c.dati?.lavoro?.cantiere || null, lavoro: c.dati?.lavoro?.descrizione || null }));
}

async function scarica(companyId, id) {
  const { data, error } = await supabase.from('contratti_subappalto').select('file_path').eq('id', id).eq('company_id', companyId).maybeSingle();
  dbErr(error);
  if (!data) throw new ContrattoError(404, 'NOT_FOUND');
  const r = await supabase.storage.from(BUCKET).createSignedUrl(data.file_path, 600);
  if (r.error) throw new Error(r.error.message);
  return { url: r.data.signedUrl };
}

module.exports = { prepara, visura, controlla, genera, elenco, scarica, ContrattoError };
