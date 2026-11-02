'use strict';
// ── La sicurezza di ogni cantiere (F-424, AUDIT.md del frontend) ─────────────
// Una catena per cantiere aperto: il PSC del coordinatore → il tuo POS → i POS
// delle imprese → gli operai che l'hanno letto quando timbrano (F-340), e una
// frase sola su cosa manca.
//   PSC       — caricato in Documenti del cantiere (site_documents 'psc'). Serve
//               solo se in cantiere lavora più di un'impresa: senza imprese «non serve».
//   il tuo POS — fatto con Palladia (pos_documents senza subcontractorId) o caricato
//               come file (site_documents 'pos'); «non serve» se il titolare l'ha detto.
//   imprese   — quelle assegnate al cantiere: il loro POS dal link o da «Carica un
//               documento» (subcontractor_documents 'pos' con site_id, col giudizio
//               del modello come in lib/impreseLink.js) o fatto con Palladia.
//   operai    — presa visione dei POS fatti con Palladia (lib/posPresaVisione.js).
//               Un POS caricato come file non si mostra a chi timbra: operai = null.
// Gli operai non decidono «a posto»: leggono quando timbrano (azzurro, non arancione).
const supabase = require('./supabase');
const { presaVisionePerPos } = require('./posPresaVisione');
const { isFeatureEnabled } = require('./featureFlags');
const { coperturePerCantiere } = require('./pscLetto');
const { controlliPerDocumenti } = require('./posImprese');

