'use strict';
// ── Liste lunghe in .in() (F-325, AUDIT.md del frontend) ─────────────────────
// PostgREST mette la lista di .in() nell'indirizzo della richiesta: con ~400
// UUID la richiesta fallisce ("TypeError: fetch failed") e supabase-js non
// lancia, restituisce { error }. Se l'errore non è controllato la lista torna
// vuota in silenzio — è successo al Riepilogo del cantiere: sparivano tutte le
// voci "formazione scaduta". Qui la lista si spezza in blocchi e un errore
// vero si fa sentire.

/**
 * @param {Iterable<string>} ids
 * @param {(blocco: string[]) => Promise<{data?: any[], error?: any} | any[]>} build
 * @param {number} [size]
 * @returns {Promise<any[]>}
 */
async function inAPezzi(ids, build, size = 150) {
  const lista = [...new Set(ids)];
  const out = [];
  for (let i = 0; i < lista.length; i += size) {
    const r = await build(lista.slice(i, i + size));
    if (Array.isArray(r)) { out.push(...r); continue; }
    if (r?.error) throw new Error(r.error.message || String(r.error));
    out.push(...(r?.data || []));
  }
  return out;
}

module.exports = { inAPezzi };
