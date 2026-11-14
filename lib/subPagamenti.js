'use strict';
/**
 * lib/subPagamenti.js — F-497 (AUDIT.md del frontend): Subappaltatori, lavori e pagamenti.
 * Disegno approvato il 14/11: https://claude.ai/artifact/37hM1AV9iusMz21VKhEVPp
 *
 * Un accordo per impresa e cantiere:
 *  - a corpo: una cifra (e il contratto); il lavoro si segna a quarti con una foto
 *  - a ore: €/ora, una giornata = ore_giornata ore
 *  - a giornata: €/giorno, le mezze contano metà
 * Le giornate vengono dal QR (persone diverse entrate quel giorno, sub_presenze)
 * o si segnano a mano: la mano vince. Palladia dice sempre quanto è pagato,
 * quanto manca alla cifra pattuita e quanto gli devi adesso per il lavoro fatto.
 *
 * Niente contabilità: niente ritenute, computo, capitolato, margini.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { isFeatureEnabled } = require('./featureFlags');

const FLAG = 'conti_sub';
const BUCKET = 'site-documents';
const MODI = ['contanti', 'assegno', 'bonifico', 'altro'];
const TIPI = ['corpo', 'ore', 'giornata'];
const LIMITE_CONTANTI = 5000; // dal 2023 pagamenti in contanti solo sotto i 5.000 €
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

class SubError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const romaGiorno = (ts) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const oggi = () => romaGiorno(Date.now());
const valida = (d) => DATA.test(String(d || '')) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

async function attivo(companyId) {
  try { return await isFeatureEnabled(companyId, FLAG); } catch { return false; }
}

/** I numeri di un accordo. giornate: totale; pagato: somma dei pagamenti. */
function numeri(acc, giornate, pagato) {
  const p = r2(pagato || 0);
  let lavorato;
  if (acc.tipo === 'corpo') lavorato = r2(Number(acc.importo) * (acc.fatto_quarti || 0) / 4);
  else if (acc.tipo === 'ore') lavorato = r2(giornate * Number(acc.ore_giornata) * Number(acc.tariffa));
  else lavorato = r2(giornate * Number(acc.tariffa));
  const adesso = r2(lavorato - p);
  const manca = acc.tipo === 'corpo' ? r2(Math.max(0, Number(acc.importo) - p)) : null;
  let stato;
  if (acc.tipo === 'corpo' && p >= Number(acc.importo) - 0.005) stato = 'tutto';
  else if (adesso > 0.005) stato = 'deve';
  else if (adesso < -0.005) stato = 'anticipo';
  else stato = 'pari';
  return { lavorato, pagato: p, adesso, manca, stato, giornate };
}

/** Giornate per giorno: QR (persone diverse entrate) sovrascritto dalle righe a mano. */
async function giornate(companyId, acc, { da, a } = {}) {
  let q = supabase.from('sub_presenze').select('sub_worker_id, at')
    .eq('company_id', companyId).eq('site_id', acc.site_id).eq('subcontractor_id', acc.subcontractor_id)
    .eq('event', 'entrata').is('annullata_at', null);
  if (da) q = q.gte('at', `${da}T00:00:00+02:00`);
  if (a) q = q.lte('at', `${a}T23:59:59+01:00`);
  const { data: pres, error } = await q.limit(20000);
  dbErr(error);
  const qr = new Map();
  for (const p of pres || []) {
    const g = romaGiorno(p.at);
    if ((da && g < da) || (a && g > a)) continue;
    if (!qr.has(g)) qr.set(g, new Set());
    qr.get(g).add(p.sub_worker_id);
  }
  let m = supabase.from('sub_giorni').select('giorno, giornate').eq('accordo_id', acc.id);
  if (da) m = m.gte('giorno', da);
  if (a) m = m.lte('giorno', a);
  const { data: mano, error: e2 } = await m;
  dbErr(e2);
  const out = new Map();
  for (const [g, s] of qr) out.set(g, { giornate: s.size, qr: s.size, fonte: 'qr' });
  for (const r of mano || []) out.set(r.giorno, { giornate: Number(r.giornate), qr: qr.get(r.giorno)?.size ?? 0, fonte: 'mano' });
  return out;
}
const somma = (mappa) => r2([...mappa.values()].reduce((s, v) => s + v.giornate, 0));