class SicurezzaError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const dbErr = (e) => { if (e) throw new Error(e.message); };
const APERTI = ['attivo', 'sospeso'];
const LINGUA = { it: 'Italiano', ro: 'Rumeno', sq: 'Albanese', ar: 'Arabo', en: 'Inglese', fr: 'Francese', es: 'Spagnolo' };
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const romaOggi = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
const diff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
function quandoParte(inizio, oggi) {
  if (!inizio) return null;
  const n = diff(inizio, oggi);
  if (n < 0 || n > 14) return null;
  if (n === 0) return 'oggi';
  if (n === 1) return 'domani';
  const d = new Date(`${inizio}T12:00:00Z`);
  return n < 7 ? GIORNI[d.getUTCDay()] : `il ${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
}
// Il giudizio sul POS di un'impresa, come in lib/impreseLink.js (statoImpresa)
const statoDoc = (u) => (!u ? 'manca' : u.esito === 'non_va' ? 'non_va' : u.esito === null && u.dall_impresa ? 'da_guardare' : 'ok');

/** I dati di più cantieri in una volta (una lettura per tabella). */
async function catene(companyId, sites, { conElenco = false } = {}) {
  if (!sites.length) return [];
  const ids = sites.map(s => s.id);
  let subsAccese = false;
  try { subsAccese = await isFeatureEnabled(companyId, 'subappaltatori'); } catch { subsAccese = false; }
  const [{ data: co }, posRes, docRes, assRes, subDocRes] = await Promise.all([
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    supabase.from('pos_documents').select('id, site_id, revision, created_at, pos_data').eq('company_id', companyId).in('site_id', ids).order('created_at', { ascending: false }),
    supabase.from('site_documents').select('id, site_id, category, name, created_at').eq('company_id', companyId).in('site_id', ids).in('category', ['pos', 'psc']).order('created_at', { ascending: false }),
    subsAccese
      ? supabase.from('site_subcontractors').select('site_id, subcontractor_id, subcontractors(id, company_name, is_active)').eq('company_id', companyId).in('site_id', ids)
      : Promise.resolve({ data: [] }),
    supabase.from('subcontractor_documents').select('id, subcontractor_id, site_id, esito, dall_impresa, created_at').eq('company_id', companyId).eq('category', 'pos').in('site_id', ids).order('created_at', { ascending: false }),
  ]);
  for (const r of [posRes, docRes, assRes, subDocRes]) dbErr(r.error);
  const nostra = co?.name || 'La tua impresa';

  // L'ultimo POS fatto con Palladia per (cantiere, impresa)
  const ultimoPos = new Map();
  for (const d of posRes.data || []) {
    const k = `${d.site_id}|${d.pos_data?.subcontractorId || ''}`;
    if (!ultimoPos.has(k)) ultimoPos.set(k, d);
  }
  const [pv, coperture] = await Promise.all([presaVisionePerPos([...ultimoPos.values()]), coperturePerCantiere(companyId, ids)]);

  // F-427: l'ultimo POS mandato da ogni impresa per cantiere, e il controllo dell'impresa principale
  const ultimoSub = new Map();
  for (const d of subDocRes.data || []) { const k = `${d.site_id}|${d.subcontractor_id}`; if (!ultimoSub.has(k)) ultimoSub.set(k, d); }
  const ctl = await controlliPerDocumenti(companyId, [...ultimoSub.values()].map(d => d.id));

  return sites.map(s => {
    const nonServono = new Set(s.documenti_non_servono || []);
    const file = (cat) => (docRes.data || []).find(d => d.site_id === s.id && d.category === cat) || null;

    const visti = new Set();
    const imprese = (assRes.data || []).filter(a => a.site_id === s.id && a.subcontractors && a.subcontractors.is_active !== false && !visti.has(a.subcontractor_id) && visti.add(a.subcontractor_id))
      .map(a => {
        const fatto = ultimoPos.get(`${s.id}|${a.subcontractor_id}`);
        const u = ultimoSub.get(`${s.id}|${a.subcontractor_id}`) || null;
        // Il più recente decide: un POS fatto con Palladia dopo uno che «non va» lo supera
        let stato = fatto && (!u || fatto.created_at >= u.created_at) ? 'ok' : statoDoc(u);
        // F-427: un POS che non torna col controllo dell'impresa principale, finché non si dice «Va bene così»
        const c = u && ctl.get(u.id);
        if (stato === 'ok' && c && c.esito === 'non_torna' && !c.accettato && !(fatto && fatto.created_at >= u.created_at)) stato = 'non_torna';
        return { id: a.subcontractor_id, nome: a.subcontractors.company_name, stato };
      })
      .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

    const pscFile = file('psc');
    // F-426: dalla lettura salvata del PSC, quante cose chiede e quante il tuo POS non ha (null = non ancora letto)
    const cop = coperture.get(s.id);
    const psc = pscFile ? { stato: 'presente', data: pscFile.created_at.slice(0, 10), docId: pscFile.id, nome: pscFile.name, chiede: cop ? cop.chiede : null, mancano: cop ? cop.mancano : null }
      : nonServono.has('psc') || !imprese.length ? { stato: 'non_serve' } : { stato: 'manca' };

    const mio = ultimoPos.get(`${s.id}|`);
    const posFile = file('pos');
    const pos = mio ? { stato: 'presente', fonte: 'palladia', revisione: mio.revision, data: mio.created_at.slice(0, 10), posId: mio.id }
      : posFile ? { stato: 'presente', fonte: 'file', revisione: null, data: posFile.created_at.slice(0, 10), docId: posFile.id }
      : nonServono.has('pos') ? { stato: 'non_serve' } : { stato: 'manca' };

    // Operai: tutti i POS fatti con Palladia di questo cantiere (il tuo e quelli delle imprese qui)
    const docs = [...ultimoPos.values()].filter(d => d.site_id === s.id && (!d.pos_data?.subcontractorId || visti.has(d.pos_data.subcontractorId)));
    let operai = null, elenco = null;
    if (docs.length) {
      let attesi = 0, letto = 0;
      elenco = [];
      const nomeImpresa = new Map(imprese.map(i => [i.id, i.nome]));
      for (const d of docs) {
        const { attesi: at, accettati, workers } = pv.get(d.id);
        attesi += at.size;
        for (const w of at) if (accettati.has(w)) letto++;
        if (conElenco) {
          for (const w of new Set([...at, ...accettati.keys()])) {
            const a = accettati.get(w);
            const sub = d.pos_data?.subcontractorId || null;
            elenco.push({ workerId: w, nome: workers.get(w)?.full_name || '—', impresa: sub ? nomeImpresa.get(sub) || 'Impresa' : nostra, lingua: a?.lingua ? LINGUA[a.lingua] || a.lingua : null, letto: a?.acknowledged_at || null });
          }
        }
      }
      operai = { letto, attesi };
    }

    return { s, psc, pos, imprese, operai, elenco };
  });
}

/** Una riga della catena: cosa manca, in una frase, e il tasto giusto. */
function riga({ s, psc, pos, imprese, operai }, oggi) {
  const parte = quandoParte(s.start_date, oggi);
  const impMale = imprese.filter(i => i.stato !== 'ok');
  let frase, tono = 'arancio', azione = null, impresaId = null;
  if (pos.stato === 'manca') {
    frase = `Manca il tuo POS${parte ? ` · parte ${parte}` : ''}`; azione = 'pos';
  } else if (impMale.length > 1) {
    frase = `${impMale.length} imprese non hanno il POS a posto`; azione = 'impresa';
  } else if (impMale.length === 1) {
    const i = impMale[0];
    frase = i.stato === 'non_torna' ? `Il POS di ${i.nome} non torna con il tuo` : i.stato === 'non_va' ? `Il POS di ${i.nome} non va` : i.stato === 'da_guardare' ? `Il POS di ${i.nome} è da guardare` : `Manca il POS di ${i.nome}`;
    azione = 'impresa'; impresaId = i.id;
  } else if (psc.stato === 'manca') {
    frase = 'Manca il PSC del coordinatore'; azione = 'psc';
  } else if (psc.mancano > 0 && pos.stato === 'presente') {
    frase = `Il PSC chiede ${psc.mancano} ${psc.mancano === 1 ? 'cosa' : 'cose'} che il tuo POS non ha`; azione = 'psc_pos';
  } else if (pos.stato === 'non_serve') {
    frase = 'Il POS non serve qui'; tono = 'verde';
  } else if (operai && operai.attesi > operai.letto) {
    frase = `A posto · ${operai.letto} ${operai.letto === 1 ? "operaio su " + operai.attesi + " l'ha letto" : "operai su " + operai.attesi + " l'hanno letto"}`; tono = 'blu'; azione = 'operai';
  } else if (operai && operai.attesi) {
    frase = `A posto · tutti e ${operai.attesi} l'hanno letto`; tono = 'verde';
  } else if (pos.fonte === 'file') {
    frase = 'A posto · il POS è un file: gli operai non lo vedono quando timbrano'; tono = 'verde';
  } else {
    frase = 'A posto'; tono = 'verde';
  }
  const aPosto = pos.stato !== 'manca' && !impMale.length && psc.stato !== 'manca' && !(psc.mancano > 0);
  return {
    id: s.id, nome: s.name, indirizzo: s.address || null, inizio: s.start_date || null, parte,
    psc, pos, imprese, operai, frase, tono, azione, impresaId, aPosto,
  };
}

