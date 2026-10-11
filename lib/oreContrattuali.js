'use strict';
// ── Ore contate dall'orario di lavoro (F-335, AUDIT.md del frontend) ─────────
// Le buste paga si fanno sull'orario di lavoro, non sui minuti timbrati.
// Regole decise dal titolare (11/10/2026), valide per ogni impresa con il suo
// orario (azienda → cantiere → lavoratore):
//   - si conta dall'inizio dell'orario: chi timbra prima è segnato
//     (entratoPrima) ma quei minuti non contano, mai come straordinario;
//   - chi arriva dopo si conta dall'ora vera: è un ritardo (entro la
//     tolleranza è in orario); chi entra dalla pausa in poi fa mezza giornata;
//   - la pausa non è pagata: se è timbrata contano le timbrature, altrimenti
//     si toglie la finestra dell'orario;
//   - lo straordinario è il tempo lavorato dopo la fine, solo da `straordSoglia`
//     minuti e a blocchi di `straordBlocco` (per difetto); il sabato, la
//     domenica e i festivi è tutto straordinario.
// Funzione pura: legge coppie entrata/uscita già fatte, non tocca timbrature.

const ORARIO_PREDEFINITO = Object.freeze({
  inizio: 480, fine: 1020, pausaDa: 720, pausaA: 780,
  tolleranza: 5, straordSoglia: 30, straordBlocco: 30, fonte: 'predefinito',
});
const PAUSA_TIMBRATA_MIN = 15; // un'uscita e un rientro a distanza di almeno 15 min = pausa timbrata

const toMin = (t) => {
  if (t == null || t === '') return null;
  const [h, m] = String(t).split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Math.max(0, Math.round(Number(v))));

/** Ore da contratto di un giorno lavorativo (minuti). */
function oreGiornoContratto(o) {
  return Math.max(0, o.fine - o.inizio - Math.max(0, Math.min(o.pausaA, o.fine) - Math.max(o.pausaDa, o.inizio)));
}

function daRiga(row) {
  if (!row) return null;
  const inizio = toMin(row.orario_inizio), fine = toMin(row.orario_fine);
  if (inizio == null || fine == null || fine <= inizio) return null;
  return { inizio, fine, pausaDa: toMin(row.pausa_inizio), pausaA: toMin(row.pausa_fine) };
}

/**
 * Orario che vale per un giorno: quello del lavoratore (orario personale),
 * altrimenti del cantiere, altrimenti dell'azienda, altrimenti 8–17.
 * La pausa, se il livello che vince non la dice, viene dal livello sotto.
 */
function risolviOrario({ company = {}, site = null, worker = null } = {}) {
  const az = daRiga(company);
  const livelli = [['lavoratore', daRiga(worker)], ['cantiere', daRiga(site)], ['azienda', az]];
  const [fonte, scelto] = livelli.find(([, v]) => v) || ['predefinito', null];
  const base = scelto || ORARIO_PREDEFINITO;
  const pausa = [daRiga(worker), daRiga(site), az].find(v => v && v.pausaDa != null && v.pausaA != null && v.pausaA > v.pausaDa);
  return {
    inizio: base.inizio,
    fine: base.fine,
    pausaDa: (scelto && scelto.pausaDa != null && scelto.pausaA > scelto.pausaDa) ? scelto.pausaDa : pausa ? pausa.pausaDa : ORARIO_PREDEFINITO.pausaDa,
    pausaA: (scelto && scelto.pausaDa != null && scelto.pausaA > scelto.pausaDa) ? scelto.pausaA : pausa ? pausa.pausaA : ORARIO_PREDEFINITO.pausaA,
    tolleranza: num(company && company.orario_tolleranza_min, ORARIO_PREDEFINITO.tolleranza),
    straordSoglia: num(company && company.straord_soglia_min, ORARIO_PREDEFINITO.straordSoglia),
    straordBlocco: Math.max(1, num(company && company.straord_blocco_min, ORARIO_PREDEFINITO.straordBlocco)),
    fonte,
  };
}

const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
const blocchi = (min, soglia, blocco) => (min >= soglia && min > 0 ? Math.floor(min / blocco) * blocco : 0);

/**
 * Conta un giorno.
 * @param {object} p
 * @param {Array<{in:number,out:number,siteId?:string,motivo?:string|null,motivoEntrata?:string|null}>} p.coppie  minuti dalla mezzanotte (ora di Roma), in ordine
 * @param {object} p.orario       da risolviOrario()
 * @param {boolean} p.lavorativo  false = sabato, domenica, festivo
 * @param {boolean} [p.pausaSaltata]  "niente pausa oggi" confermato dal titolare
 */
