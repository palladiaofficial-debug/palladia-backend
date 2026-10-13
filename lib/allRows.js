'use strict';
/**
 * Legge TUTTE le righe di una query Supabase, a pagine da 1000 (il limite di
 * default di PostgREST: oltre, le righe vengono tagliate in silenzio).
 * Un errore di lettura lancia sempre: chi avvisa non deve mai scambiare un
 * errore per "nessun risultato" (F-351, F-353).
 *
 * @param {() => object} build  funzione che crea la query (con un .order() stabile)
 * @param {string} label        nome per il messaggio d'errore
 */
const PAGE = 1000;

async function allRows(build, label = 'query') {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

module.exports = { allRows };