async function accordo(companyId, id) {
  if (!UUID.test(String(id))) throw new SubError(404, 'NOT_FOUND');
  const { data, error } = await supabase.from('sub_accordi')
    .select('*, subcontractors(company_name), sites(name, address)')
    .eq('id', id).eq('company_id', companyId).maybeSingle();
  dbErr(error);
  if (!data) throw new SubError(404, 'NOT_FOUND');
  return data;
}

function testa(acc) {
  return {
    id: acc.id, tipo: acc.tipo,
    impresa: { id: acc.subcontractor_id, nome: acc.subcontractors?.company_name || 'Impresa' },
    cantiere: { id: acc.site_id, nome: acc.sites?.name || acc.sites?.address || 'Cantiere' },
    importo: acc.importo != null ? Number(acc.importo) : null,
    tariffa: acc.tariffa != null ? Number(acc.tariffa) : null,
    oreGiornata: Number(acc.ore_giornata), fattoQuarti: acc.fatto_quarti, fattoAt: acc.fatto_at,
    dataAccordo: acc.data_accordo, contratto: acc.contratto_path ? { nome: acc.contratto_nome || 'Contratto' } : null,
  };
}

async function pagatiPer(companyId, ids) {
  const out = new Map(ids.map(i => [i, { totale: 0, ultimo: null, n: 0 }]));
  if (!ids.length) return out;
  const { data, error } = await supabase.from('sub_pagamenti').select('accordo_id, importo, data, modo')
    .eq('company_id', companyId).in('accordo_id', ids);
  dbErr(error);
  for (const p of data || []) {
    const o = out.get(p.accordo_id);
    o.totale = r2(o.totale + Number(p.importo)); o.n++;
    if (!o.ultimo || p.data > o.ultimo) o.ultimo = p.data;
  }
  return out;
}

async function righe(companyId, filtro = {}) {
  let q = supabase.from('sub_accordi').select('*, subcontractors(company_name), sites(name, address)')
    .eq('company_id', companyId).order('created_at', { ascending: true });
  if (filtro.subcontractorId) q = q.eq('subcontractor_id', filtro.subcontractorId);
  const { data: accs, error } = await q;
  dbErr(error);
  const pag = await pagatiPer(companyId, (accs || []).map(a => a.id));
  const out = [];
  for (const a of accs || []) {
    const g = a.tipo === 'corpo' ? 0 : somma(await giornate(companyId, a));
    const p = pag.get(a.id);
    out.push({ ...testa(a), ...numeri(a, g, p.totale), pagamenti: p.n, ultimoPagamento: p.ultimo });
  }
  return out;
}

/** Economia › Subappaltatori: tutti gli accordi e i tre numeri in cima. */
async function elenco(companyId) {
  const r = await righe(companyId);
  const anno = oggi().slice(0, 4);
  const { data: pa, error } = await supabase.from('sub_pagamenti').select('importo, modo, data')
    .eq('company_id', companyId).gte('data', `${anno}-01-01`);
  dbErr(error);
  const deve = r.filter(x => x.stato === 'deve');
  return {
    righe: r,
    totali: {
      adesso: r2(deve.reduce((s, x) => s + x.adesso, 0)),
      imprese: new Set(deve.map(x => x.impresa.id)).size,
      pagatoAnno: r2((pa || []).reduce((s, x) => s + Number(x.importo), 0)),
      pagamentiAnno: (pa || []).length,
      contantiAnno: (pa || []).filter(x => x.modo === 'contanti').length,
      manca: r2(r.filter(x => x.tipo === 'corpo').reduce((s, x) => s + (x.manca || 0), 0)),
    },
  };
}

