'use strict';
// F-176/F-177 (AUDIT.md): pseudonimizzazione del nome/id dei lavoratori nei
// dati che Ladia manda a Claude. Ambito deciso esplicitamente con l'utente:
// solo ciò che passa per l'infrastruttura tool/IA (tool_result, storico
// riletto, testo generato dall'IA) — MAI il testo che l'utente scrive di suo
// pugno, che resta con il nome reale (tentare di rilevare nomi in linguaggio
// libero scritto da un umano è fragile e darebbe un falso senso di sicurezza).
//
// Il codice (`workers.ai_pseudonym_code`, migrazione 202) è l'unico
// identificativo che Claude vede mai per un lavoratore — sostituisce sia il
// nome sia l'UUID `id`. La mappa nome/id<->codice non lascia mai questo
// processo: vive solo in memoria per la durata di una richiesta.

const CODE_RE      = /^LAV-[0-9A-F]{6}$/i;
const CODE_LEN     = 10; // "LAV-" + 6 caratteri esadecimali
const FULL_CODE_RE = /LAV-[0-9A-F]{6}/gi;
// Qualunque prefisso incompleto del pattern sopra, ancorato a fine stringa —
// usato per non spezzare un codice a metà tra due chunk di streaming.
const PARTIAL_TAIL_RE = /L(?:A(?:V(?:-[0-9A-F]{0,5})?)?)?$/i;

// Sostituzione globale case-insensitive senza costruire una RegExp dinamica
// da `needle` (lint security/detect-non-literal-regexp — `needle` è un
// full_name letto dal DB, non fidato come sorgente di un pattern).
function replaceAllCaseInsensitive(haystack, needle, replacement) {
  if (!needle) return haystack;
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let result = '';
  let pos = 0;
  let idx;
  while ((idx = lowerHay.indexOf(lowerNeedle, pos)) !== -1) {
    result += haystack.slice(pos, idx) + replacement;
    pos = idx + needle.length;
  }
  result += haystack.slice(pos);
  return result;
}

// Carica la mappa nome/id<->codice per un'azienda. Nessuna cache: il volume
// (poche decine/centinaia di lavoratori per azienda, query singola e leggera)
// non giustifica la complessità finché il profiling non lo richiede.
async function getPseudonymMap(supabase, companyId) {
  const { data, error } = await supabase
    .from('workers')
    .select('id, full_name, ai_pseudonym_code')
    .eq('company_id', companyId)
    .not('ai_pseudonym_code', 'is', null)
    .limit(1000);

  if (error) throw error;

  const workers   = data || [];
  const byId      = new Map();
  const byCode    = new Map();
  const byNameKey = new Map();

  for (const w of workers) {
    if (!w.ai_pseudonym_code) continue;
    byId.set(w.id, { full_name: w.full_name, code: w.ai_pseudonym_code });
    byCode.set(w.ai_pseudonym_code.toUpperCase(), { id: w.id, full_name: w.full_name });
    if (w.full_name) byNameKey.set(w.full_name.toLowerCase(), { id: w.id, code: w.ai_pseudonym_code });
  }

  // Nomi più lunghi prima, per evitare che un nome più corto (sottostringa di
  // uno più lungo) venga sostituito per primo lasciando un residuo scorretto.
  const namesLongestFirst = workers
    .filter(w => w.full_name && w.ai_pseudonym_code)
    .sort((a, b) => b.full_name.length - a.full_name.length);

  return { workers, byId, byCode, byNameKey, namesLongestFirst };
}

// Risolve un codice pseudonimo eventualmente passato dal modello come
// worker_id/worker_name (perché è l'unico identificativo che ha visto in un
// tool_result precedente nello stesso turno) nel valore reale, PRIMA che il
// case handler del tool esegua la sua query. Singolo punto di innesto in
// executeTool — non serve toccare i case handler individuali.
function resolvePseudonymInInput(toolInput, map) {
  if (!toolInput || !map) return toolInput;
  const out = { ...toolInput };

  if (typeof out.worker_id === 'string' && CODE_RE.test(out.worker_id.trim())) {
    const hit = map.byCode.get(out.worker_id.trim().toUpperCase());
    if (hit) out.worker_id = hit.id;
  }
  if (typeof out.worker_name === 'string' && CODE_RE.test(out.worker_name.trim())) {
    const hit = map.byCode.get(out.worker_name.trim().toUpperCase());
    if (hit) out.worker_name = hit.full_name;
  }
  return out;
}