function contaGiorno({ coppie = [], orario = ORARIO_PREDEFINITO, lavorativo = true, pausaSaltata = false }) {
  const o = orario;
  const contratto = oreGiornoContratto(o);
  const out = {
    ordinarie: 0, straordinario: 0, ritardo: 0, uscitoPrima: 0, entratoPrima: 0, oltreOrario: 0,
    mezzaGiornata: false, pausaTimbrata: false, festivo: !lavorativo, motivo: null, motivoEntrata: null,
    mancanti: 0, perCantiere: {}, primaEntrata: null, ultimaUscita: null,
  };
  const cs = coppie.filter(c => Number.isFinite(c.in) && Number.isFinite(c.out) && c.out > c.in).sort((a, b) => a.in - b.in);
  if (!cs.length) { out.mancanti = lavorativo ? contratto : 0; return out; }

  const first = cs[0].in, last = cs[cs.length - 1].out;
  out.primaEntrata = fmt(first);
  out.ultimaUscita = fmt(last);
  // Il motivo vale anche se non è l'ultima uscita (uscito per la pioggia e rientrato)
  out.motivo = cs[cs.length - 1].motivo || [...cs].reverse().find(c => c.motivo)?.motivo || null;
  out.motivoEntrata = cs[0].motivoEntrata || null;
  out.pausaTimbrata = cs.some((c, i) => i > 0 && c.in - cs[i - 1].out >= PAUSA_TIMBRATA_MIN);
  const add = (site, min) => { if (min > 0) out.perCantiere[site || '—'] = (out.perCantiere[site || '—'] || 0) + min; };

  if (!lavorativo) {
    // Sabato, domenica, festivo: tutto il tempo lavorato è straordinario
    let lavorato = 0;
    for (const c of cs) {
      const pausa = out.pausaTimbrata || pausaSaltata ? 0 : overlap(c.in, c.out, o.pausaDa, o.pausaA);
      lavorato += c.out - c.in - pausa;
    }
    out.straordinario = Math.floor(lavorato / o.straordBlocco) * o.straordBlocco;
    // ripartito sui cantieri in proporzione al tempo
    let resto = out.straordinario;
    cs.forEach((c, i) => {
      const quota = i === cs.length - 1 ? resto : Math.min(resto, Math.floor(((c.out - c.in) / Math.max(1, lavorato)) * out.straordinario));
      add(c.siteId, quota); resto -= quota;
    });
    return out;
  }

  // Tolleranza: chi entra entro N minuti dall'inizio, o esce entro N minuti
  // dalla fine, è in orario.
  const inizioEff = first > o.inizio && first <= o.inizio + o.tolleranza ? o.inizio : null;
  const fineEff = last < o.fine && last >= o.fine - o.tolleranza ? o.fine : null;

  out.entratoPrima = Math.max(0, o.inizio - first);
  out.mezzaGiornata = first >= o.pausaDa;
  out.ritardo = !out.mezzaGiornata && first > o.inizio + o.tolleranza ? first - o.inizio : 0;

  // Ordinarie: tempo dentro l'orario, meno la pausa (se non timbrata)
  const perCoppia = cs.map((c, i) => {
    const a = i === 0 && inizioEff != null ? inizioEff : c.in;
    const b = i === cs.length - 1 && fineEff != null ? fineEff : c.out;
    let min = overlap(a, b, o.inizio, o.fine);
    if (!out.pausaTimbrata && !pausaSaltata) min -= overlap(Math.max(a, o.inizio), Math.min(b, o.fine), o.pausaDa, o.pausaA);
    return Math.max(0, min);
  });
  let ordinarie = perCoppia.reduce((s, x) => s + x, 0);
  // Mai più delle ore da contratto. L'eccesso dentro l'orario è una pausa
  // timbrata più corta (non pagata in più) oppure, se il titolare ha
  // confermato "pausa saltata", la pausa lavorata: quella è straordinario.
  const eccesso = Math.max(0, ordinarie - contratto);
  // Pausa saltata e uscita prima per questo ("Ho saltato la pausa", F-319):
  // giornata completa, non straordinario. Rimasto fino alla fine: la pausa
  // lavorata è straordinario.
  const restatoFinoAllaFine = last >= o.fine - o.tolleranza;
  const pausaLavorata = pausaSaltata && !out.pausaTimbrata && restatoFinoAllaFine ? eccesso : 0;
  ordinarie -= eccesso;
  let daTogliere = eccesso;
  for (let i = perCoppia.length - 1; i >= 0 && daTogliere > 0; i--) { const t = Math.min(perCoppia[i], daTogliere); perCoppia[i] -= t; daTogliere -= t; }
  out.ordinarie = ordinarie;
  cs.forEach((c, i) => add(c.siteId, perCoppia[i]));

  // Dopo la fine dell'orario
  const dopo = cs.reduce((s, c) => s + overlap(c.in, c.out, o.fine, 24 * 60), 0);
  out.oltreOrario = dopo;
  const straordDopo = blocchi(dopo, o.straordSoglia, o.straordBlocco);
  const straordPausa = pausaLavorata ? Math.floor(pausaLavorata / o.straordBlocco) * o.straordBlocco : 0;
  out.straordinario = straordDopo + straordPausa;
  if (straordDopo) add(cs[cs.length - 1].siteId, straordDopo);
  if (straordPausa) add(cs[0].siteId, straordPausa);

  // Uscita anticipata solo se mancano ore: chi ha già le ore del contratto
  // (pausa saltata o più corta) non è uscito prima.
  out.uscitoPrima = !out.motivo && last < o.fine - o.tolleranza && out.ordinarie < contratto ? o.fine - last : 0;
  out.mancanti = Math.max(0, contratto - out.ordinarie);
  return out;
}

module.exports = { contaGiorno, risolviOrario, oreGiornoContratto, ORARIO_PREDEFINITO, toMin, fmt };