async function impresa(companyId, subId) {
  if (!UUID.test(String(subId))) throw new SubError(404, 'NOT_FOUND');
  return righe(companyId, { subcontractorId: subId });
}

async function firma(path, secondi = 600) {
  if (!path) return null;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, secondi);
  return data?.signedUrl || null;
}

/** Il conto di un accordo, con il mese del calendario (YYYY-MM). */
async function conto(companyId, id, mese) {
  const acc = await accordo(companyId, id);
  const m = /^\d{4}-\d{2}$/.test(String(mese || '')) ? mese : oggi().slice(0, 7);
  const [y, mm] = m.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  const tutte = await giornate(companyId, acc);
  const delMese = [...tutte.entries()].filter(([g]) => g.startsWith(m)).map(([giorno, v]) => ({ giorno, ...v })).sort((a, b) => a.giorno.localeCompare(b.giorno));
  const perMese = {};
  for (const [g, v] of tutte) perMese[g.slice(0, 7)] = r2((perMese[g.slice(0, 7)] || 0) + v.giornate);

  const { data: pag, error } = await supabase.from('sub_pagamenti').select('id, importo, modo, riferimento, data, prova_path, created_at')
    .eq('accordo_id', acc.id).order('data', { ascending: false }).order('created_at', { ascending: false });
  dbErr(error);
  const pagato = (pag || []).reduce((s, p) => s + Number(p.importo), 0);
  const { data: lavori, error: e2 } = await supabase.from('sub_lavori').select('id, nome, quarti, ordine').eq('accordo_id', acc.id).order('ordine').order('created_at');
  dbErr(e2);
  const { data: foto, error: e3 } = await supabase.from('sub_foto').select('id, path, quarti, created_at').eq('accordo_id', acc.id).order('created_at', { ascending: false }).limit(12);
  dbErr(e3);
  const fotoTot = (await supabase.from('sub_foto').select('id', { count: 'exact', head: true }).eq('accordo_id', acc.id)).count || 0;

  return {
    ...testa(acc),
    ...numeri(acc, acc.tipo === 'corpo' ? 0 : somma(tutte), pagato),
    contrattoUrl: await firma(acc.contratto_path),
    pagamenti: await Promise.all((pag || []).map(async p => ({ id: p.id, importo: Number(p.importo), modo: p.modo, riferimento: p.riferimento, data: p.data, prova: p.prova_path ? await firma(p.prova_path) : null }))),
    lavori: (lavori || []).map(l => ({ id: l.id, nome: l.nome, quarti: l.quarti })),
    foto: await Promise.all((foto || []).map(async f => ({ id: f.id, url: await firma(f.path), quarti: f.quarti, at: f.created_at }))),
    fotoTotali: fotoTot,
    calendario: { mese: m, giorni: ultimo, righe: delMese, totale: r2(delMese.reduce((s, d) => s + d.giornate, 0)) },
    giornateInCantiere: somma(tutte), perMese,
    oggi: oggi(),
  };
}

async function opzioni(companyId) {
  const [{ data: subs, error: e1 }, { data: sites, error: e2 }, { data: accs, error: e3 }] = await Promise.all([
    supabase.from('subcontractors').select('id, company_name').eq('company_id', companyId).order('company_name'),
    supabase.from('sites').select('id, name, address, status').eq('company_id', companyId).order('name'),
    supabase.from('sub_accordi').select('subcontractor_id, site_id, id').eq('company_id', companyId),
  ]);
  dbErr(e1); dbErr(e2); dbErr(e3);
  return {
    imprese: (subs || []).map(s => ({ id: s.id, nome: s.company_name })),
    cantieri: (sites || []).filter(s => !['chiuso', 'completato', 'archiviato'].includes(String(s.status || '').toLowerCase())).map(s => ({ id: s.id, nome: s.name || s.address })),
    esistenti: (accs || []).map(a => ({ impresa: a.subcontractor_id, cantiere: a.site_id, id: a.id })),
  };
}

