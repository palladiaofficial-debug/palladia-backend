'use strict';
// ── Codice fiscale: carattere di controllo e corrispondenza col nome ─────────
// F-337: la tessera sanitaria letta da una foto. L'IA può sbagliare una
// lettera; il carattere di controllo (16°) lo scopre, e cognome/nome devono
// produrre le prime 6 lettere del codice. Funzioni pure.

const DISPARI = {
  0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};
const pari = (c) => (/\d/.test(c) ? Number(c) : c.charCodeAt(0) - 65);

function normalizza(cf) {
  return String(cf || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Forma e carattere di controllo (omocodie comprese: le cifre sostituite da lettere contano come scritte). */
function codiceFiscaleValido(cf) {
  const c = normalizza(cf);
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(c)) return false;
  let somma = 0;
  for (let i = 0; i < 15; i++) somma += i % 2 === 0 ? DISPARI[c[i]] : pari(c[i]);
  return String.fromCharCode(65 + (somma % 26)) === c[15];
}

function lettere(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
}
const consonanti = (s) => s.replace(/[AEIOU]/g, '');
const vocali = (s) => s.replace(/[^AEIOU]/g, '');

function codiceCognome(cognome) {
  const s = lettere(cognome);
  return (consonanti(s) + vocali(s) + 'XXX').slice(0, 3);
}

function codiceNome(nome) {
  const s = lettere(nome);
  const cons = consonanti(s);
  if (cons.length >= 4) return cons[0] + cons[2] + cons[3];
  return (cons + vocali(s) + 'XXX').slice(0, 3);
}

/** Le prime 6 lettere del codice corrispondono a cognome e nome? */
function corrispondeAlNome(cf, cognome, nome) {
  const c = normalizza(cf);
  return c.slice(0, 3) === codiceCognome(cognome) && c.slice(3, 6) === codiceNome(nome);
}

module.exports = { codiceFiscaleValido, corrispondeAlNome, codiceCognome, codiceNome, normalizza };
