'use strict';

// F-080: quando il loop agentico di Ladia (routes/v1/chat.js, endpoint /chat e
// /chat/stream) esaurisce il tetto di round di tool-use PRIMA che il modello
// emetta un blocco di testo finale, la risposta grezza non contiene alcun
// testo — ma le scritture GIÀ eseguite nei round precedenti sono reali.
// Riprodotto dal vivo il 25/08/2026 (gate di lancio, giorno 3): un lavoratore
// creato con successo, poi il fallback generico "non sono riuscito a
// elaborare la risposta" ha fatto credere il contrario, e Ladia lo ha persino
// negato nel turno successivo. Questa funzione estrae, dai tool_result
// effettivamente eseguiti in quel turno, i riepiloghi delle scritture andate
// a buon fine — così il chiamante può costruire un messaggio onesto invece
// del fallback che nasconde un successo reale.
function extractSuccessfulWriteSummaries(toolResultContents) {
  const summaries = [];
  for (const raw of toolResultContents || []) {
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      continue; // non-JSON: non è un risultato di tool strutturato, ignora
    }
    if (parsed && parsed.success && (parsed.undoSummary || parsed.summary)) {
      summaries.push(parsed.undoSummary || parsed.summary);
    }
  }
  return summaries;
}

module.exports = { extractSuccessfulWriteSummaries };