function campiAccordo(b, parziale = false) {
  const out = {};
  if (b.tipo !== undefined || !parziale) {
    if (!TIPI.includes(b.tipo)) throw new SubError(400, 'TIPO_NON_VALIDO');
    out.tipo = b.tipo;
  }
  const n = (v) => (v === null || v === '' || v === undefined ? null : Number(String(v).replace(/\./g, '').replace(',', '.')));
  if (b.importo !== undefined) { const v = n(b.importo); if (v !== null && !(v > 0 && v < 1e9)) throw new SubError(400, 'CIFRA_NON_VALIDA'); out.importo = v; }
  if (b.tariffa !== undefined) { const v = n(b.tariffa); if (v !== null && !(v > 0 && v < 1e6)) throw new SubError(400, 'CIFRA_NON_VALIDA'); out.tariffa = v; }
  if (b.oreGiornata !== undefined) { const v = Number(b.oreGiornata); if (!(v > 0 && v <= 24)) throw new SubError(400, 'ORE_NON_VALIDE'); out.ore_giornata = v; }
  if (b.dataAccordo !== undefined) { if (b.dataAccordo && !valida(b.dataAccordo)) throw new SubError(400, 'DATA_NON_VALIDA'); out.data_accordo = b.dataAccordo || null; }
  return out;
}
function controllaCifra(r) {
  if (r.tipo === 'corpo' && !(r.importo > 0)) throw new SubError(400, 'MANCA_CIFRA', 'Scrivi quanto per tutto il lavoro');
  if (r.tipo !== 'corpo' && !(r.tariffa > 0)) throw new SubError(400, 'MANCA_TARIFFA', r.tipo === 'ore' ? 'Scrivi quanto all’ora' : 'Scrivi quanto al giorno');
}

async function crea(companyId, userId, b) {
  if (!UUID.test(String(b.subcontractorId)) || !UUID.test(String(b.siteId))) throw new SubError(400, 'SCEGLI_IMPRESA_E_CANTIERE');
  const [{ data: s }, { data: c }] = await Promise.all([
    supabase.from('subcontractors').select('id').eq('id', b.subcontractorId).eq('company_id', companyId).maybeSingle(),
    supabase.from('sites').select('id').eq('id', b.siteId).eq('company_id', companyId).maybeSingle(),
  ]);
  if (!s || !c) throw new SubError(404, 'NOT_FOUND');
  const campi = campiAccordo(b);
  controllaCifra({ importo: null, tariffa: null, ...campi });
  const { data, error } = await supabase.from('sub_accordi').insert({
    company_id: companyId, subcontractor_id: b.subcontractorId, site_id: b.siteId, created_by: userId || null, ...campi,
  }).select('id').single();
  if (error?.code === '23505') {
    const { data: e } = await supabase.from('sub_accordi').select('id').eq('company_id', companyId).eq('subcontractor_id', b.subcontractorId).eq('site_id', b.siteId).maybeSingle();
    throw Object.assign(new SubError(409, 'ESISTE', 'Questa impresa ha già un accordo in questo cantiere'), { id: e?.id });
  }
  dbErr(error);
  return { id: data.id };
}

async function modifica(companyId, id, b) {
  const acc = await accordo(companyId, id);
  const campi = campiAccordo(b, true);
  const dopo = { ...acc, ...campi };
  if (campi.tipo === 'corpo' && campi.importo === undefined) dopo.importo = acc.importo;
  controllaCifra({ tipo: dopo.tipo, importo: dopo.importo != null ? Number(dopo.importo) : null, tariffa: dopo.tariffa != null ? Number(dopo.tariffa) : null });
  const { error } = await supabase.from('sub_accordi').update({ ...campi, updated_at: new Date().toISOString() }).eq('id', acc.id);
  dbErr(error);
  return { ok: true };
}

