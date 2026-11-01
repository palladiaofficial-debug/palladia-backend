'use strict';
/**
 * lib/fatture.js — F-423 (AUDIT.md del frontend): la fattura di un fornitore e il
 * suo confronto con le bolle (schermata 5 del disegno «Palladia per il lancio»).
 *
 *  scheda()  → la fattura, l'esito, materiale per materiale, le bolle abbinate e il
 *              messaggio pronto per «Chiedi a <fornitore>» (WhatsApp o email: lo manda il titolare)
 *  vaBene()  → «Va bene così»: il titolare decide sopra al confronto
 *  file()    → link firmato (10 minuti) per guardare la fattura
 * Le fatture si salvano da «Carica un documento» (lib/impreseCarica) col confronto
 * di lib/confronto.js; quelle che non tornano vanno su Oggi (lib/daFare).
 */
const supabase = require('./supabase');
const { messaggio } = require('./confronto');

const BUCKET = 'site-documents';
class FattureError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

async function riga(companyId, id) {
  const { data, error } = await supabase.from('fatture').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
  if (error && error.code !== '22P02') throw new Error(error.message);
  if (!data) throw new FattureError(404, 'NOT_FOUND');
  return data;
}

async function scheda(companyId, id) {
  const f = await riga(companyId, id);
  const [{ data: bolle }, { data: co }] = await Promise.all([
    supabase.from('bolle').select('id, site_id, numero, data, righe, sites(name)').eq('company_id', companyId).eq('fattura_id', id).order('data'),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ]);
  const b = (bolle || []).map(x => ({ id: x.id, siteId: x.site_id, cantiere: x.sites?.name || null, numero: x.numero, data: x.data ? String(x.data).slice(0, 10) : null, materiali: (x.righe || []).length }));
  const conf = f.confronto || {};
  const testo = f.esito === 'non_torna' ? messaggio({ azienda: co?.name, fornitore: f.fornitore, numero: f.numero, data: f.data ? String(f.data).slice(0, 10) : null, confronto: conf, bolle: b }) : null;
  return {
    id: f.id, fornitore: f.fornitore, numero: f.numero, data: f.data ? String(f.data).slice(0, 10) : null, totale: f.totale != null ? Number(f.totale) : null,
    esito: f.esito, accettata: !!f.accettata_at, frase: conf.frase || null, inPiuEuro: conf.inPiuEuro || 0, righe: conf.righe || [], tornano: conf.tornano || [],
    bolle: b,
    chiedi: testo ? { testo, whatsapp: `https://wa.me/?text=${encodeURIComponent(testo)}`, email: `mailto:?subject=${encodeURIComponent(`Fattura${f.numero ? ` n. ${f.numero}` : ''}: da controllare`)}&body=${encodeURIComponent(testo)}` } : null,
  };
}

async function vaBene(companyId, id) {
  await riga(companyId, id);
  const { error } = await supabase.from('fatture').update({ accettata_at: new Date().toISOString() }).eq('id', id).eq('company_id', companyId);
  if (error) throw new Error(error.message);
  return { accettata: true };
}

async function file(companyId, id) {
  const f = await riga(companyId, id);
  if (!f.file_path) throw new FattureError(404, 'NO_FILE');
  const r = await supabase.storage.from(BUCKET).createSignedUrl(f.file_path, 600);
  if (r.error) throw new Error(r.error.message);
  return { url: r.data.signedUrl };
}

module.exports = { scheda, vaBene, file, FattureError };
