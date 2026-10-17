'use strict';
/**
 * lib/contiSub.js — F-360 (AUDIT.md del frontend): Conti dei sub.
 * Mockup approvato il 17/10: https://claude.ai/artifact/MmTtR3Vd7P9j29qyhzjBug
 *
 * Il tecnico carica il foglio del subappaltatore; qui si crea il conto, si
 * confronta con gli ingressi del mese (sub_presenze), con i prezzi imparati dai
 * conti approvati (sub_prezzi) e con le quantità del contratto; il tecnico
 * decide le differenze e approva; le fatture del sub in Da pagare vengono
 * abbinate ai conti approvati. I controlli veri sono in contiSubControllo.js.
 *
 * Niente contabilità: niente ritenute, computo, capitolato, margini.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { isFeatureEnabled } = require('./featureFlags');
const { risolviOrario } = require('./oreContrattuali');
const DP = require('./daPagare');
const C = require('./contiSubControllo');

const FLAG = 'conti_sub';
const RUOLI = ['owner', 'admin', 'tech'];
const BUCKET = 'conti-sub'; // privato, creato da scripts/setup_bucket_conti_sub.js (site-documents non accetta Excel)
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function errore(code, message, status = 400) { return Object.assign(new Error(message || code), { code, status }); }
function dbErr(error) { if (error) throw errore('DB_ERROR', error.message, 500); }
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => (v == null ? null : Number(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const puoVedere = (role) => !role || RUOLI.includes(role);
async function attivoPer(companyId) {
  try { return await isFeatureEnabled(companyId, FLAG); } catch { return false; }
}

const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
const romeMinutes = (iso) => {
  const [h, m] = new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return h * 60 + m;
};
/** "2026-10" → { primo: '2026-10-01', dopo: '2026-11-01' } */
function meseRange(mese) {
  const [a, m] = mese.split('-').map(Number);
  const dopo = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
  return { primo: `${mese}-01`, dopo };
}
const meseTesto = (primo) => { const [a, m] = String(primo).split('-').map(Number); return `${MESI[m - 1]} ${a}`; };
function mesePrecedente(oggi = romeDay(new Date().toISOString())) {
  const [a, m] = oggi.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

// ── Imprese e cantieri ──────────────────────────────────────────────────────
async function opzioni(companyId) {
  const [subs, sites] = await Promise.all([
    supabase.from('subcontractors').select('id, company_name, is_active').eq('company_id', companyId).order('company_name'),
    supabase.from('sites').select('id, name, address, status').eq('company_id', companyId).order('name'),
  ]);
  dbErr(subs.error); dbErr(sites.error);
  return {
    imprese: (subs.data || []).filter(s => s.is_active !== false).map(s => ({ id: s.id, nome: s.company_name })),
    cantieri: (sites.data || []).filter(s => !['eliminato'].includes(s.status)).map(s => ({ id: s.id, nome: s.name || s.address, indirizzo: s.address || null, chiuso: ['chiuso', 'ultimato'].includes(s.status) })),
  };
}

/** L'impresa del foglio tra i subappaltatori dell'azienda: stessa chiave, o una contiene l'altra. */
function trovaImpresa(nome, imprese) {
  const k = DP.normNome(nome);
  if (!k) return null;
  const uguali = imprese.filter(i => DP.normNome(i.nome) === k);
  if (uguali.length === 1) return uguali[0];
  const simili = imprese.filter(i => { const j = DP.normNome(i.nome); return j.length >= 3 && (j.includes(k) || k.includes(j)); });
  return simili.length === 1 ? simili[0] : null;
}

/** Il cantiere: l'unico dove lavora quel sub, oppure quello con più parole in comune con il testo del foglio. */
async function trovaCantiere(companyId, testo, subId, cantieri) {
  if (subId) {
    const { data } = await supabase.from('site_subcontractors').select('site_id').eq('company_id', companyId).eq('subcontractor_id', subId);
    const aperti = (data || []).map(r => cantieri.find(c => c.id === r.site_id)).filter(c => c && !c.chiuso);
    if (aperti.length === 1) return aperti[0];
  }
  const parole = new Set(C.normNome(testo).split(' ').filter(w => w.length >= 3 && !['via', 'corso', 'piazza', 'cantiere', 'lavori'].includes(w)));
  if (!parole.size) return null;
  let best = null, bestN = 0, pari = false;
  for (const c of cantieri) {
    const w = new Set(C.normNome(`${c.nome} ${c.indirizzo || ''}`).split(' '));
    const n = [...parole].filter(p => w.has(p)).length;
    if (n > bestN) { best = c; bestN = n; pari = false; } else if (n && n === bestN) pari = true;
  }
  return bestN && !pari ? best : null;
}

// ── Ingressi, prezzi, quantità già approvate ───────────────────────────────
async function ingressiDelMese(companyId, siteId, subId, mesePrimo) {
  if (!siteId || !subId) return { ingressi: null, persone: [] };
  const { primo, dopo } = meseRange(mesePrimo.slice(0, 7));
  const da = new Date(Date.parse(`${primo}T00:00:00Z`) - 3 * 3600e3).toISOString();
  const a = new Date(Date.parse(`${dopo}T00:00:00Z`) + 3 * 3600e3).toISOString();
  const [pres, pers, site, comp] = await Promise.all([
    supabase.from('sub_presenze').select('sub_worker_id, event, at').eq('company_id', companyId).eq('site_id', siteId)
      .eq('subcontractor_id', subId).is('annullata_at', null).gte('at', da).lt('at', a).order('at').limit(20000),
    supabase.from('sub_workers').select('id, full_name').eq('company_id', companyId).eq('subcontractor_id', subId),
    supabase.from('sites').select('orario_inizio, orario_fine, pausa_inizio, pausa_fine, lunch_break_minutes').eq('id', siteId).maybeSingle(),
    supabase.from('companies').select('orario_inizio, orario_fine, pausa_inizio, pausa_fine, lunch_break_minutes').eq('id', companyId).maybeSingle(),
  ]);
  dbErr(pres.error); dbErr(pers.error);
  const righe = (pres.data || []).map(p => ({ sub_worker_id: p.sub_worker_id, event: p.event, giorno: romeDay(p.at), min: romeMinutes(p.at) }))
    .filter(p => p.giorno >= primo && p.giorno < dopo);
  if (!righe.length) return { ingressi: null, persone: pers.data || [] };
  const orario = risolviOrario({ company: comp.data || {}, site: site.data || null });
  return { ingressi: C.oreDaPresenze(righe, orario), persone: pers.data || [] };
}

/** Prezzi imparati per impresa: quelli del cantiere vincono su quelli generali. */
async function prezziNoti(companyId, impresaChiave, siteId) {
  const { data, error } = await supabase.from('sub_prezzi').select('site_id, voce_chiave, prezzo, contratto')
    .eq('company_id', companyId).eq('impresa_chiave', impresaChiave);
  dbErr(error);
  const out = new Map();
  for (const r of (data || []).filter(r => !r.site_id)) out.set(r.voce_chiave, { prezzo: num(r.prezzo), contratto: null });
  for (const r of (data || []).filter(r => siteId && r.site_id === siteId)) {
    const prima = out.get(r.voce_chiave) || {};
    out.set(r.voce_chiave, { prezzo: num(r.prezzo) ?? prima.prezzo ?? null, contratto: num(r.contratto) });
  }
  return out;
}

/** Quantità già approvate nei mesi prima di questo, stessa impresa e cantiere, per voce. */
async function giaApprovato(companyId, impresaChiave, siteId, mesePrimo) {
  const out = new Map();
  if (!siteId) return out;
  const { data: conti, error } = await supabase.from('sub_conti').select('id').eq('company_id', companyId)
    .eq('impresa_chiave', impresaChiave).eq('site_id', siteId).eq('stato', 'approvato').lt('mese', mesePrimo);
  dbErr(error);
  if (!conti?.length) return out;
  const { data: righe, error: e2 } = await supabase.from('sub_conti_righe').select('*').in('conto_id', conti.map(c => c.id)).eq('tipo', 'misura');
  dbErr(e2);
  for (const r of righe || []) {
    const v = C.valoreRiga(normRiga(r));
    if (v) out.set(r.voce_chiave, r2((out.get(r.voce_chiave) || 0) + v.quantita));
  }
  return out;
}

const normRiga = (r) => ({
  ...r,
  ore_foglio: num(r.ore_foglio), ore_ingressi: num(r.ore_ingressi), quantita_foglio: num(r.quantita_foglio),
  prezzo_foglio: num(r.prezzo_foglio), importo_scritto: num(r.importo_scritto), prezzo_noto: num(r.prezzo_noto),
  contratto: num(r.contratto), gia_approvato: num(r.gia_approvato), proposta: num(r.proposta), valore: num(r.valore),
});

// ── Calcolo e salvataggio delle righe ──────────────────────────────────────
async function calcola(companyId, conto, foglio) {
  const [{ ingressi, persone }, prezzi, gia] = await Promise.all([
    ingressiDelMese(companyId, conto.site_id, conto.subcontractor_id, conto.mese),
    prezziNoti(companyId, conto.impresa_chiave, conto.site_id),
    giaApprovato(companyId, conto.impresa_chiave, conto.site_id, conto.mese),
  ]);
  const tariffaNota = prezzi.get('__ore')?.prezzo ?? null;
  prezzi.delete('__ore');
  const ris = C.controlla({ ore: foglio.ore, misura: foglio.misura, tariffaFoglio: num(conto.tariffa_foglio), tariffaNota, ingressi, persone, prezzi, giaApprovato: gia });
  const righe = [
    ...ris.righeOre.map((r, i) => ({
      tipo: 'ore', ordine: i, persona: r.persona, giorno: r.giorno, ore_foglio: r.ore_foglio, ore_ingressi: r.ore_ingressi,
      problema: r.problema, proposta: r.proposta,
    })),
    ...ris.righeMisura.map((r, i) => ({
      tipo: 'misura', ordine: 1000 + i, voce: r.voce, voce_chiave: r.voce_chiave, unita: r.unita, quantita_foglio: r.quantita_foglio,
      prezzo_foglio: r.prezzo_foglio, importo_scritto: r.importo_scritto, prezzo_noto: r.prezzo_noto, contratto: r.contratto,
      gia_approvato: r.gia_approvato, problema: r.problema, proposta: r.proposta,
    })),
  ];
  return { righe, senzaIngressi: ris.senzaIngressi, tariffaNota };
}

async function salvaRighe(companyId, contoId, righe) {
  const { error: e1 } = await supabase.from('sub_conti_righe').delete().eq('conto_id', contoId);
  dbErr(e1);
  if (!righe.length) return;
  const { error } = await supabase.from('sub_conti_righe').insert(righe.map(r => ({ ...r, conto_id: contoId, company_id: companyId, decisione: null, valore: null })));
  dbErr(error);
}

async function contoDellAzienda(companyId, id) {
  if (!UUID.test(String(id))) throw errore('NOT_FOUND', 'Conto non trovato', 404);
  const { data, error } = await supabase.from('sub_conti').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
  dbErr(error);
  if (!data) throw errore('NOT_FOUND', 'Conto non trovato', 404);
  return data;
}
async function righeDi(contoId) {
  const { data, error } = await supabase.from('sub_conti_righe').select('*').eq('conto_id', contoId).order('ordine');
  dbErr(error);
  return (data || []).map(normRiga);
}

/**
 * Nuovo conto dal foglio letto. Se c'è già un conto da controllare per stessa
 * impresa, cantiere e mese, lo sostituisce (il sub ha mandato il foglio corretto).
 */
async function crea({ companyId, userId, lettura, file = null, oggi }) {
  const opz = await opzioni(companyId);
  const impresa = trovaImpresa(lettura.impresa, opz.imprese);
  const impresaNome = impresa ? impresa.nome : (lettura.impresa || '').trim();
  if (impresaNome.length < 2) throw errore('IMPRESA', 'Non trovo il nome dell\'impresa nel foglio.', 422);
  const site = await trovaCantiere(companyId, lettura.cantiere || '', impresa?.id, opz.cantieri);
  const mese = `${lettura.mese || mesePrecedente(oggi)}-01`;
  const chiave = DP.normNome(impresaNome);

  if (site) {
    const { data: esistenti } = await supabase.from('sub_conti').select('id, stato').eq('company_id', companyId)
      .eq('impresa_chiave', chiave).eq('site_id', site.id).eq('mese', mese);
    if ((esistenti || []).some(c => c.stato === 'approvato')) {
      throw errore('GIA_APPROVATO', `Il conto di ${meseTesto(mese)} di ${DP.nomeBreve(impresaNome)} per questo cantiere è già approvato.`, 409);
    }
    for (const c of esistenti || []) await supabase.from('sub_conti').delete().eq('id', c.id).eq('company_id', companyId);
  }

  let filePath = null;
  if (file) {
    const ext = (String(file.originalname || '').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
    filePath = `${companyId}/conti-sub/${crypto.randomUUID()}.${ext}`;
    // Il tipo dall'estensione: dal telefono un Excel arriva spesso come application/octet-stream
    const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const up = await supabase.storage.from(BUCKET).upload(filePath, file.buffer, { contentType: MIME[ext] || file.mimetype || 'application/octet-stream' });
    if (up.error) throw errore('STORAGE_ERROR', 'Non riesco a salvare il foglio', 500);
  }

  const base = {
    company_id: companyId, subcontractor_id: impresa?.id || null, impresa_nome: impresaNome, impresa_chiave: chiave,
    site_id: site?.id || null, cantiere_testo: lettura.cantiere || null, mese, stato: 'da_controllare',
    tariffa_foglio: lettura.tariffa ?? null, totale_scritto: lettura.totaleScritto ?? null,
    file_path: filePath, file_nome: file ? String(file.originalname || '').slice(0, 160) : null, created_by: userId || null,
  };
  const calc = await calcola(companyId, base, lettura);
  const { data: conto, error } = await supabase.from('sub_conti')
    .insert({ ...base, tariffa_nota: calc.tariffaNota, senza_ingressi: calc.senzaIngressi }).select('*').single();
  dbErr(error);
  await salvaRighe(companyId, conto.id, calc.righe);
  return dettaglio(companyId, conto.id);
}

/** Cambia impresa, cantiere o mese (letti male o mancanti) e rifà i controlli. */
async function correggi({ companyId, id, subcontractorId, siteId, mese }) {
  const conto = await contoDellAzienda(companyId, id);
  if (conto.stato === 'approvato') throw errore('GIA_APPROVATO', 'Il conto è già approvato: riaprilo per cambiarlo.', 409);
  const opz = await opzioni(companyId);
  const agg = {};
  if (subcontractorId !== undefined) {
    const imp = opz.imprese.find(i => i.id === subcontractorId);
    if (!imp) throw errore('IMPRESA', 'Impresa non trovata', 400);
    Object.assign(agg, { subcontractor_id: imp.id, impresa_nome: imp.nome, impresa_chiave: DP.normNome(imp.nome) });
  }
  if (siteId !== undefined) {
    if (siteId !== null && !opz.cantieri.some(c => c.id === siteId)) throw errore('CANTIERE', 'Cantiere non trovato', 400);
    agg.site_id = siteId;
  }
  if (mese !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mese))) throw errore('MESE', 'Mese non valido', 400);
    agg.mese = `${mese}-01`;
  }
  const nuovo = { ...conto, ...agg };
  const vecchie = await righeDi(id);
  const foglio = {
    ore: vecchie.filter(r => r.tipo === 'ore').map(r => ({ persona: r.persona, giorno: r.giorno, ore_foglio: r.ore_foglio })),
    misura: vecchie.filter(r => r.tipo === 'misura').map(r => ({ voce: r.voce, unita: r.unita, quantita_foglio: r.quantita_foglio, prezzo_foglio: r.prezzo_foglio, importo_scritto: r.importo_scritto })),
  };
  const calc = await calcola(companyId, nuovo, foglio);
  const { error } = await supabase.from('sub_conti').update({
    ...agg, tariffa_nota: calc.tariffaNota, senza_ingressi: calc.senzaIngressi, tariffa: null, tariffa_decisione: null, updated_at: new Date().toISOString(),
  }).eq('id', id).eq('company_id', companyId);
  dbErr(error);
  await salvaRighe(companyId, id, calc.righe);
  return dettaglio(companyId, id);
}

