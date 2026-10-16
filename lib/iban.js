'use strict';
// F-357 (AUDIT.md del frontend): IBAN del fornitore per Da pagare.
// Controllo ISO 13616 (mod 97): un IBAN letto male dall'IA o scritto con una
// cifra sbagliata non passa, così non finisce mai in un bonifico.
const LUNGHEZZE = { IT: 27, SM: 27, VA: 22, DE: 22, FR: 27, ES: 24, AT: 20, CH: 21, BE: 16, NL: 18, LU: 20, PT: 25, IE: 22, GB: 22, SI: 19, HR: 21, RO: 24, PL: 28, MT: 31, GR: 27 };

/** IBAN normalizzato (maiuscolo, senza spazi) se valido, altrimenti null. */
function ibanValido(v) {
  const s = String(v || '').replace(/[\s.-]+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return null;
  const len = LUNGHEZZE[s.slice(0, 2)];
  if (len && s.length !== len) return null;
  const riordinato = s.slice(4) + s.slice(0, 4);
  let resto = 0;
  for (const ch of riordinato) {
    const n = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of n) resto = (resto * 10 + Number(c)) % 97;
  }
  return resto === 1 ? s : null;
}

/** "IT60X0542811101000000123456" → "IT60 X054 2811 1010 0000 0123 456" */
const ibanLeggibile = (s) => String(s || '').replace(/(.{4})/g, '$1 ').trim();

module.exports = { ibanValido, ibanLeggibile };
