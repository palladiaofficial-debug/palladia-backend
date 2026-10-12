'use strict';
/**
 * lib/suntoSicurezza.js — F-340 (AUDIT.md del frontend): sunto del POS in timbratura.
 *
 * Richiesta del titolare (2026-10-12): nei cantieri l'operaio deve per forza
 * vedere e accettare il sunto del POS (pericoli e come proteggersi). Mockup
 * 02/10: cartello + 2 frasi brevi + AVANTI, ultima "HO CAPITO", nessun input,
 * nella lingua del badge; registro per il titolare (tempo per scheda, lingua,
 * versione del POS).
 *
 * Regole che non si toccano:
 *   - l'entrata è già registrata (POST /badge/:code/punch, invariato): il
 *     sunto compare DOPO, in un riquadro separato, e se il server non risponde
 *     non compare niente. Non blocca e non rallenta mai la timbratura;
 *   - "per forza": finché l'operaio non preme HO CAPITO sul POS della sua
 *     impresa per quel cantiere, il sunto ricompare a ogni entrata. Un POS
 *     nuovo (revisione) lo fa ricomparire;
 *   - il POS è quello della SUA impresa (lib/posForWorker.js, F-260).
 *
 * Schede: le 3 lavorazioni più pericolose del POS (P×D più alto), poi DPI di
 * base e cosa fare se qualcuno si fa male. Testi dalle schede lavorazione
 * (lib/lavorazioniSchede.js), traduzioni in lib/suntoSicurezzaLingue.js.
 */
const supabase = require('./supabase');
const { latestPosForWorker } = require('./posForWorker');
const { getScheda, schedaPerVoceVecchia } = require('./lavorazioniSchede');
const { FRASI, TESTI } = require('./suntoSicurezzaLingue');
const ICONE = require('./suntoSicurezzaIcone');

const LINGUE = ['it', 'ro', 'sq', 'ar'];
const GET_WINDOW_MS = 30 * 60 * 1000;      // solo subito dopo l'entrata
const POST_WINDOW_MS = 12 * 3600 * 1000;   // chi legge con calma: entro la giornata
const MAX_LAVORI = 3;

const lingua = (l) => (LINGUE.includes(l) ? l : 'it');
const frase = (it, l) => (l === 'it' ? it : FRASI[it]?.[l] || it);
const testo = (l, k, vars = {}) => String(TESTI[lingua(l)][k] ?? TESTI.it[k]).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');

/** Schede lavorazione del POS: id del nuovo percorso, oppure voci vecchie mappate. */
function schedeDelPos(posData) {
  const d = posData || {};
  const ids = Array.isArray(d.selectedSchede) && d.selectedSchede.length
    ? d.selectedSchede
    : (d.selectedWorks || []).map(v => schedaPerVoceVecchia(v)).filter(Boolean);
  const out = [];
  for (const id of ids) {
    const s = typeof id === 'string' ? getScheda(id) : null;
    if (s && !out.some(x => x.id === s.id)) out.push(s);
  }
  return out;
}

const rischioMax = (s) => Math.max(0, ...(s.rischi || []).map(([, p, d]) => p * d));
// A parità di P×D conta il danno più grave (una caduta prima di uno schizzo)
const dannoMax = (s) => Math.max(0, ...(s.rischi || []).map(([, , d]) => d));

/** Schede del sunto, già nella lingua dell'operaio. Funzione pura (testata). */
function componiSunto(posData, l = 'it') {
  l = lingua(l);
  const lavori = schedeDelPos(posData)
    .map((s, i) => ({ s, i, r: rischioMax(s), d: dannoMax(s) }))
    .sort((a, b) => b.r - a.r || b.d - a.d || a.i - b.i)
    .map(x => x.s);
  const schede = [];
  for (const s of lavori) {
    const c = s.carosello;
    if (!c) continue;
    if (schede.some(x => x.pericolo === frase(c.pericolo, l))) continue;
    schede.push({ id: s.id, ...ICONE.cartello(c.cartello.tipo, c.cartello.iso7010), pericolo: frase(c.pericolo, l), regola: frase(c.regola, l) });
    if (schede.length === MAX_LAVORI) break;
  }
  schede.push({ id: 'dpi', ...ICONE.cartello('obbligo', 'M014'), pericolo: testo(l, 'dpiPericolo'), regola: testo(l, 'dpiRegola') });
  const nome = String(posData?.primoSoccorso || '').trim();
  schede.push({ id: 'soccorso', ...ICONE.cartello('soccorso', 'E003'), pericolo: testo(l, 'sosPericolo'), regola: nome ? testo(l, 'sosRegolaNome', { nome }) : testo(l, 'sosRegola') });
  return schede;
}