const ESTENSIONE = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
async function salvaFile(companyId, accId, nome, file) {
  const ext = ESTENSIONE[file.mimetype];
  if (!ext) throw new SubError(400, 'FILE_NON_VALIDO', 'Serve un PDF o una foto');
  const path = `subappalti/${companyId}/${accId}/${nome}-${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (up.error) throw new Error(up.error.message);
  return path;
}

async function contratto(companyId, id, file) {
  const acc = await accordo(companyId, id);
  if (!file?.buffer?.length) throw new SubError(400, 'FILE_REQUIRED');
  const path = await salvaFile(companyId, acc.id, 'contratto', file);
  const { error } = await supabase.from('sub_accordi').update({ contratto_path: path, contratto_nome: String(file.originalname || 'Contratto').slice(0, 160), updated_at: new Date().toISOString() }).eq('id', acc.id);
  if (error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
  if (acc.contratto_path) await supabase.storage.from(BUCKET).remove([acc.contratto_path]).catch(() => {});
  return { ok: true };
}

async function pagamento(companyId, userId, id, b, file) {
  const acc = await accordo(companyId, id);
  const importo = r2(Number(String(b.importo ?? '').replace(/\./g, '').replace(',', '.')));
  if (!(importo > 0 && importo < 1e9)) throw new SubError(400, 'CIFRA_NON_VALIDA', 'Scrivi quanto hai pagato');
  if (!MODI.includes(b.modo)) throw new SubError(400, 'MODO_NON_VALIDO', 'Scegli come hai pagato');
  if (b.modo === 'contanti' && importo >= LIMITE_CONTANTI) throw new SubError(400, 'CONTANTI_OLTRE_LIMITE', 'In contanti si può pagare al massimo 4.999,99 € per volta');
  const data = b.data || oggi();
  if (!valida(data) || data > oggi()) throw new SubError(400, 'DATA_NON_VALIDA', 'La data non va bene');
  const riferimento = b.riferimento ? String(b.riferimento).trim().slice(0, 120) || null : null;
  const prova = file?.buffer?.length ? await salvaFile(companyId, acc.id, 'pagamento', file) : null;
  const { data: row, error } = await supabase.from('sub_pagamenti').insert({
    company_id: companyId, accordo_id: acc.id, importo, modo: b.modo, riferimento, data, prova_path: prova, created_by: userId || null,
  }).select('id').single();
  if (error) { if (prova) await supabase.storage.from(BUCKET).remove([prova]).catch(() => {}); throw new Error(error.message); }
  return { id: row.id, importo, modo: b.modo, data };
}

async function togliPagamento(companyId, id, pid) {
  const acc = await accordo(companyId, id);
  if (!UUID.test(String(pid))) throw new SubError(404, 'NOT_FOUND');
  const { data, error } = await supabase.from('sub_pagamenti').delete().eq('id', pid).eq('accordo_id', acc.id).select('prova_path');
  dbErr(error);
  if (!data?.length) throw new SubError(404, 'NOT_FOUND');
  if (data[0].prova_path) await supabase.storage.from(BUCKET).remove([data[0].prova_path]).catch(() => {});
  return { ok: true };
}

/** giornate: numero (0 = non ha lavorato) oppure null = torna a quello del QR. */
async function giorno(companyId, userId, id, g, giornate) {
  const acc = await accordo(companyId, id);
  if (!valida(g)) throw new SubError(400, 'DATA_NON_VALIDA');
  if (g > oggi()) throw new SubError(400, 'GIORNO_FUTURO', 'Non si segnano i giorni che devono ancora venire');
  if (giornate === null) {
    const { error } = await supabase.from('sub_giorni').delete().eq('accordo_id', acc.id).eq('giorno', g);
    dbErr(error);
    return { ok: true };
  }
  const v = Number(giornate);
  if (!(v >= 0 && v <= 50) || Math.round(v * 2) !== v * 2) throw new SubError(400, 'GIORNATE_NON_VALIDE');
  const { error } = await supabase.from('sub_giorni').upsert({ accordo_id: acc.id, company_id: companyId, giorno: g, giornate: v, updated_by: userId || null, updated_at: new Date().toISOString() }, { onConflict: 'accordo_id,giorno' });
  dbErr(error);
  return { ok: true };
}

/** Il lavoro a quarti: per andare avanti serve una foto. */
async function lavoro(companyId, userId, id, quarti, file) {
  const acc = await accordo(companyId, id);
  const q = Number(quarti);
  if (!Number.isInteger(q) || q < 0 || q > 4) throw new SubError(400, 'QUARTI_NON_VALIDI');
  if (q > acc.fatto_quarti && !file?.buffer?.length) throw new SubError(400, 'SERVE_FOTO', 'Fai una foto: è la prova del lavoro fatto');
  let path = null;
  if (file?.buffer?.length) {
    if (!/^image\//.test(file.mimetype)) throw new SubError(400, 'FILE_NON_VALIDO', 'Serve una foto');
    path = await salvaFile(companyId, acc.id, 'foto', file);
    const { error } = await supabase.from('sub_foto').insert({ company_id: companyId, accordo_id: acc.id, path, quarti: q, created_by: userId || null });
    if (error) { await supabase.storage.from(BUCKET).remove([path]).catch(() => {}); throw new Error(error.message); }
  }
  const { error } = await supabase.from('sub_accordi').update({ fatto_quarti: q, fatto_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', acc.id);
  dbErr(error);
  return { ok: true, quarti: q };
}

async function aggiungiLavoro(companyId, id, nome) {
  const acc = await accordo(companyId, id);
  const n = String(nome || '').trim().slice(0, 80);
  if (!n) throw new SubError(400, 'NOME_VUOTO', 'Scrivi il nome della lavorazione');
  const { count } = await supabase.from('sub_lavori').select('id', { count: 'exact', head: true }).eq('accordo_id', acc.id);
  const { data, error } = await supabase.from('sub_lavori').insert({ company_id: companyId, accordo_id: acc.id, nome: n, ordine: count || 0 }).select('id').single();
  dbErr(error);
  return { id: data.id };
}
async function aggiornaLavoro(companyId, id, lid, b) {
  const acc = await accordo(companyId, id);
  if (!UUID.test(String(lid))) throw new SubError(404, 'NOT_FOUND');
  const campi = {};
  if (b.quarti !== undefined) { const q = Number(b.quarti); if (!Number.isInteger(q) || q < 0 || q > 4) throw new SubError(400, 'QUARTI_NON_VALIDI'); campi.quarti = q; }
  if (b.nome !== undefined) { const n = String(b.nome || '').trim().slice(0, 80); if (!n) throw new SubError(400, 'NOME_VUOTO'); campi.nome = n; }
  const { data, error } = await supabase.from('sub_lavori').update(campi).eq('id', lid).eq('accordo_id', acc.id).select('id');
  dbErr(error);
  if (!data?.length) throw new SubError(404, 'NOT_FOUND');
  return { ok: true };
}
async function togliLavoro(companyId, id, lid) {
  const acc = await accordo(companyId, id);
  if (!UUID.test(String(lid))) throw new SubError(404, 'NOT_FOUND');
  const { error } = await supabase.from('sub_lavori').delete().eq('id', lid).eq('accordo_id', acc.id);
  dbErr(error);
  return { ok: true };
}

module.exports = {
  attivo, numeri, elenco, impresa, conto, opzioni, crea, modifica, contratto,
  pagamento, togliPagamento, giorno, lavoro, aggiungiLavoro, aggiornaLavoro, togliLavoro,
  SubError, LIMITE_CONTANTI,
};
