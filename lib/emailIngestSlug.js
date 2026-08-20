'use strict';

/**
 * lib/emailIngestSlug.js
 * Normalizza una ragione sociale italiana nella parte "leggibile" dell'indirizzo
 * email dedicato (fatture-{slug}-{random}@palladia.net). Le ragioni sociali
 * italiane rompono facilmente un local-part email: sigle abbreviate con punti
 * (F.lli, S.r.l.), apostrofi (D'Angelo), accenti (Località, Sant'Antòn),
 * ampersand, spazi multipli. Questa funzione produce SEMPRE un risultato valido
 * per RFC 5321/5322 per costruzione — solo [a-z0-9-], mai un trattino a inizio o
 * fine stringa, mai trattini consecutivi — senza bisogno di validazione a parte.
 */

// Suffissi societari italiani più comuni — rimossi solo se il nome li rende
// riconoscibili come parole a sé (dopo aver tolto i punti "S.r.l." diventa
// "srl", un singolo token, non tre lettere separate). Rimossi sempre quando
// presenti in coda: non aggiungono nulla all'identificazione della company
// nell'indirizzo e occupano spazio prezioso.
const CORPORATE_SUFFIXES = new Set(['srl', 'spa', 'snc', 'sas', 'ss', 'scarl', 'coop', 'sagl']);

const MAX_SLUG_LEN = 24;

function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function slugifyCompanyName(name, maxLen = MAX_SLUG_LEN) {
  if (!name || typeof name !== 'string') return '';

  let s = stripDiacritics(name.toLowerCase());
  // Punti e apostrofi si RIMUOVONO (non diventano separatori): "F.lli" resta
  // "flli", "S.r.l." diventa "srl", "D'Angelo" diventa "dangelo" — un solo
  // token ciascuno, non frammenti di una lettera separati da trattini.
  s = s.replace(/['.]/g, '');
  // Tutto il resto che non è lettera/cifra (&, virgole, altra punteggiatura)
  // diventa uno spazio: separa parole distinte senza introdurre trattini doppi.
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();

  let words = s.split(/\s+/).filter(Boolean);
  // Rimuove i suffissi societari in coda — anche più di uno ("srl unipersonale"
  // non è un caso reale comune, ma la rimozione ripetuta non fa danno).
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }
  if (words.length === 0) return '';

  let slug = words.join('-');
  if (slug.length <= maxLen) return slug;

  // Troppo lungo: toglie parole dalla fine finché non rientra, mai spezza una
  // parola a metà — più leggibile di un troncamento carattere per carattere.
  while (words.length > 1 && words.join('-').length > maxLen) words.pop();
  slug = words.join('-');
  // Anche una sola parola può superare da sola il limite (nomi composti senza
  // spazi, es. un unico lunghissimo termine) — ultima risorsa, troncamento secco.
  return slug.length > maxLen ? slug.slice(0, maxLen).replace(/-+$/, '') : slug;
}

module.exports = { slugifyCompanyName, MAX_SLUG_LEN, CORPORATE_SUFFIXES };
