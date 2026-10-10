'use strict';
/**
 * lib/cantiereRiepilogo.js — F-321 (AUDIT.md del frontend): scheda cantiere senza cartelle.
 *
 * Il titolare (10/10): "la gestione cantieri è terribile e poco chiara […]
 * cartelle per nulla intuitive". La scheda nuova apre su un Riepilogo con
 * "Da sistemare": frasi brevi, ognuna con un tasto. Qui si decide cosa va lì,
 * guardando cosa succede DAVVERO nel cantiere (le timbrature), non le date:
 *   - "al lavoro" = qualcuno ha timbrato qui negli ultimi 30 giorni;
 *   - pioggia da decidere: le stesse proposte di Ore e assenze
 *     (lib/pioggiaDaConfermare.js), solo quelle che sono una decisione vera;
 *   - chi lavora qui con formazione o idoneità scaduta o mancante
 *     (lib/compliance.js, unica fonte);
 *   - POS mancante;
 *   - assegnati che non vengono (timbrano altrove o non timbrano mai);
 *   - data di fine passata mentre si lavora ancora;
 *   - posizione per timbrare mancante (dove si lavora o nei cantieri nuovi).
 * Documenti del cantiere: solo POS, PSC, notifica preliminare. DVR (spento in
 * tutta la piattaforma), DURC e assicurazione (dell'azienda) non sono più
 * "mancanti" del cantiere.
 */
const supabase = require('./supabase');
const { complianceStatus } = require('./compliance');
const { proposte } = require('./pioggiaDaConfermare');

const GIORNI_AL_LAVORO = 30;
const GIORNI_FINE_PASSATA = 7;
const GIORNI_NUOVO = 30; // cantiere appena creato: in cima all'elenco e con la posizione da impostare
const DOC_FACOLTATIVI = ['psc', 'notifica_asl'];
const DOC_NON_SERVE = ['pos', ...DOC_FACOLTATIVI]; // il POS non serve dove non è un cantiere (es. il magazzino)

const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dayStartIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 3600e3).toISOString();

// Le proposte di pioggia costano qualche secondo: l'elenco cantieri (che si
// aggiorna ogni minuto) le legge da qui. Conferma/scarta/annulla svuotano.
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map();
function invalidaPioggia(companyId) { cache.delete(companyId); }
async function proposteCached(companyId, fresh) {
  const hit = cache.get(companyId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = proposte(companyId).catch((e) => { cache.delete(companyId); throw e; });
  cache.set(companyId, { at: Date.now(), promise });
  return promise;
}

/**
 * Documenti del cantiere (F-321): POS, PSC, notifica preliminare. Ognuno può
 * essere segnato "non serve". DVR (spento), DURC e assicurazione (dell'azienda)
 * non sono documenti del cantiere.
 */
function checklistDocumenti({ conPos, categorie, nonServono = [] }) {
  const ns = new Set(nonServono);
  const voce = (tipo, label, presente) => ({ tipo, label, presente, non_serve: !presente && ns.has(tipo) });
  return [
    voce('pos', 'POS', !!conPos),
    voce('psc', 'PSC', categorie.has('psc')),
    voce('notifica_asl', 'Notifica preliminare', categorie.has('notifica_asl')),
  ];
}

async function tutte(query, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < pageSize) return out;
  }
}

/**
 * Riepilogo per cantiere. Ritorna Map(siteId → { alLavoro, ultimoGiorno, daSistemare, documenti }).
 * siteIds = null → tutti i cantieri non eliminati dell'azienda.
 */
