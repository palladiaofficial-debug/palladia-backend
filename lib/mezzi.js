'use strict';
/**
 * lib/mezzi.js — F-375 (AUDIT.md del frontend): la pagina Mezzi, semplice.
 *
 * Disegno approvato il 18/10 (tela «Palladia semplice», pagina «Mezzi e
 * imprese», M1–M7). Lo stato di assicurazione e revisione viene da
 * documentiStato.statoMezzi() — la stessa verità di /documenti, così le due
 * pagine non possono dire cose diverse. Qui si aggiungono:
 *  - i promemoria in più (bollo, tagliando, cronotachigrafo, verifica
 *    periodica, altro: tabella equipment_promemoria, migr. 254);
 *  - dove sta il mezzo (site_equipment: un mezzo, un posto);
 *  - la frase di ogni riga e la «prima cosa» da sistemare.
 */
const supabase = require('./supabase');
const { complianceStatus } = require('./compliance');
const { statoMezzi, isVehicle } = require('./documentiStato');
const { prossimaRevisione } = require('./mezziRevisione');

const STATE = { not_set: 'manca', expired: 'scaduto', expiring: 'in_scadenza', ok: 'in_regola' };
const RANK = { scaduto: 0, manca: 1, in_scadenza: 2, in_regola: 3 };
const PROMEMORIA = {
  bollo: { label: 'Bollo', f: false },
  tagliando: { label: 'Tagliando', f: false },
  cronotachigrafo: { label: 'Cronotachigrafo', f: false },
  verifica: { label: 'Verifica periodica', f: true },
  altro: { label: null, f: false },
};
// Il genere serve alla frase: «Assicurazione scaduta», «Bollo scaduto»
const FEMMINILE = new Set(['assicurazione', 'revisione', 'verifica']);

class MezziError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

