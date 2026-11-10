'use strict';
// ── F-486: «pioggia tutto il giorno» deciso dall'ufficio, giorno per giorno ──
// Sopra la regola automatica delle 10 (F-485, lib/pioggiaGiornoIntero.js):
// intero = true → giornata di pioggia; false → ore lavorate + il resto di
// pioggia; nessuna riga → vale la regola. Tabella ore_pioggia_giorno (migr. 276).
const supabase = require('./supabase');

/**
 * Map `${worker_id}__${giorno}` → true/false nel periodo. Un errore si propaga
 * (sono ore di busta paga), tranne «tabella inesistente» (migrazione 276 non
 * ancora lanciata): senza tabella non c'è nessuna decisione e vale la regola.
 */
async function decisioniPioggia(companyId, from, to) {
  const { data, error } = await supabase.from('ore_pioggia_giorno')
    .select('worker_id, giorno, intero').eq('company_id', companyId).gte('giorno', from).lte('giorno', to);
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      console.warn('[ore_pioggia_giorno] tabella mancante: lanciare scripts/run-migration-276.js');
      return new Map();
    }
    const e = new Error(error.message); e.status = 500; throw e;
  }
  return new Map((data || []).map(r => [`${r.worker_id}__${r.giorno}`, !!r.intero]));
}

/**
 * Salva (true/false) o toglie (null) la decisione dell'ufficio per un giorno.
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
async function segnaPioggiaGiorno({ companyId, workerId, giorno, intero, user = null }) {
  const { data: w, error: wErr } = await supabase.from('workers').select('id').eq('id', workerId).eq('company_id', companyId).maybeSingle();
  if (wErr) return { ok: false, status: 500, error: wErr.message };
  if (!w) return { ok: false, status: 404, error: 'WORKER_NOT_FOUND' };
  if (intero === null) {
    const { error } = await supabase.from('ore_pioggia_giorno').delete().eq('company_id', companyId).eq('worker_id', workerId).eq('giorno', giorno);
    return error ? { ok: false, status: 500, error: error.message } : { ok: true };
  }
  const { error } = await supabase.from('ore_pioggia_giorno').upsert({
    company_id: companyId, worker_id: workerId, giorno, intero: !!intero,
    created_by: user?.id || null, created_by_email: user?.email || null, updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,worker_id,giorno' });
  return error ? { ok: false, status: 500, error: error.message } : { ok: true };
}

module.exports = { decisioniPioggia, segnaPioggiaGiorno };