/**
 * La decisione del tecnico su una differenza.
 * @param {string} rigaId  id della riga oppure 'tariffa'
 * @param {'foglio'|'proposta'} decisione
 * @param {number} [valore]  per un prezzo mancante o un valore scritto a mano
 */
async function decidi({ companyId, id, rigaId, decisione, valore }) {
  const conto = await contoDellAzienda(companyId, id);
  if (conto.stato === 'approvato') throw errore('GIA_APPROVATO', 'Il conto è già approvato: riaprilo per cambiarlo.', 409);
  if (!['foglio', 'proposta'].includes(decisione)) throw errore('DECISIONE', 'Decisione non valida', 400);
  const v = valore == null || valore === '' ? null : Number(String(valore).replace(',', '.'));
  if (v != null && (!Number.isFinite(v) || v < 0 || v > 1e7)) throw errore('VALORE', 'Numero non valido', 400);
  if (rigaId === 'tariffa') {
    const agg = { tariffa_decisione: decisione, updated_at: new Date().toISOString() };
    agg.tariffa = decisione === 'proposta' ? (v ?? num(conto.tariffa_nota)) : num(conto.tariffa_foglio);
    if (agg.tariffa == null) throw errore('VALORE', 'Scrivi la tariffa oraria', 400);
    const { error } = await supabase.from('sub_conti').update(agg).eq('id', id).eq('company_id', companyId);
    dbErr(error);
    return dettaglio(companyId, id);
  }
  if (!UUID.test(String(rigaId))) throw errore('NOT_FOUND', 'Riga non trovata', 404);
  const { data: riga } = await supabase.from('sub_conti_righe').select('id, problema').eq('id', rigaId).eq('conto_id', id).maybeSingle();
  if (!riga || !riga.problema) throw errore('NOT_FOUND', 'Riga non trovata', 404);
  if (riga.problema === 'prezzo_mancante' && v == null) throw errore('VALORE', 'Scrivi il prezzo', 400);
  const { error } = await supabase.from('sub_conti_righe').update({ decisione, valore: v }).eq('id', rigaId).eq('conto_id', id);
  dbErr(error);
  return dettaglio(companyId, id);
}