/** «Autocarro NISSAN CABSTAR 120.35 3.0 TDI…» → «Nissan Cabstar»: marca e modello, senza il tipo. */
function nomeBreve(row) {
  const tipo = String(row.type || '').toLowerCase();
  const base = String(row.name || [row.type, row.model].filter(Boolean).join(' ') || 'Mezzo');
  const parole = base.split(/\s+/).filter(Boolean);
  const tipoParole = new Set(tipo.split(/[\s/]+/).filter(Boolean));
  while (parole.length > 1 && tipoParole.has(parole[0].toLowerCase())) parole.shift();
  return parole.slice(0, 2)
    .map(p => (/^[A-Z0-9.-]+$/.test(p) && /[A-Z]{2}/.test(p)) ? p.toLowerCase().replace(/(^|-)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : p)
    .join(' ');
}

const voce = (key, label, state, expiry, tipo, extra = {}) => ({ key, label, state, expiry: expiry || null, tipo, femminile: FEMMINILE.has(key), ...extra });

async function caricaExtra(companyId, ids) {
  if (!ids.length) return { promemoria: [], posti: [] };
  const [p, s] = await Promise.all([
    supabase.from('equipment_promemoria').select('id, equipment_id, tipo, testo, scadenza').eq('company_id', companyId).in('equipment_id', ids).order('scadenza'),
    supabase.from('site_equipment').select('equipment_id, site_id, assigned_at, sites(id, name, address)').eq('company_id', companyId).in('equipment_id', ids).order('assigned_at', { ascending: false }),
  ]);
  if (p.error) throw new Error(p.error.message);
  if (s.error) throw new Error(s.error.message);
  return { promemoria: p.data || [], posti: s.data || [] };
}

/** Tutto quello che si sa di un mezzo, già messo in ordine di gravità. */
function componi(m, promemoria, posti, oggiIso) {
  const row = m.row || {};
  const veicolo = isVehicle(row);
  const requisiti = m.requirements.map(r => voce(r.key, r.label, r.state, r.expiry, 'requisito', { doc: r.doc }));
  const extra = promemoria.filter(p => p.equipment_id === m.id).map(p => voce(p.tipo, PROMEMORIA[p.tipo]?.label || p.testo, STATE[complianceStatus(p.scadenza)], p.scadenza, 'promemoria', { id: p.id, testo: p.testo }));
  // Il vecchio campo «tagliando / manutenzione» compare come promemoria se non ce n'è uno nuovo
  if (row.maintenance_date && !extra.some(e => e.key === 'tagliando')) {
    extra.push(voce('tagliando', 'Tagliando', STATE[complianceStatus(row.maintenance_date)], String(row.maintenance_date).slice(0, 10), 'promemoria', { id: 'tagliando-vecchio', testo: null }));
  }
  const documenti = m.documents.filter(d => d.state === 'scaduto' || d.state === 'in_scadenza').map(d => voce(null, d.label, d.state, d.expiry, 'documento', { doc: d }));
  const problemi = [...requisiti, ...extra, ...documenti].filter(v => v.state !== 'in_regola')
    .sort((a, b) => RANK[a.state] - RANK[b.state] || String(a.expiry || '').localeCompare(String(b.expiry || '')));
  const posto = posti.find(p => p.equipment_id === m.id && p.sites);
  const haRevisione = requisiti.some(r => r.key === 'revisione');
  const calcolo = veicolo && !haRevisione
    ? prossimaRevisione({ immatricolazione: row.data_immatricolazione, massaKg: row.massa_kg }, oggiIso)
    : null;
  return {
    id: m.id, nome: nomeBreve(row), nomeCompleto: m.name, tipo: row.type || null, modello: row.model || null,
    targa: row.plate_or_serial || null, veicolo, proprieta: row.ownership || null,
    immatricolazione: row.data_immatricolazione || null, massaKg: row.massa_kg || null,
    stato: problemi[0]?.state || 'in_regola', problema: problemi[0] || null, problemi: problemi.length,
    requisiti, promemoria: extra, scadenze: [...requisiti, ...extra].filter(v => v.expiry),
    // Revisione: un veicolo senza data non è «manca» (la prima arriva dopo 4 anni), ma la pagina la chiede
    revisioneDaCalcolare: veicolo && !haRevisione && !calcolo,
    revisioneProposta: calcolo,
    dove: posto ? { id: posto.sites.id, nome: posto.sites.name } : null,
  };
}

async function panoramica(companyId, oggiIso = null) {
  const stati = await statoMezzi(companyId);
  const { promemoria, posti } = await caricaExtra(companyId, stati.map(s => s.id));
  const mezzi = stati.map(m => componi(m, promemoria, posti, oggiIso))
    .sort((a, b) => RANK[a.stato] - RANK[b.stato] || a.nome.localeCompare(b.nome, 'it'));
  const urgenti = mezzi.filter(m => m.problema && (m.problema.state === 'scaduto' || m.problema.state === 'manca'));
  const p = urgenti.sort((a, b) => RANK[a.problema.state] - RANK[b.problema.state]
    || String(a.problema.expiry || '').localeCompare(String(b.problema.expiry || '')))[0];
  const futuri = mezzi.flatMap(m => m.scadenze.filter(s => s.state !== 'scaduto').map(s => ({ mezzo: m.nome, label: s.label, expiry: s.expiry })))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  return {
    mezzi: mezzi.map(({ requisiti, promemoria: _p, scadenze, ...m }) => m),
    daSistemare: mezzi.filter(m => m.stato === 'scaduto' || m.stato === 'manca').length,
    prima: p ? { mezzoId: p.id, nome: p.nome, targa: p.targa, ...p.problema, doc: undefined } : null,
    prossima: futuri[0] || null,
  };
}

async function scheda(companyId, id, oggiIso = null) {
  const stati = await statoMezzi(companyId);
  const m = stati.find(s => s.id === id);
  if (!m) return null;
  const [{ promemoria, posti }, cantieri] = await Promise.all([
    caricaExtra(companyId, [id]),
    supabase.from('sites').select('id, name, address').eq('company_id', companyId).in('status', ['attivo', 'sospeso']).order('name'),
  ]);
  if (cantieri.error) throw new Error(cantieri.error.message);
  const c = componi(m, promemoria, posti, oggiIso);
  const { scadenze, ...resto } = c;
  return { ...resto, documenti: m.documents, cantieri: cantieri.data || [] };
}

async function mezzoDellAzienda(companyId, id) {
  const { data, error } = await supabase.from('equipment').select('id').eq('id', id).eq('company_id', companyId).eq('is_active', true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new MezziError(404, 'NOT_FOUND');
}

/** Un mezzo sta in un posto solo: il cantiere scelto, o nessuno («In magazzino»). */
async function mettiIn(companyId, id, siteId) {
  await mezzoDellAzienda(companyId, id);
  if (siteId) {
    const { data } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).maybeSingle();
    if (!data) throw new MezziError(400, 'SITE_NOT_FOUND');
  }
  const del = await supabase.from('site_equipment').delete().eq('company_id', companyId).eq('equipment_id', id);
  if (del.error) throw new Error(del.error.message);
  if (siteId) {
    const ins = await supabase.from('site_equipment').insert({ company_id: companyId, site_id: siteId, equipment_id: id });
    if (ins.error) throw new Error(ins.error.message);
  }
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

async function aggiungiPromemoria(companyId, userId, id, { tipo, testo, scadenza }) {
  await mezzoDellAzienda(companyId, id);
  if (!PROMEMORIA[tipo]) throw new MezziError(400, 'TIPO_NON_VALIDO');
  if (!DATA.test(String(scadenza || ''))) throw new MezziError(400, 'SCADENZA_RICHIESTA');
  const t = String(testo || '').trim().slice(0, 80) || null;
  if (tipo === 'altro' && !t) throw new MezziError(400, 'TESTO_RICHIESTO');
  // Un promemoria per tipo (tranne «altro»): il nuovo prende il posto del vecchio
  if (tipo !== 'altro') {
    const del = await supabase.from('equipment_promemoria').delete().eq('company_id', companyId).eq('equipment_id', id).eq('tipo', tipo);
    if (del.error) throw new Error(del.error.message);
    if (tipo === 'tagliando') await supabase.from('equipment').update({ maintenance_date: null }).eq('id', id).eq('company_id', companyId);
  }
  const { data, error } = await supabase.from('equipment_promemoria')
    .insert({ company_id: companyId, equipment_id: id, tipo, testo: tipo === 'altro' ? t : null, scadenza, created_by: userId || null })
    .select('id').single();
  if (error) throw new Error(error.message);
  return data;
}

async function togliPromemoria(companyId, id, promemoriaId) {
  await mezzoDellAzienda(companyId, id);
  if (promemoriaId === 'tagliando-vecchio') {
    const { error } = await supabase.from('equipment').update({ maintenance_date: null }).eq('id', id).eq('company_id', companyId);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from('equipment_promemoria').delete().eq('company_id', companyId).eq('equipment_id', id).eq('id', promemoriaId);
  if (error) throw new Error(error.message);
}

/**
 * Crea un mezzo da quello che il titolare ha confermato.
 * Veicolo: tipo, nome (marca e modello), targa, immatricolazione, massa, revisione.
 * Attrezzatura: tipo «Attrezzatura» o quello scelto, nome, eventuale verifica periodica.
 */
async function crea(companyId, userId, b) {
  const nome = String(b.nome || '').trim().slice(0, 120);
  if (nome.length < 2) throw new MezziError(400, 'NOME_RICHIESTO');
  const targa = String(b.targa || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const tipo = String(b.tipo || (targa ? 'Autocarro' : 'Attrezzatura')).trim().slice(0, 60);
  const d = (v) => (DATA.test(String(v || '')) ? v : null);
  if (targa) {
    const { data: tutti } = await supabase.from('equipment').select('id, plate_or_serial').eq('company_id', companyId).eq('is_active', true);
    const dop = (tutti || []).find(e => String(e.plate_or_serial || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === targa);
    if (dop) throw Object.assign(new MezziError(409, 'TARGA_GIA_PRESENTE'), { id: dop.id });
  }
  const massa = Number(b.massaKg) > 0 && Number(b.massaKg) < 100000 ? Math.round(Number(b.massaKg)) : null;
  const immatricolazione = d(b.immatricolazione);
  const { data, error } = await supabase.from('equipment').insert({
    company_id: companyId, type: tipo, name: `${tipo} ${nome}`.trim(), model: nome,
    plate_or_serial: targa, ownership: 'Aziendale',
    data_immatricolazione: immatricolazione, massa_kg: massa,
    anno_immatricolazione: immatricolazione ? immatricolazione.slice(0, 4) : null,
    inspection_date: d(b.revisione), insurance_expiry: d(b.assicurazione),
  }).select('id').single();
  if (error) throw new Error(error.message);
  if (d(b.verifica)) await aggiungiPromemoria(companyId, userId, data.id, { tipo: 'verifica', scadenza: b.verifica });
  return data;
}

/** Dal libretto di un mezzo che c'è già: immatricolazione, massa, revisione. */
async function aggiorna(companyId, id, b) {
  await mezzoDellAzienda(companyId, id);
  const patch = {};
  if (b.immatricolazione !== undefined) {
    patch.data_immatricolazione = DATA.test(String(b.immatricolazione || '')) ? b.immatricolazione : null;
    if (patch.data_immatricolazione) patch.anno_immatricolazione = patch.data_immatricolazione.slice(0, 4);
  }
  if (b.massaKg !== undefined) patch.massa_kg = Number(b.massaKg) > 0 && Number(b.massaKg) < 100000 ? Math.round(Number(b.massaKg)) : null;
  if (b.revisione !== undefined) patch.inspection_date = DATA.test(String(b.revisione || '')) ? b.revisione : null;
  if (b.targa !== undefined) patch.plate_or_serial = String(b.targa || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  if (!Object.keys(patch).length) return;
  const { error } = await supabase.from('equipment').update(patch).eq('id', id).eq('company_id', companyId);
  if (error) throw new Error(error.message);
}

/** «Non lo usiamo più»: come il vecchio Archivia, si può recuperare. */
async function togli(companyId, id) {
  await mezzoDellAzienda(companyId, id);
  const { error } = await supabase.from('equipment').update({ is_active: false }).eq('id', id).eq('company_id', companyId);
  if (error) throw new Error(error.message);
  await supabase.from('site_equipment').delete().eq('company_id', companyId).eq('equipment_id', id);
}

module.exports = { panoramica, scheda, mettiIn, aggiungiPromemoria, togliPromemoria, crea, aggiorna, togli, nomeBreve, MezziError, PROMEMORIA };
