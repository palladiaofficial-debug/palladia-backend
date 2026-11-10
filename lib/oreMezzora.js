'use strict';
// ── F-484: ore alla mezz'ora per il foglio della commercialista ─────────────
// La commercialista accetta al massimo la mezz'ora: niente 145,79. Il foglio
// (PDF ed Excel) arrotonda OGNI GIORNO alla mezz'ora più vicina (7 h 44 → 7,5;
// 7 h 45 → 8) e i totali sono la somma dei giorni arrotondati, quindi anche
// loro a mezz'ora e uguali tra PDF ed Excel.
//
// Un giorno con lavoro e permesso/pioggia/malattia non cambia la sua somma
// arrotondata: 5 h 45 + 2 h 15 di pioggia fa 6 + 2, non 6 + 2,5. Le ore per
// cantiere dello stesso giorno sommano sempre alle ore del giorno.
//
// Si lavora su una copia. F-484 riaperto (10/11 sera): lo usa anche buildOreMese,
// quindi la tabella ore in Palladia è a mezz'ora come il foglio; il conteggio al
// minuto resta con buildOreMese(…, { esatto: true }).

const MEZZORA = 30;
const r30 = (min) => Math.round((min || 0) / MEZZORA) * MEZZORA;

// F-484 riaperto: anche le ore che mancano (pannello del giorno «Mancano 5 h 30»), così la somma resta la giornata
const PARTI = ['ore', 'permessoMin', 'maltempoMin', 'malattiaMin', 'infortunioMin', 'mancantiMin'];

/** Arrotonda le parti in modo che la loro somma sia la somma arrotondata. */
function arrotondaParti(valori) {
  const totale = r30(valori.reduce((s, v) => s + (v || 0), 0));
  const out = valori.map(r30);
  let diff = totale - out.reduce((s, v) => s + v, 0);
  // la differenza (±30) va sulla parte più lontana dal suo arrotondamento
  while (diff !== 0) {
    const passo = diff > 0 ? MEZZORA : -MEZZORA;
    let best = -1, bestScarto = -Infinity;
    valori.forEach((v, i) => {
      if (!v || out[i] + passo < 0) return;
      const scarto = passo > 0 ? v - out[i] : out[i] - v;
      if (scarto > bestScarto) { bestScarto = scarto; best = i; }
    });
    if (best < 0) break;
    out[best] += passo;
    diff -= passo;
  }
  return out;
}

function arrotondaCella(c) {
  const n = { ...c };
  const parti = arrotondaParti(PARTI.map(k => c[k] || 0));
  PARTI.forEach((k, i) => { if (k in c || parti[i]) n[k] = parti[i]; });
  n.straord = r30(c.straord);
  if (c.aggiunteMin) n.aggiunteMin = r30(c.aggiunteMin);
  if (c.aggiunte) n.aggiunte = c.aggiunte.map(a => ({ ...a, minuti: r30(a.minuti) }));
  // ore per cantiere: stesse proporzioni, somma = ore + straordinario del giorno
  const siti = Object.keys(c.perCantiere || {});
  if (siti.length) {
    const vals = arrotondaParti(siti.map(s => c.perCantiere[s] || 0));
    const atteso = (n.ore || 0) + (n.straord || 0);
    const somma = vals.reduce((s, v) => s + v, 0);
    if (somma !== atteso) {
      const iMax = vals.indexOf(Math.max(...vals));
      vals[iMax] = Math.max(0, vals[iMax] + atteso - somma);
    }
    n.perCantiere = Object.fromEntries(siti.map((s, i) => [s, vals[i]]));
  }
  return n;
}

/** Copia del mese con ogni giorno e ogni totale di ore alla mezz'ora. */
function arrotondaMese(data) {
  const lavoratori = data.lavoratori.map((l) => {
    const cells = l.cells.map(arrotondaCella);
    const somma = (k, f = () => true) => cells.reduce((s, c) => s + (f(c) ? (c[k] || 0) : 0), 0);
    const perCantiere = {};
    for (const c of cells) if (c.tipo === 'lavoro') for (const [s, v] of Object.entries(c.perCantiere || {})) perCantiere[s] = (perCantiere[s] || 0) + v;
    const tot = {
      ...l.tot,
      ordinarieMin: somma('ore'),
      straordMin: somma('straord'),
      straordFestivoMin: somma('straord', c => !!c.festivo),
      permessoMin: somma('permessoMin'),
      maltempoMin: somma('maltempoMin'),
      malattiaMin: somma('malattiaMin'),
      infortunioMin: somma('infortunioMin'),
      perCantiere,
      // un giorno di pochi minuti (es. 10:30–10:34) arrotondato a 0 non è un giorno lavorato:
      // lo stesso conto della formula «Giorni lavorati» dell'Excel
      giorniLavorati: cells.filter(c => c.tipo === 'lavoro' && ((c.ore || 0) > 0 || (c.straord || 0) > 0)).length,
    };
    if (l.tot && 'aggiunteMin' in l.tot) tot.aggiunteMin = somma('aggiunteMin');
    return { ...l, cells, tot };
  });
  return { ...data, lavoratori, arrotondatoMezzora: true };
}

module.exports = { arrotondaMese, arrotondaCella, arrotondaParti, r30 };