/** Impara i prezzi (e la tariffa) dal conto approvato. */
async function imparaPrezzi(companyId, conto, righe, tariffa) {
  const voci = new Map();
  for (const r of righe.filter(x => x.tipo === 'misura')) {
    const v = C.valoreRiga(r);
    if (v) voci.set(r.voce_chiave, { voce: r.voce, unita: r.unita, prezzo: v.prezzo });
  }
  if (tariffa != null) voci.set('__ore', { voce: 'Ora operaio', unita: 'h', prezzo: tariffa });
  for (const [chiave, x] of voci) {
    for (const siteId of [conto.site_id, null]) {
      if (siteId === undefined) continue;
      let q = supabase.from('sub_prezzi').select('id').eq('company_id', companyId).eq('impresa_chiave', conto.impresa_chiave).eq('voce_chiave', chiave);
      q = siteId ? q.eq('site_id', siteId) : q.is('site_id', null);
      const { data } = await q.maybeSingle();
      const riga = { voce: x.voce, unita: x.unita, prezzo: x.prezzo, da_conto_id: conto.id, updated_at: new Date().toISOString() };
      if (data) await supabase.from('sub_prezzi').update(riga).eq('id', data.id);
      else await supabase.from('sub_prezzi').insert({ ...riga, company_id: companyId, impresa_chiave: conto.impresa_chiave, site_id: siteId, voce_chiave: chiave });
      if (!conto.site_id) break;
    }
  }
}

