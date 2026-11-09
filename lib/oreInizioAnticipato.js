'use strict';
// ── Giorni «partito prima su richiesta» (F-478, AUDIT.md del frontend) ──────
// L'ufficio segna che quel giorno il lavoratore è partito prima perché gli è
// stato chiesto (trasportatori): l'orario si conta dall'entrata vera
// (lib/oreContrattuali.js, contaGiorno({ daEntrata })). Tabella
// ore_inizio_anticipato (migr. 274). Letta dal report ore e dal foglio del mese
// con la stessa funzione, così dicono le stesse ore.
const supabase = require('./supabase');

/**
 * Set di `${worker_id}__${giorno}` nel periodo. Un errore si propaga (sono ore
 * di busta paga), tranne «tabella inesistente» (migrazione 274 non ancora
 * lanciata): senza tabella non può esistere nessun segno, quindi il conteggio
 * è quello di sempre e non si nasconde niente.
 */
async function giorniInizioAnticipato(companyId, from, to) {
  const { data, error } = await supabase.from('ore_inizio_anticipato')
    .select('worker_id, giorno').eq('company_id', companyId).gte('giorno', from).lte('giorno', to);
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      console.warn('[ore_inizio_anticipato] tabella mancante: lanciare scripts/run-migration-274.js');
      return new Set();
    }
    const e = new Error(error.message); e.status = 500; throw e;
  }
  return new Set((data || []).map(r => `${r.worker_id}__${r.giorno}`));
}

module.exports = { giorniInizioAnticipato };
