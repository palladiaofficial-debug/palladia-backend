'use strict';
/**
 * lib/bolle.js — F-422 (AUDIT.md del frontend): le bolle del cantiere
 * (schermata 4 del disegno «Palladia per il lancio»).
 *
 * Le bolle arrivano da «Carica un documento», da WhatsApp o per email
 * (lib/impreseCarica: lette, controllate dal titolare, salvate nella tabella
 * `bolle` con i materiali). Qui: l'elenco di un cantiere, dalla più recente,
 * e il link firmato per guardare la foto. Lo stato dice a che punto è col
 * confronto con la fattura (passo 5): per ora «aspetto la fattura».
 */
const supabase = require('./supabase');

const BUCKET = 'site-documents';
class BolleError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const dbErr = (e) => { if (e) throw new Error(e.message); };

async function cantiereDellAzienda(companyId, siteId) {
  const { data, error } = await supabase.from('sites').select('id, name').eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
  if (error && error.code !== '22P02') throw new Error(error.message);
  if (!data) throw new BolleError(404, 'NOT_FOUND');
  return data;
}

/** Le bolle di un cantiere, dalla più recente. */
async function elenco(companyId, siteId) {
  const site = await cantiereDellAzienda(companyId, siteId);
  const { data, error } = await supabase.from('bolle').select('id, fornitore, numero, data, firmata, righe, fattura_id, origine, created_at, stato, dubbi, pagine, workers(full_name), fatture(id, numero, esito, accettata_at, confronto)')
    .eq('company_id', companyId).eq('site_id', siteId).neq('stato', 'scartata').order('data', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(300);
  dbErr(error);
  return {
    cantiere: { id: site.id, nome: site.name },
    bolle: (data || []).map(b => ({
      id: b.id, fornitore: b.fornitore, numero: b.numero, data: b.data ? String(b.data).slice(0, 10) : String(b.created_at).slice(0, 10),
      firmata: b.firmata, righe: Array.isArray(b.righe) ? b.righe : [], origine: b.origine,
      // F-500: chi l'ha portata (badge), se è da controllare e perché, quante pagine
      controllare: b.stato === 'da_controllare', dubbi: Array.isArray(b.dubbi) ? b.dubbi : [], autista: b.workers?.full_name || null,
      pagine: Array.isArray(b.pagine) && b.pagine.length ? b.pagine.length : 1, arrivata: b.created_at,
      // F-423: «La fattura non torna» / «Torna con la fattura» / «Aspetto la fattura»
      stato: !b.fattura_id || !b.fatture ? 'aspetto_fattura' : b.fatture.esito === 'non_torna' && !b.fatture.accettata_at ? 'non_torna' : 'torna',
      fattura: b.fatture ? { id: b.fatture.id, numero: b.fatture.numero, frase: b.fatture.confronto?.frase || null, accettata: !!b.fatture.accettata_at } : null,
    })),
  };
}

/** Il link (10 minuti) per guardare la foto o il PDF della bolla. */
async function file(companyId, id) {
  const { data, error } = await supabase.from('bolle').select('file_path').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (error && error.code !== '22P02') throw new Error(error.message);
  if (!data?.file_path) throw new BolleError(404, 'NOT_FOUND');
  const r = await supabase.storage.from(BUCKET).createSignedUrl(data.file_path, 600);
  if (r.error) throw new Error(r.error.message);
  return { url: r.data.signedUrl };
}

// ── F-500: le bolle da controllare (soprattutto quelle dei nostri autisti) ──
const DUBBI = ['tipo', 'fornitore', 'numero', 'data', 'materiali', 'cantiere', 'lettura'];
const CAMPI_BOLLA = 'id, site_id, fornitore, fornitore_piva, numero, data, righe, origine, stato, dubbi, pagine, file_path, mime_type, cantiere_da, created_at, workers(full_name), sites(name)';
const testa = (b) => ({
  id: b.id, fornitore: b.fornitore, numero: b.numero, data: b.data ? String(b.data).slice(0, 10) : null,
  righe: Array.isArray(b.righe) ? b.righe : [], origine: b.origine, stato: b.stato,
  dubbi: (Array.isArray(b.dubbi) ? b.dubbi : []).filter(d => DUBBI.includes(d)),
  cantiere: b.site_id ? { id: b.site_id, nome: b.sites?.name || null } : null, cantiereDa: b.cantiere_da,
  autista: b.workers?.full_name || null, arrivata: b.created_at,
  pagine: Array.isArray(b.pagine) && b.pagine.length ? b.pagine.length : 1,
});

/** Tutte le bolle da controllare dell'azienda, dalla più recente (anche senza cantiere). */
async function daControllare(companyId) {
  const { data, error } = await supabase.from('bolle').select(CAMPI_BOLLA).eq('company_id', companyId).eq('stato', 'da_controllare').order('created_at', { ascending: false }).limit(100);
  dbErr(error);
  const { data: siti } = await supabase.from('sites').select('id, name').eq('company_id', companyId).in('status', ['attivo', 'sospeso']).order('name').limit(200);
  return { bolle: (data || []).map(testa), cantieri: (siti || []).map(s => ({ id: s.id, nome: s.name })) };
}

/** Una bolla con i link (10 minuti) a tutte le sue pagine. */
async function dettaglio(companyId, id) {
  const { data: b, error } = await supabase.from('bolle').select(CAMPI_BOLLA).eq('id', id).eq('company_id', companyId).maybeSingle();
  if (error && error.code !== '22P02') throw new Error(error.message);
  if (!b) throw new BolleError(404, 'NOT_FOUND');
  const pagine = Array.isArray(b.pagine) && b.pagine.length ? b.pagine : (b.file_path ? [{ path: b.file_path, mime: b.mime_type }] : []);
  const urls = await Promise.all(pagine.map(async p => {
    const r = await supabase.storage.from(BUCKET).createSignedUrl(p.path, 600);
    return { url: r.data?.signedUrl || null, mime: p.mime || null };
  }));
  return { ...testa(b), foto: urls };
}

/**
 * L'ufficio corregge e conferma: { fornitore, numero, data, siteId, righe, stato: 'a_posto' | 'scartata' }.
 * «Non è una bolla» (scartata) la nasconde, non la cancella.
 */
async function correggi(companyId, userId, id, b) {
  const { data: prima, error: e0 } = await supabase.from('bolle').select('id, site_id').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (e0 && e0.code !== '22P02') throw new Error(e0.message);
  if (!prima) throw new BolleError(404, 'NOT_FOUND');
  const patch = {};
  const t = (v, n) => (v === undefined ? undefined : String(v || '').trim().slice(0, n) || null);
  if (b.fornitore !== undefined) patch.fornitore = t(b.fornitore, 160);
  if (b.numero !== undefined) patch.numero = t(b.numero, 40);
  if (b.data !== undefined) {
    if (b.data && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.data))) throw new BolleError(400, 'DATA_NON_VALIDA');
    patch.data = b.data || null;
  }
  if (b.siteId !== undefined) {
    if (b.siteId) {
      const { data: s } = await supabase.from('sites').select('id').eq('id', b.siteId).eq('company_id', companyId).maybeSingle();
      if (!s) throw new BolleError(400, 'CANTIERE_NON_VALIDO');
      if (b.siteId !== prima.site_id) patch.cantiere_da = 'ufficio';
    }
    patch.site_id = b.siteId || null;
  }
  if (b.righe !== undefined) {
    if (!Array.isArray(b.righe)) throw new BolleError(400, 'RIGHE_NON_VALIDE');
    patch.righe = b.righe.slice(0, 80).map(r => ({ descrizione: String(r?.descrizione || '').slice(0, 200), quantita: Number.isFinite(Number(r?.quantita)) && r?.quantita !== null && r?.quantita !== '' ? Number(r.quantita) : null, unita: r?.unita ? String(r.unita).slice(0, 20) : null })).filter(r => r.descrizione);
  }
  if (b.stato !== undefined) {
    if (!['a_posto', 'scartata'].includes(b.stato)) throw new BolleError(400, 'STATO_NON_VALIDO');
    if (b.stato === 'a_posto' && !(patch.site_id ?? prima.site_id)) throw new BolleError(400, 'MANCA_CANTIERE');
    Object.assign(patch, { stato: b.stato, dubbi: [], controllata_at: new Date().toISOString(), controllata_by: userId || null });
  }
  const { error } = await supabase.from('bolle').update(patch).eq('id', id).eq('company_id', companyId);
  dbErr(error);
  return dettaglio(companyId, id);
}

module.exports = { elenco, file, daControllare, dettaglio, correggi, BolleError };