/** Operaio dal badge + la sua ultima timbratura, se è un'entrata entro `windowMs`. */
async function ultimaEntrata(badgeCode, windowMs, now = new Date()) {
  const { data: worker, error } = await supabase.from('workers')
    .select('id, full_name, company_id, is_active').eq('badge_code', String(badgeCode).toUpperCase()).maybeSingle();
  if (error) return { error: 'DB_ERROR', status: 500 };
  if (!worker) return { error: 'BADGE_NOT_FOUND', status: 404 };
  if (!worker.is_active) return { error: 'BADGE_REVOKED', status: 403 };
  const { data: last, error: lErr } = await supabase.from('presence_logs')
    .select('id, event_type, site_id, timestamp_server')
    .eq('worker_id', worker.id).eq('company_id', worker.company_id)
    .order('timestamp_server', { ascending: false }).limit(1).maybeSingle();
  if (lErr) return { error: 'DB_ERROR', status: 500 };
  if (!last || last.event_type !== 'ENTRY' || !last.site_id) return { error: 'NO_RECENT_ENTRY', status: 409 };
  if (now.getTime() - new Date(last.timestamp_server).getTime() > windowMs) return { error: 'ENTRY_TOO_OLD', status: 409 };
  return { worker, last };
}

async function giaAccettato(posId, workerId) {
  const { data, error } = await supabase.from('pos_acknowledgments')
    .select('id').eq('pos_id', posId).eq('worker_id', workerId).maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

/** GET: c'è un sunto da mostrare dopo questa entrata? */
async function sunto(badgeCode, l, now = new Date()) {
  const u = await ultimaEntrata(badgeCode, GET_WINDOW_MS, now);
  if (u.error) return u;
  const pos = await latestPosForWorker(u.last.site_id, u.worker.id);
  if (!pos) return { show: false, motivo: 'nessun_pos' };
  if (await giaAccettato(pos.id, u.worker.id)) return { show: false, motivo: 'gia_accettato' };
  const { data: site } = await supabase.from('sites').select('name').eq('id', u.last.site_id).maybeSingle();
  const lg = lingua(l);
  const schede = componiSunto(pos.pos_data, lg);
  return {
    show: true, pos_id: pos.id, cantiere: site?.name || '', lingua: lg, schede,
    testi: { titolo: testo(lg, 'titolo'), sotto: testo(lg, 'sotto'), scheda: testo(lg, 'scheda'), avanti: testo(lg, 'avanti'), hoCapito: testo(lg, 'hoCapito'), fatto: testo(lg, 'fatto'), errore: testo(lg, 'errore') },
  };
}

/** POST: HO CAPITO. Salva la presa visione con lingua, schede e secondi per scheda. */
async function accetta(badgeCode, body, { now = new Date(), ip = null, ua = null } = {}) {
  const { pos_id: posId, lingua: l, schede, secondi } = body || {};
  if (typeof posId !== 'string' || !/^[0-9a-f-]{36}$/i.test(posId)) return { error: 'INVALID_POS', status: 400 };
  const u = await ultimaEntrata(badgeCode, POST_WINDOW_MS, now);
  if (u.error) return u;
  // Solo il POS che il server mostrerebbe a QUESTO operaio in QUESTO cantiere
  const pos = await latestPosForWorker(u.last.site_id, u.worker.id);
  if (!pos || pos.id !== posId) return { error: 'POS_NOT_CURRENT', status: 409 };
  if (await giaAccettato(pos.id, u.worker.id)) return { ok: true, unchanged: true };
  const ids = Array.isArray(schede) ? schede.filter(x => typeof x === 'string').slice(0, 10).map(x => x.slice(0, 60)) : [];
  const sec = Array.isArray(secondi) ? secondi.slice(0, 10).map(x => Math.max(0, Math.min(3600, Math.round(Number(x) || 0)))) : [];
  const { error } = await supabase.from('pos_acknowledgments').upsert({
    pos_id: pos.id, worker_id: u.worker.id, company_id: u.worker.company_id, site_id: u.last.site_id,
    ip, ua: (ua || '').slice(0, 200),
    canale: 'badge', lingua: lingua(l), schede: ids, secondi_schede: sec,
  }, { onConflict: 'pos_id,worker_id', ignoreDuplicates: true });
  if (error) return { error: 'DB_ERROR', status: 500 };
  return { ok: true };
}

module.exports = { sunto, accetta, componiSunto, schedeDelPos, GET_WINDOW_MS, POST_WINDOW_MS };