// Deep-walk ricorsivo: sostituisce, in qualunque stringa annidata di
// `value` (oggetto/array/stringa), ogni occorrenza esatta di un id lavoratore
// noto o del suo full_name col relativo codice. Copre automaticamente ogni
// tool esistente e futuro, qualunque chiave JSON usi.
// `seenCodes`, se passato (un Set), viene popolato con ogni codice
// effettivamente sostituito — usato per il registro tecnico (F-177), per
// contare quanti lavoratori distinti sono stati coinvolti in un turno senza
// dover ripetere la stessa deep-walk solo per contarli.
function pseudonymizeOutgoing(value, map, seenCodes = null) {
  if (!map || map.workers.length === 0) return value;

  if (typeof value === 'string') {
    // Match esatto sull'UUID (id lavoratore) — sostituzione dell'intera stringa.
    const idHit = map.byId.get(value);
    if (idHit) {
      if (seenCodes) seenCodes.add(idHit.code);
      return idHit.code;
    }

    // Sostituzione per sottostringa dei nomi noti, più lunghi prima.
    let out = value;
    for (const w of map.namesLongestFirst) {
      if (out.toLowerCase().includes(w.full_name.toLowerCase())) {
        out = replaceAllCaseInsensitive(out, w.full_name, w.ai_pseudonym_code);
        if (seenCodes) seenCodes.add(w.ai_pseudonym_code);
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(v => pseudonymizeOutgoing(v, map, seenCodes));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = pseudonymizeOutgoing(v, map, seenCodes);
    return out;
  }
  return value;
}

// Sostituzione codice->nome reale su testo completo (non streaming) — usata
// dal loop non-stream, dove il testo finale arriva già intero.
function depseudonymizeText(text, map) {
  if (typeof text !== 'string' || !map || map.byCode.size === 0) return text;
  return text.replace(FULL_CODE_RE, (match) => {
    const hit = map.byCode.get(match.toUpperCase());
    return hit ? hit.full_name : match;
  });
}

// Versione "sicura per lo streaming" di depseudonymizeText: un codice come
// LAV-4471AB può arrivare spezzato tra due chunk SSE consecutivi. Trattiene
// sempre l'eventuale suffisso che potrebbe essere l'inizio di un codice
// incompleto, e lo rilascia solo quando può escluderlo (o quando si completa).
function createStreamingDepseudonymizer(map) {
  let buffer = '';

  return {
    // Riceve un nuovo delta di testo dal modello, restituisce la porzione
    // sicura da inviare subito all'utente (già depseudonimizzata).
    push(delta) {
      buffer += delta;
      buffer = depseudonymizeText(buffer, map);

      const partial = buffer.match(PARTIAL_TAIL_RE);
      const cut = partial ? buffer.length - partial[0].length : buffer.length;

      const safe = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return safe;
    },
    // Da chiamare a fine stream: restituisce l'eventuale coda rimasta in buffer.
    flush() {
      const rest = depseudonymizeText(buffer, map);
      buffer = '';
      return rest;
    },
  };
}

// Registra nel registro tecnico (F-177) che la pseudonimizzazione è stata
// applicata a un turno di chat che ha coinvolto lavoratori. Fire-and-forget,
// non deve mai bloccare/rompere la risposta a Ladia — stesso principio di
// logUsage() in lib/ladiaUsageLog.js.
function logPseudonymization(supabase, { companyId, conversationId, model, workersInvolved }) {
  if (!workersInvolved || workersInvolved <= 0) return;
  supabase.from('ladia_ai_pseudonym_log').insert({
    company_id:       companyId,
    conversation_id:  conversationId || null,
    model,
    workers_involved: workersInvolved,
  }).then(({ error }) => {
    if (error) console.warn('[pseudonymLog] scrittura fallita (non bloccante):', error.message);
  });
}

module.exports = {
  CODE_RE,
  CODE_LEN,
  getPseudonymMap,
  resolvePseudonymInInput,
  pseudonymizeOutgoing,
  depseudonymizeText,
  createStreamingDepseudonymizer,
  logPseudonymization,
};
