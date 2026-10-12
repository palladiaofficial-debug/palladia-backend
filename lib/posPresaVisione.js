'use strict';
// ── Chi deve prendere visione di un POS, e chi l'ha fatto (F-340) ───────────
// Prima si contavano solo gli assegnati al cantiere (worksite_workers), ma gli
// operai che girano tra i cantieri non si assegnano (regola del titolare): su
// Via Lucarno 45 gli assegnati erano 0 e la presa visione risultava "nessuno
// da firmare". Ora: assegnati + chi è ENTRATO in quel cantiere da quando il
// POS esiste (presence_logs), sempre dell'impresa giusta (subappaltatore o no,
// come lib/posForWorker.js). La timbratura non viene toccata: solo letture.
const supabase = require('./supabase');

const MAX_LOGS = 20000;

/**
 * docs: [{ id, site_id, created_at, pos_data }] (ultimo POS per cantiere e impresa)
 * → Map(posId → { attesi: Set(workerId), accettati: Map(workerId → riga ack) })
 */
async function presaVisionePerPos(docs) {
  const out = new Map();
  if (!docs.length) return out;
  const siteIds = [...new Set(docs.map(d => d.site_id))];
  const since = docs.map(d => d.created_at).sort()[0];
  const [assignRes, logsRes, acksRes] = await Promise.all([
    supabase.from('worksite_workers').select('site_id, worker_id').in('site_id', siteIds).eq('status', 'active'),
    supabase.from('presence_logs').select('site_id, worker_id, timestamp_server').in('site_id', siteIds).eq('event_type', 'ENTRY').gte('timestamp_server', since).limit(MAX_LOGS),
    // select('*'): funziona anche prima della migrazione 251 (colonne nuove assenti)
    supabase.from('pos_acknowledgments').select('*').in('pos_id', docs.map(d => d.id)),
  ]);
  for (const r of [assignRes, logsRes, acksRes]) if (r.error) throw r.error;

  const ids = new Set([...(assignRes.data || []), ...(logsRes.data || [])].map(x => x.worker_id));
  const workers = new Map();
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 300) {
    const { data, error } = await supabase.from('workers').select('id, full_name, subcontractor_id, is_active').in('id', idList.slice(i, i + 300));
    if (error) throw error;
    for (const w of data || []) workers.set(w.id, w);
  }

  for (const d of docs) {
    const subId = d.pos_data?.subcontractorId || null;
    const giusto = (wid) => { const w = workers.get(wid); return w && w.is_active !== false && (w.subcontractor_id || null) === subId; };
    const attesi = new Set();
    for (const a of assignRes.data || []) if (a.site_id === d.site_id && giusto(a.worker_id)) attesi.add(a.worker_id);
    for (const l of logsRes.data || []) if (l.site_id === d.site_id && l.timestamp_server >= d.created_at && giusto(l.worker_id)) attesi.add(l.worker_id);
    const accettati = new Map((acksRes.data || []).filter(a => a.pos_id === d.id).map(a => [a.worker_id, a]));
    out.set(d.id, { attesi, accettati, workers });
  }
  return out;
}

/** Elenco per il titolare: chi ha preso visione (quando, come) e chi non ancora. */
async function elencoPresaVisione(doc) {
  const m = (await presaVisionePerPos([doc])).get(doc.id);
  const ids = new Set([...m.attesi, ...m.accettati.keys()]);
  const missing = [...ids].filter(id => !m.workers.has(id));
  if (missing.length) {
    const { data } = await supabase.from('workers').select('id, full_name, subcontractor_id, is_active').in('id', missing);
    for (const w of data || []) m.workers.set(w.id, w);
  }
  return [...ids].map(id => {
    const a = m.accettati.get(id);
    const sec = Array.isArray(a?.secondi_schede) ? a.secondi_schede.reduce((s, x) => s + (Number(x) || 0), 0) : null;
    return {
      worker_id: id,
      worker_name: m.workers.get(id)?.full_name || '—',
      signed: !!a,
      signed_at: a?.acknowledged_at || null,
      canale: a?.canale || (a ? 'scan' : null),
      lingua: a?.lingua || null,
      secondi: a ? sec : null,
    };
  }).sort((x, y) => (x.signed - y.signed) || x.worker_name.localeCompare(y.worker_name, 'it'));
}

module.exports = { presaVisionePerPos, elencoPresaVisione };