async function approva({ companyId, id, userId, nome }) {
  const conto = await contoDellAzienda(companyId, id);
  if (conto.stato === 'approvato') return dettaglio(companyId, id);
  const righe = await righeDi(id);
  const t = C.totali(conto, righe);
  if (t.aperte > 0) throw errore('DA_GUARDARE', t.aperte === 1 ? 'Manca una differenza da guardare.' : `Mancano ${t.aperte} differenze da guardare.`, 409);
  if (!conto.site_id) throw errore('CANTIERE', 'Scegli il cantiere prima di approvare.', 409);
  const { error } = await supabase.from('sub_conti').update({
    stato: 'approvato', totale_approvato: t.totale, tariffa: t.tariffa, approvato_da: userId || null,
    approvato_da_nome: nome || null, approvato_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id).eq('company_id', companyId).eq('stato', 'da_controllare');
  dbErr(error);
  await imparaPrezzi(companyId, conto, righe, t.tariffa);
  return dettaglio(companyId, id);
}

async function riapri({ companyId, id }) {
  await contoDellAzienda(companyId, id);
  const { error } = await supabase.from('sub_conti').update({ stato: 'da_controllare', totale_approvato: null, approvato_at: null, approvato_da: null, approvato_da_nome: null, updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId);
  dbErr(error);
  return dettaglio(companyId, id);
}

async function elimina({ companyId, id }) {
  const conto = await contoDellAzienda(companyId, id);
  if (conto.stato === 'approvato') throw errore('GIA_APPROVATO', 'Un conto approvato non si elimina: riaprilo prima.', 409);
  const { error } = await supabase.from('sub_conti').delete().eq('id', id).eq('company_id', companyId);
  dbErr(error);
  if (conto.file_path) await supabase.storage.from(BUCKET).remove([conto.file_path]).catch(() => {});
  return { ok: true };
}

/** Quantità del contratto per una voce (facoltativa): abilita l'avviso «oltre il contratto». */
async function contratto({ companyId, id, rigaId, quantita }) {
  const conto = await contoDellAzienda(companyId, id);
  if (!conto.site_id) throw errore('CANTIERE', 'Scegli prima il cantiere.', 409);
  const { data: riga } = await supabase.from('sub_conti_righe').select('voce, voce_chiave, unita').eq('id', rigaId).eq('conto_id', id).eq('tipo', 'misura').maybeSingle();
  if (!riga) throw errore('NOT_FOUND', 'Riga non trovata', 404);
  const q = quantita == null || quantita === '' ? null : Number(String(quantita).replace(',', '.'));
  if (q != null && (!Number.isFinite(q) || q <= 0)) throw errore('VALORE', 'Quantità non valida', 400);
  const { data } = await supabase.from('sub_prezzi').select('id').eq('company_id', companyId).eq('impresa_chiave', conto.impresa_chiave)
    .eq('site_id', conto.site_id).eq('voce_chiave', riga.voce_chiave).maybeSingle();
  if (data) await supabase.from('sub_prezzi').update({ contratto: q, updated_at: new Date().toISOString() }).eq('id', data.id);
  else await supabase.from('sub_prezzi').insert({ company_id: companyId, impresa_chiave: conto.impresa_chiave, site_id: conto.site_id, voce_chiave: riga.voce_chiave, voce: riga.voce, unita: riga.unita, contratto: q });
  if (conto.stato === 'approvato') return dettaglio(companyId, id);
  return correggi({ companyId, id });
}

// ── Lettura per la pagina ──────────────────────────────────────────────────
// «BENALI MOHAMED» → «Benali Mohamed» (i fogli dei sub scrivono spesso tutto maiuscolo)
const nomePersona = (s) => (s === s.toUpperCase() && /[A-Z]{2}/.test(s) ? s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, c) => a + c.toUpperCase()) : s);
const fmtOre = (n) => `${Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 })} ${Number(n) === 1 ? 'ora' : 'ore'}`;
const fmtQ = (n, u) => `${Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 })}${u ? ` ${u}` : ''}`;
const giornoTesto = (g) => { const d = new Date(`${g}T12:00:00Z`); return `${d.getUTCDate()} ${MESI[d.getUTCMonth()].slice(0, 3)}`; };

