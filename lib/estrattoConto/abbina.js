'use strict';
/**
 * lib/estrattoConto/abbina.js — F-513 (AUDIT.md del frontend, 18/11/2026).
 *
 * Dai movimenti in uscita dell'estratto conto alle fatture di Da pagare che
 * risultano pagate davvero (puro, nessun accesso al database).
 *
 *  - «sicuro»: stesso importo (al centesimo) E il nome del fornitore nella
 *    descrizione del bonifico. Anche un bonifico unico per più fatture dello
 *    stesso fornitore (Stelli: 600 + 1.500 = 2.100 €).
 *  - «da confermare»: stesso importo, una sola fattura possibile, ma il nome
 *    non si legge nella descrizione.
 * Mai abbinato da solo: il titolare conferma (una fattura vale soldi veri).
 * Un movimento abbina al massimo una volta, una fattura al massimo una volta.
 */
const { normNome } = require('../daPagare');

const PAROLE_VUOTE = new Set(['di', 'del', 'della', 'e', 'and', 'co', 'srl', 'spa', 'snc', 'sas', 'italia', 'impianti', 'servizi', 'edile', 'edilizia', 'costruzioni']);
const GIORNO = 86400000;
const centesimi = (n) => Math.round(Math.abs(Number(n) || 0) * 100);

/** Le parole del fornitore che si cercano nella descrizione del bonifico (puro). */
function paroleFornitore(nome) {
  return normNome(nome).split(' ').filter(w => w.length >= 3 && !PAROLE_VUOTE.has(w));
}
function nomeNelTesto(nome, testo) {
  const parole = paroleFornitore(nome);
  if (!parole.length) return false;
  const t = ` ${normNome(testo)} `;
  return parole.some(w => t.includes(` ${w} `));
}

/** Le combinazioni di 2..4 fatture dello stesso fornitore che fanno quell'importo. */
function combinazioni(fatture, cent, max = 4) {
  const out = [];
  const rec = (start, scelte, somma) => {
    if (somma === cent && scelte.length >= 2) { out.push([...scelte]); return; }
    if (somma >= cent || scelte.length === max) return;
    for (let i = start; i < fatture.length; i++) { scelte.push(fatture[i]); rec(i + 1, scelte, somma + centesimi(fatture[i].importo)); scelte.pop(); }
  };
  rec(0, [], 0);
  return out;
}

/**
 * movimenti: [{ id?, data, importo, descrizione }]
 * fatture:   [{ id, fornitore, importo, data }] (non ancora pagate davvero)
 * → [{ movimento, fatture: [...], tipo: 'sicuro' | 'da_confermare' }]
 */
function abbina(movimenti, fatture) {
  const usate = new Set();
  const risultati = [];
  const uscite = movimenti.filter(m => m.importo < 0).sort((a, b) => a.data.localeCompare(b.data));
  const libere = () => fatture.filter(f => !usate.has(f.id));
  // il bonifico non può essere più vecchio della fattura (10 giorni di margine: date d'emissione e di registrazione)
  const possibile = (f, m) => !f.data || Date.parse(`${m.data}T12:00:00Z`) >= Date.parse(`${String(f.data).slice(0, 10)}T12:00:00Z`) - 10 * GIORNO;

  for (const m of uscite) {
    const cent = centesimi(m.importo);
    const stessi = libere().filter(f => centesimi(f.importo) === cent && possibile(f, m));
    const conNome = stessi.filter(f => nomeNelTesto(f.fornitore, m.descrizione));
    if (conNome.length >= 1) {
      // due fatture uguali dello stesso fornitore: si prende la più vecchia
      const f = conNome.sort((a, b) => String(a.data).localeCompare(String(b.data)))[0];
      usate.add(f.id); risultati.push({ movimento: m, fatture: [f], tipo: 'sicuro' });
      continue;
    }
    // un bonifico per più fatture dello stesso fornitore, con il nome nella descrizione
    const perFornitore = new Map();
    for (const f of libere().filter(x => possibile(x, m) && nomeNelTesto(x.fornitore, m.descrizione))) {
      const k = normNome(f.fornitore);
      if (!perFornitore.has(k)) perFornitore.set(k, []);
      perFornitore.get(k).push(f);
    }
    let fatto = false;
    for (const gruppo of perFornitore.values()) {
      const combo = combinazioni(gruppo.slice(0, 12), cent);
      if (combo.length === 1) { combo[0].forEach(f => usate.add(f.id)); risultati.push({ movimento: m, fatture: combo[0], tipo: 'sicuro' }); fatto = true; break; }
    }
    if (fatto) continue;
    if (stessi.length === 1) { usate.add(stessi[0].id); risultati.push({ movimento: m, fatture: stessi, tipo: 'da_confermare' }); }
  }
  return risultati;
}

module.exports = { abbina, paroleFornitore, nomeNelTesto, combinazioni };
