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
  const { data, error } = await supabase.from('bolle').select('id, fornitore, numero, data, firmata, righe, fattura_id, origine, created_at')
    .eq('company_id', companyId).eq('site_id', siteId).order('data', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(300);
  dbErr(error);
  return {
    cantiere: { id: site.id, nome: site.name },
    bolle: (data || []).map(b => ({
      id: b.id, fornitore: b.fornitore, numero: b.numero, data: b.data ? String(b.data).slice(0, 10) : String(b.created_at).slice(0, 10),
      firmata: b.firmata, righe: Array.isArray(b.righe) ? b.righe : [], origine: b.origine,
      stato: b.fattura_id ? 'confrontata' : 'aspetto_fattura',
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

module.exports = { elenco, file, BolleError };