/** Cosa non torna, a parole, e i due tasti. Stesse frasi in pagina e nel PDF. */
function descrivi(r) {
  if (!r.problema) return null;
  if (r.tipo === 'ore') {
    const chi = `${r.giorno ? `${giornoTesto(r.giorno)} · ` : ''}${nomePersona(r.persona)}`;
    if (r.problema === 'non_entrato') return {
      titolo: chi, dettaglio: `${fmtOre(r.ore_foglio)} nel foglio, nessun ingresso in cantiere${r.giorno ? ' quel giorno' : ' nel mese'}`,
      foglio: r.giorno ? 'La riconosco' : `Riconosco ${fmtOre(r.ore_foglio)}`, proposta: r.giorno ? 'Tolgo la giornata' : 'Tolgo le ore',
    };
    return {
      titolo: chi, dettaglio: `${fmtOre(r.ore_foglio)} nel foglio, ${fmtOre(r.ore_ingressi)} in cantiere dagli ingressi`,
      foglio: `Riconosco ${fmtOre(r.ore_foglio)}`, proposta: `Conto ${fmtOre(r.proposta)}`,
    };
  }
  const u = r.unita ? `/${r.unita}` : '';
  if (r.problema === 'prezzo_diverso') return {
    titolo: r.voce, dettaglio: `${DP.euro(r.prezzo_foglio)}${u} nel foglio, finora ${DP.euro(r.prezzo_noto)}${u}`,
    foglio: `Nuovo prezzo ${DP.euro(r.prezzo_foglio)}`, proposta: `Tengo ${DP.euro(r.prezzo_noto)}`,
  };
  if (r.problema === 'oltre_contratto') return {
    titolo: r.voce, dettaglio: `Con questo mese ${fmtQ(r2(r.gia_approvato + r.quantita_foglio), r.unita)} su ${fmtQ(r.contratto, r.unita)} del contratto`,
    foglio: `Va bene, è un extra`, proposta: `Riconosco fino a ${fmtQ(r.contratto, r.unita)}`,
  };
  return { titolo: r.voce, dettaglio: 'Prezzo non scritto nel foglio e mai approvato prima', foglio: null, proposta: 'Scrivi il prezzo', chiedi: true };
}

