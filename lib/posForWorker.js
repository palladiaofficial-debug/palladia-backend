'use strict';
// ── Quale POS deve firmare un lavoratore in timbratura (F-260) ──────────────
// Il POS da prendere in visione è quello della SUA impresa:
//   - lavoratore dell'impresa → ultimo POS del cantiere senza subcontractorId
//   - lavoratore di un subappaltatore → ultimo POS con il suo subcontractorId;
//     se non esiste ancora, l'ultimo POS dell'impresa (com'era prima di F-258)
// Con i dati precedenti a F-258 (nessun POS con subcontractorId) il risultato
// è identico alla vecchia query "ultimo POS del cantiere".
const supabase = require('./supabase');

async function latestPosForWorker(siteId, workerId) {
  const [{ data: worker }, { data: docs }] = await Promise.all([
    supabase.from('workers').select('subcontractor_id').eq('id', workerId).maybeSingle(),
    supabase.from('pos_documents').select('id, pos_data').eq('site_id', siteId).order('created_at', { ascending: false }).limit(50),
  ]);
  const list = docs || [];
  const own = list.find(d => !d.pos_data?.subcontractorId) || null;
  const subId = worker?.subcontractor_id || null;
  if (!subId) return own;
  return list.find(d => d.pos_data?.subcontractorId === subId) || own;
}

module.exports = { latestPosForWorker };
