'use strict';
/**
 * lib/uscitaAnticipata.js — F-318 (AUDIT.md del frontend), "Esci prima del solito. Perché?"
 *
 * Decisione del titolare (2026-10-09): agli operai NESSUNA domanda nei giorni
 * normali; UNA domanda solo quando escono prima del loro orario solito.
 * L'uscita è già registrata (POST /badge/:code/punch, invariato): qui si
 * decide soltanto se chiedere e si salva la risposta in presence_log_reasons.
 *
 *   - orario solito = mediana dell'ultima uscita del giorno negli ultimi 35
 *     giorni (oggi escluso), con almeno 5 giorni di storico: per un operaio
 *     nuovo nessuna domanda (la pioggia la propone comunque il titolare);
 *   - si chiede se l'uscita è almeno 60 minuti prima del solito;
 *   - non si chiede se a quell'ora, di solito, esce e poi rientra (pausa
 *     pranzo timbrata): la domanda arriverebbe ogni giorno.
 *
 * Risposte: maltempo (da confermare dal titolare), permesso, malattia,
 * infortunio (avviso immediato al titolare), fine ("ho finito": niente da salvare).
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { tagPresenceLogReason } = require('./presenceLogReasons');

const WINDOW_MS = 30 * 60 * 1000;   // solo l'uscita appena fatta
const MIN_DAYS = 5;                  // storico minimo per avere un "solito"
const EARLY_MIN = 60;                // almeno un'ora prima del solito
const PAUSE_TOLERANCE_MIN = 45;      // uscite "alla stessa ora" seguite da rientro
const PAUSE_SHARE = 0.3;             // in almeno il 30% dei giorni = è la pausa
const RISPOSTE = ['maltempo', 'permesso', 'malattia', 'infortunio', 'fine'];

const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function romeMinutes(iso) {
  const [h, m] = new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return (h % 24) * 60 + m;
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : Math.round((a[n / 2 - 1] + a[n / 2]) / 2);
}

/** Abitudini dell'operaio: uscita solita e uscite a metà giornata seguite da rientro. */
async function abitudini(companyId, workerId, now = new Date()) {
  const since = new Date(now.getTime() - 35 * 864e5).toISOString();
  const today = romeDay(now.toISOString());
  const { data, error } = await supabase.from('presence_logs')
    .select('event_type, timestamp_server')
    .eq('company_id', companyId).eq('worker_id', workerId)
    .gte('timestamp_server', since).order('timestamp_server', { ascending: true }).limit(2000);
  if (error) throw new Error(error.message);
  const byDay = new Map();
  for (const l of data || []) {
    const d = romeDay(l.timestamp_server);
    if (d === today) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ t: l.event_type, min: romeMinutes(l.timestamp_server) });
  }
  const ultimeUscite = [];
  const usciteRientrate = []; // per giorno: minuti delle uscite seguite da un'entrata lo stesso giorno
  for (const evs of byDay.values()) {
    const exits = evs.filter(e => e.t === 'EXIT');
    if (exits.length) ultimeUscite.push(exits[exits.length - 1].min);
    const rientri = [];
    evs.forEach((e, i) => { if (e.t === 'EXIT' && evs.slice(i + 1).some(x => x.t === 'ENTRY')) rientri.push(e.min); });
    usciteRientrate.push(rientri);
  }
  return {
    giorni: ultimeUscite.length,
    uscitaSolita: ultimeUscite.length ? median(ultimeUscite) : null,
    usciteRientrate,
  };
}

/** Deve chiedere il motivo per un'uscita alle `exitMin` (minuti dalla mezzanotte, ora italiana)? */
function decidi(ab, exitMin) {
  if (ab.giorni < MIN_DAYS || ab.uscitaSolita == null) return { ask: false, motivo: 'storico_insufficiente' };
  if (exitMin > ab.uscitaSolita - EARLY_MIN) return { ask: false, motivo: 'orario_normale' };
  const giorniPausa = ab.usciteRientrate.filter(r => r.some(m => Math.abs(m - exitMin) <= PAUSE_TOLERANCE_MIN)).length;
  if (giorniPausa / ab.usciteRientrate.length >= PAUSE_SHARE) return { ask: false, motivo: 'pausa_abituale' };
  return { ask: true, motivo: 'uscita_anticipata' };
}

/** Lavoratore dal badge + la sua ultima timbratura, se è un'uscita recente. */
async function ultimaUscita(badgeCode, now = new Date()) {
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
  if (!last || last.event_type !== 'EXIT') return { error: 'NO_RECENT_EXIT', status: 409 };
  if (now.getTime() - new Date(last.timestamp_server).getTime() > WINDOW_MS) return { error: 'EXIT_TOO_OLD', status: 409 };
  return { worker, last };
}

/** GET: va fatta la domanda? */
async function domanda(badgeCode, now = new Date()) {
  const u = await ultimaUscita(badgeCode, now);
  if (u.error) return u;
  const ab = await abitudini(u.worker.company_id, u.worker.id, now);
  const exitMin = romeMinutes(u.last.timestamp_server);
  const d = decidi(ab, exitMin);
  return { ask: d.ask, motivo: d.motivo, uscita: hhmm(exitMin), uscita_solita: ab.uscitaSolita != null ? hhmm(ab.uscitaSolita) : null };
}

/** POST: salva la risposta. */
async function rispondi(badgeCode, risposta, { now = new Date(), notify = null } = {}) {
  if (!RISPOSTE.includes(risposta)) return { error: 'INVALID_REASON', status: 400 };
  const u = await ultimaUscita(badgeCode, now);
  if (u.error) return u;
  const { worker, last } = u;
  if (risposta === 'fine') return { ok: true, saved: false };

  // Doppio tocco: stessa risposta già salvata dall'operaio su questa uscita
  const { data: prev } = await supabase.from('presence_log_reasons')
    .select('reason').eq('presence_log_id', last.id).eq('da_lavoratore', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (prev?.reason === risposta) return { ok: true, saved: true, unchanged: true };

  const r = await tagPresenceLogReason({
    companyId: worker.company_id, logId: last.id, reason: risposta, note: null, userId: null,
    daLavoratore: true,
    // La pioggia la decide il titolare (CIGO/Cassa Edile): fino ad allora non conta
    stato: risposta === 'maltempo' ? 'da_confermare' : 'confermato',
  });
  if (!r.ok) return { error: r.code, status: r.code === 'DB_ERROR' ? 500 : 400 };

  if (risposta === 'infortunio') {
    const { data: site } = await supabase.from('sites').select('id, name').eq('id', last.site_id).maybeSingle();
    const ora = hhmm(romeMinutes(last.timestamp_server));
    // entity_id univoco: due infortuni non si sovrascrivono mai
    await supabase.from('notifications').insert({
      company_id: worker.company_id, type: 'worker_injury', severity: 'critical',
      title: `Infortunio: ${worker.full_name}`,
      body: `${site?.name || 'Cantiere'}, oggi alle ${ora}: ha indicato "Mi sono fatto male" uscendo. Chiamalo subito. Se il medico dà più di 3 giorni di prognosi, la denuncia all'INAIL va fatta entro 2 giorni.`,
      entity_type: 'worker_injury', entity_id: crypto.randomUUID(),
    });
    if (notify) await notify({ companyId: worker.company_id, siteId: site?.id || last.site_id, siteName: site?.name || 'Cantiere', workerName: worker.full_name, ora }).catch(() => {});
  }
  return { ok: true, saved: true };
}

module.exports = { domanda, rispondi, decidi, abitudini, RISPOSTE, romeMinutes };