function vistaRiga(r) {
  const v = C.valoreRiga(r);
  const base = {
    id: r.id, tipo: r.tipo, problema: r.problema, decisione: r.decisione, valore: r.valore, proposta: r.proposta,
    testo: descrivi(r),
  };
  if (r.tipo === 'ore') return { ...base, persona: nomePersona(r.persona), giorno: r.giorno, oreFoglio: r.ore_foglio, oreIngressi: r.ore_ingressi, oreApprovate: v };
  return {
    ...base, voce: r.voce, unita: r.unita, quantita: r.quantita_foglio, prezzo: r.prezzo_foglio, prezzoNoto: r.prezzo_noto,
    importoScritto: r.importo_scritto, contratto: r.contratto, giaApprovato: r.gia_approvato,
    approvato: v, importoSbagliato: r.importo_scritto != null && r.prezzo_foglio != null && Math.abs(r2(r.quantita_foglio * r.prezzo_foglio) - r.importo_scritto) > 0.01,
  };
}

async function dettaglio(companyId, id) {
  const conto = await contoDellAzienda(companyId, id);
  const righe = await righeDi(id);
  const t = C.totali(conto, righe);
  const site = conto.site_id ? (await supabase.from('sites').select('id, name, address').eq('id', conto.site_id).maybeSingle()).data : null;
  const ore = righe.filter(r => r.tipo === 'ore');
  const misura = righe.filter(r => r.tipo === 'misura');
  const tariffaProblema = C.tariffaProblema(conto, ore.length > 0);
  const oreFoglio = r2(ore.reduce((s, r) => s + r.ore_foglio, 0));
  const sommaFoglio = r2(oreFoglio * (num(conto.tariffa_foglio) ?? num(conto.tariffa_nota) ?? 0)
    + misura.reduce((s, r) => s + (r.importo_scritto ?? r.quantita_foglio * (r.prezzo_foglio || 0)), 0));
  const totaleScritto = num(conto.totale_scritto);
  return {
    id: conto.id,
    stato: conto.stato,
    impresa: { id: conto.subcontractor_id, nome: DP.nomeBreve(conto.impresa_nome), nomeFoglio: conto.impresa_nome },
    cantiere: site ? { id: site.id, nome: site.name || site.address } : null,
    cantiereFoglio: conto.cantiere_testo,
    mese: conto.mese.slice(0, 7),
    meseTesto: meseTesto(conto.mese),
    file: conto.file_path ? { nome: conto.file_nome } : null,
    senzaIngressi: !!conto.senza_ingressi,
    tariffa: {
      foglio: num(conto.tariffa_foglio), nota: num(conto.tariffa_nota), approvata: t.tariffa, problema: tariffaProblema,
      decisione: conto.tariffa_decisione,
      testo: tariffaProblema === 'prezzo_diverso'
        ? { titolo: 'Tariffa oraria', dettaglio: `${DP.euro(conto.tariffa_foglio)}/h nel foglio, finora ${DP.euro(conto.tariffa_nota)}/h`, foglio: `Nuova tariffa ${DP.euro(conto.tariffa_foglio)}`, proposta: `Tengo ${DP.euro(conto.tariffa_nota)}` }
        : tariffaProblema === 'prezzo_mancante' ? { titolo: 'Tariffa oraria', dettaglio: 'Non scritta nel foglio e mai approvata prima', foglio: null, proposta: 'Scrivi la tariffa', chiedi: true } : null,
    },
    ore: ore.map(r => vistaRiga(r)),
    misura: misura.map(r => vistaRiga(r)),
    totali: {
      ...t,
      giornateTesto: C.giornateTesto(t.ore),
      oreFoglio,
      giornateFoglioTesto: C.giornateTesto(oreFoglio),
      oreOk: ore.filter(r => !r.problema).length,
      misuraOk: misura.filter(r => !r.problema).length,
      chiesto: totaleScritto ?? sommaFoglio,
      sommaFoglio,
      totaleScritto,
      sommaSbagliata: totaleScritto != null && Math.abs(totaleScritto - sommaFoglio) > 0.5,
    },
    approvato: conto.stato === 'approvato' ? { il: conto.approvato_at, da: conto.approvato_da_nome, totale: num(conto.totale_approvato) } : null,
  };
}