async function riepiloghi(companyId, { siteIds = null, fresh = false, today = romeDay(new Date().toISOString()) } = {}) {
  let sq = supabase.from('sites').select('id, name, status, end_date, latitude, longitude, documenti_non_servono, created_at')
    .eq('company_id', companyId).neq('status', 'eliminato');
  if (siteIds) sq = sq.in('id', siteIds);
  const { data: sites, error } = await sq;
  if (error) throw new Error(error.message);
  const out = new Map();
  if (!sites?.length) return out;
  const ids = sites.map(s => s.id);
  const since = addDays(today, -GIORNI_AL_LAVORO);

  const [logs, assegnati, posRes, docsRes, pioggia] = await Promise.all([
    // Tutte le timbrature dell'azienda (servono anche per dire "timbra altrove")
    tutte(() => supabase.from('presence_logs').select('site_id, worker_id, event_type, timestamp_server')
      .eq('company_id', companyId).gte('timestamp_server', dayStartIso(since)).order('timestamp_server', { ascending: true })),
    tutte(() => supabase.from('worksite_workers').select('site_id, worker_id, workers(id, full_name, is_active)')
      .eq('company_id', companyId).eq('status', 'active').in('site_id', ids)),
    supabase.from('pos_documents').select('site_id').in('site_id', ids),
    supabase.from('site_documents').select('site_id, category').eq('company_id', companyId).in('site_id', ids).in('category', DOC_FACOLTATIVI),
    proposteCached(companyId, fresh).catch(() => []),
  ]);
  const conPos = new Set((posRes.data || []).map(r => r.site_id));
  const docPresenti = new Set((docsRes.data || []).map(r => `${r.site_id}|${r.category}`));

  const qui = new Map();       // siteId → Map(workerId → ultimo giorno)
  const ovunque = new Set();   // chi ha timbrato da qualche parte nei 30 giorni
  for (const l of logs) {
    const d = romeDay(l.timestamp_server);
    if (d < since) continue;
    ovunque.add(l.worker_id);
    if (!qui.has(l.site_id)) qui.set(l.site_id, new Map());
    const m = qui.get(l.site_id);
    if (!m.has(l.worker_id) || m.get(l.worker_id) < d) m.set(l.worker_id, d);
  }
  const workerIds = [...new Set([...[...qui.values()].flatMap(m => [...m.keys()])])];
  const { data: ws } = workerIds.length
    ? await supabase.from('workers').select('id, full_name, is_active, safety_training_expiry, health_fitness_expiry').eq('company_id', companyId).in('id', workerIds)
    : { data: [] };
  const worker = new Map((ws || []).map(w => [w.id, w]));

  for (const s of sites) {
    const m = qui.get(s.id) || new Map();
    const aperto = ['attivo', 'sospeso'].includes(s.status);
    const alLavoro = aperto && m.size > 0;
    let ultimo = null;
    for (const d of m.values()) if (!ultimo || d > ultimo) ultimo = d;
    const ultimoGiorno = ultimo ? { day: ultimo, persone: [...m.values()].filter(d => d === ultimo).length } : null;
    const nonServono = new Set(s.documenti_non_servono || []);
    const stato = (cat) => nonServono.has(cat) ? 'non_serve' : docPresenti.has(`${s.id}|${cat}`) ? 'presente' : 'manca';
    const documenti = { pos: conPos.has(s.id) ? 'presente' : nonServono.has('pos') ? 'non_serve' : 'manca', psc: stato('psc'), notifica_asl: stato('notifica_asl') };

    const daSistemare = [];
    if (aperto) {
      for (const p of pioggia) {
        if (p.siteId !== s.id || !['uscite', 'giornata'].includes(p.tipo)) continue;
        daSistemare.push({
          tipo: 'pioggia', kind: p.kind, day: p.day, mm: p.meteo?.mm ?? null, quale: p.tipo,
          persone: p.persone.map(x => ({ nome: x.nome, uscita: x.uscita, entrata: x.entrata, rientro: x.rientro })),
          giornataIntera: (p.giornataIntera || []).map(x => x.nome),
        });
      }
    }
    if (alLavoro) {
      const lavoratori = [...m.entries()].map(([id, d]) => ({ w: worker.get(id), d })).filter(x => x.w?.is_active)
        .sort((a, b) => a.w.full_name.localeCompare(b.w.full_name, 'it'));
      for (const { w, d } of lavoratori) {
        for (const [cosa, data] of [['formazione', w.safety_training_expiry], ['idoneita', w.health_fitness_expiry]]) {
          const st = complianceStatus(data);
          if (st === 'expired' || st === 'not_set') {
            daSistemare.push({ tipo: 'lavoratore', workerId: w.id, nome: w.full_name, cosa, stato: st === 'expired' ? 'scaduta' : 'mancante', scadenza: data || null, ultimoGiornoQui: d });
          }
        }
      }
      if (documenti.pos === 'manca') daSistemare.push({ tipo: 'pos' });
      const assenti = (assegnati || []).filter(a => a.site_id === s.id && a.workers?.is_active && !m.has(a.worker_id))
        .map(a => ({ workerId: a.worker_id, nome: a.workers.full_name, dove: ovunque.has(a.worker_id) ? 'altrove' : 'mai' }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
      if (assenti.length) daSistemare.push({ tipo: 'assenti', persone: assenti });
      if (s.end_date && s.end_date < today && ultimo && ultimo >= addDays(today, -GIORNI_FINE_PASSATA)) {
        daSistemare.push({ tipo: 'fine', endDate: s.end_date });
      }
    }
    const nuovo = s.created_at && romeDay(s.created_at) >= addDays(today, -GIORNI_NUOVO);
    if (aperto && (alLavoro || nuovo) && !(s.latitude && s.longitude)) daSistemare.push({ tipo: 'posizione' });
    out.set(s.id, { siteId: s.id, alLavoro, nuovo: !!nuovo && aperto, ultimoGiorno, daSistemare, documenti });
  }
  return out;
}

module.exports = { riepiloghi, invalidaPioggia, checklistDocumenti, DOC_NON_SERVE };