async function cantieriAperti(companyId, siteId) {
  let q = supabase.from('sites').select('id, name, address, status, start_date, documenti_non_servono').eq('company_id', companyId).in('status', APERTI);
  if (siteId) q = q.eq('id', siteId);
  const { data, error } = await q.order('name');
  dbErr(error);
  return data || [];
}

/** Cantieri › Sicurezza: tutti i cantieri aperti, prima quelli da sistemare. */
async function elenco(companyId, { oggi = romaOggi() } = {}) {
  const sites = await cantieriAperti(companyId);
  const cantieri = (await catene(companyId, sites)).map(c => riga(c, oggi))
    .sort((a, b) => (a.aPosto - b.aPosto) || a.nome.localeCompare(b.nome, 'it'));
  return { cantieri, aPosto: cantieri.filter(c => c.aPosto).length, totale: cantieri.length };
}

/** La sicurezza di un cantiere: la catena e chi ha letto il POS (prima chi manca). */
async function cantiere(companyId, siteId, { oggi = romaOggi() } = {}) {
  const sites = await cantieriAperti(companyId, siteId);
  if (!sites.length) throw new SicurezzaError(404, 'NOT_FOUND');
  const [c] = await catene(companyId, sites, { conElenco: true });
  const operaiElenco = (c.elenco || []).sort((a, b) => (!!a.letto - !!b.letto) || a.nome.localeCompare(b.nome, 'it'));
  return { ...riga(c, oggi), operaiElenco };
}

module.exports = { elenco, cantiere, SicurezzaError, quandoParte };