/** Le fatture di Da pagare (aperte e pagate, ultimi 15 mesi) delle imprese dei conti approvati, abbinate. */
async function fattureAbbinate(companyId, conti) {
  const perImpresa = new Map();
  for (const c of conti.filter(x => x.stato === 'approvato')) {
    if (!perImpresa.has(c.impresa_chiave)) perImpresa.set(c.impresa_chiave, []);
    perImpresa.get(c.impresa_chiave).push({ id: c.id, mese: c.mese, totale_approvato: num(c.totale_approvato), approvato_at: c.approvato_at });
  }
  const out = new Map(); // id fattura → abbinamento
  if (!perImpresa.size) return { perFattura: out, perConto: new Map() };
  const da = new Date(Date.now() - 460 * 864e5).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('company_expenses').select('id, supplier, amount, created_at, pagato_il, invoice_number')
    .eq('company_id', companyId).eq('da_pagare', true).gte('expense_date', da).limit(2000);
  dbErr(error);
  const perConto = new Map();
  for (const [chiave, lista] of perImpresa) {
    const fatture = (data || []).filter(f => DP.normNome(f.supplier) === chiave);
    for (const [fid, a] of C.abbinaFatture(lista, fatture)) {
      const f = fatture.find(x => x.id === fid);
      out.set(fid, a);
      perConto.set(a.contoId, { fatturaId: fid, numero: f.invoice_number || null, importo: num(f.amount), differenza: a.differenza, pagata: f.pagato_il || null });
    }
  }
  return { perFattura: out, perConto };
}

/** La pagina: da controllare, approvati del mese, storico per impresa e cantiere. */
async function elenco(companyId) {
  const { data: conti, error } = await supabase.from('sub_conti').select('*').eq('company_id', companyId).order('mese', { ascending: false }).limit(500);
  dbErr(error);
  const ids = (conti || []).map(c => c.id);
  const righe = ids.length ? (await supabase.from('sub_conti_righe').select('*').in('conto_id', ids)).data || [] : [];
  const siteIds = [...new Set((conti || []).map(c => c.site_id).filter(Boolean))];
  const sites = siteIds.length ? (await supabase.from('sites').select('id, name, address').in('id', siteIds)).data || [] : [];
  const { perConto } = await fattureAbbinate(companyId, conti || []);
  const voce = (c) => {
    const rr = righe.filter(r => r.conto_id === c.id).map(normRiga);
    const t = C.totali(c, rr);
    const ore = rr.filter(r => r.tipo === 'ore');
    const s = sites.find(x => x.id === c.site_id);
    return {
      id: c.id, stato: c.stato, impresa: DP.nomeBreve(c.impresa_nome), impresaChiave: c.impresa_chiave,
      cantiere: s ? (s.name || s.address) : null, siteId: c.site_id, mese: c.mese.slice(0, 7), meseTesto: meseTesto(c.mese),
      chiesto: num(c.totale_scritto) ?? r2(ore.reduce((x, r) => x + r.ore_foglio, 0) * (num(c.tariffa_foglio) ?? num(c.tariffa_nota) ?? 0) + rr.filter(r => r.tipo === 'misura').reduce((x, r) => x + (r.importo_scritto ?? r.quantita_foglio * (r.prezzo_foglio || 0)), 0)),
      aperte: t.aperte, problemi: t.problemi, totale: c.stato === 'approvato' ? num(c.totale_approvato) : t.totale,
      approvatoIl: c.approvato_at, fattura: perConto.get(c.id) || null,
    };
  };
  const tutti = (conti || []).map(voce);
  const storico = new Map();
  for (const v of tutti.filter(x => x.stato === 'approvato')) {
    const k = `${v.impresaChiave}|${v.siteId}`;
    if (!storico.has(k)) storico.set(k, { impresa: v.impresa, cantiere: v.cantiere, mesi: [], approvato: 0, fatturato: 0, pagato: 0 });
    const s = storico.get(k);
    s.mesi.push({ id: v.id, mese: v.mese, meseTesto: v.meseTesto, totale: v.totale, fattura: v.fattura });
    s.approvato = r2(s.approvato + v.totale);
    if (v.fattura) s.fatturato = r2(s.fatturato + v.fattura.importo);
    if (v.fattura?.pagata) s.pagato = r2(s.pagato + v.fattura.importo);
  }
  return {
    daControllare: tutti.filter(v => v.stato === 'da_controllare'),
    approvati: tutti.filter(v => v.stato === 'approvato').slice(0, 30),
    storico: [...storico.values()],
  };
}

/** Per Da pagare: a ogni fattura di un sub, il confronto con il suo conto approvato. */
async function perDaPagare(companyId, righe) {
  if (!righe.length || !(await attivoPer(companyId))) return new Map();
  const chiavi = [...new Set(righe.map(r => r.chiave).filter(Boolean))];
  const { data: conti } = await supabase.from('sub_conti').select('id, impresa_chiave, mese, stato, totale_approvato, approvato_at')
    .eq('company_id', companyId).eq('stato', 'approvato').in('impresa_chiave', chiavi);
  if (!conti?.length) return new Map();
  const { perFattura } = await fattureAbbinate(companyId, conti);
  const out = new Map();
  for (const [fid, a] of perFattura) out.set(fid, { contoId: a.contoId, meseTesto: meseTesto(a.mese), approvato: a.approvato, differenza: a.differenza });
  return out;
}

async function fileFirmato({ companyId, id }) {
  const conto = await contoDellAzienda(companyId, id);
  if (!conto.file_path) throw errore('NOT_FOUND', 'Nessun foglio allegato', 404);
  const nome = conto.file_nome || `Foglio ${conto.impresa_nome}.${conto.file_path.split('.').pop()}`;
  const [vedi, scarica] = await Promise.all([
    supabase.storage.from(BUCKET).createSignedUrl(conto.file_path, 600),
    supabase.storage.from(BUCKET).createSignedUrl(conto.file_path, 600, { download: nome }),
  ]);
  if (!vedi.data?.signedUrl) throw errore('STORAGE_ERROR', 'Foglio non disponibile', 500);
  return { url: vedi.data.signedUrl, scarica: scarica.data?.signedUrl || vedi.data.signedUrl, tipo: DP.tipoFile(conto.file_path), nome };
}

module.exports = {
  FLAG, RUOLI, puoVedere, attivoPer, errore,
  opzioni, crea, correggi, decidi, approva, riapri, elimina, contratto, dettaglio, elenco, perDaPagare, fileFirmato,
  // per i test
  trovaImpresa, trovaCantiere, meseRange, mesePrecedente, descrivi, meseTesto,
};
