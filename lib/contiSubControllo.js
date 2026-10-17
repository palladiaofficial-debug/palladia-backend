'use strict';
// ── Conti dei sub: i controlli (F-360, AUDIT.md del frontend) ────────────────
// Funzioni pure: nessun database, nessuna IA. Dato il foglio letto, gli
// ingressi in cantiere, i prezzi già approvati e le quantità del contratto,
// dicono riga per riga cosa non torna e cosa proporre al tecnico.
//
// Regole decise dal titolare il 17/10: si paga a ore (28 €/h a MSCedilizia),
// una giornata = 8 ore, le mezze giornate contano (4 ore). Niente ritenute.

const ORE_GIORNATA = 8;
const TOLLERANZA_ORE = 0.5;   // fino a mezz'ora di differenza non è un problema
const TOLLERANZA_EURO = 0.01;

const r2 = (n) => Math.round(Number(n) * 100) / 100;
/** Ore arrotondate alla mezz'ora (3h50 → 4, 7h40 → 7,5). */
const mezzaOra = (n) => Math.round(Number(n) * 2) / 2;

// Nomi: "Mohamed B." ~ "BENALI MOHAMED", senza accenti né punteggiatura
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// Voci: "Rasatura pareti" = "RASATURA PARETI (m²)"
const voceChiave = (s) => normNome(String(s || '').replace(/\([^)]*\)/g, ' ')).replace(/\b(mq|m2|m|ml|cad|h|ore)\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * La persona del foglio tra quelle registrate in cantiere.
 * Ogni parola del foglio deve trovare una parola diversa del nome registrato:
 * per intero, o come iniziale ("B." → "Benali"). Almeno una parola intera.
 * Se ne combaciano due o più, nessuna (meglio chiedere che sbagliare persona).
 */
function abbinaPersona(nomeFoglio, persone) {
  const S = normNome(nomeFoglio).split(' ').filter(Boolean);
  if (!S.length || !S.some(t => t.length > 1)) return null;
  const trovate = persone.filter(p => {
    const W = normNome(p.full_name).split(' ').filter(Boolean);
    const usate = new Set();
    for (const s of S) {
      const i = W.findIndex((w, k) => !usate.has(k) && (s.length === 1 ? w.startsWith(s) : w === s));
      if (i < 0) return false;
      usate.add(i);
    }
    return true;
  });
  return trovate.length === 1 ? trovate[0] : null;
}

/**
 * Ore in cantiere per persona e giorno, dalle entrate/uscite (sub_presenze).
 * Un'entrata senza uscita conta fino alla fine dell'orario. Si toglie la pausa.
 * @param {Array<{sub_worker_id, event, giorno:string, min:number}>} presenze  min = minuti dalla mezzanotte, ora di Roma
 * @param {{fine:number, pausaDa:number, pausaA:number}} orario
 * @returns {Map<string, Map<string, {ore:number, stimata:boolean}>>}  persona → giorno → ore
 */
function oreDaPresenze(presenze, orario) {
  const gruppi = new Map();
  for (const p of [...presenze].sort((a, b) => a.giorno.localeCompare(b.giorno) || a.min - b.min)) {
    const k = `${p.sub_worker_id}|${p.giorno}`;
    if (!gruppi.has(k)) gruppi.set(k, []);
    gruppi.get(k).push(p);
  }
  const out = new Map();
  for (const [k, lista] of gruppi) {
    const [wid, giorno] = k.split('|');
    let minuti = 0, dentro = null, stimata = false;
    const somma = (a, b) => {
      if (b <= a) return;
      const pausa = Math.max(0, Math.min(b, orario.pausaA) - Math.max(a, orario.pausaDa));
      minuti += b - a - pausa;
    };
    for (const p of lista) {
      if (p.event === 'entrata') { if (dentro == null) dentro = p.min; }
      else if (dentro != null) { somma(dentro, p.min); dentro = null; }
    }
    if (dentro != null) { somma(dentro, Math.max(dentro, orario.fine)); stimata = true; }
    if (!out.has(wid)) out.set(wid, new Map());
    out.get(wid).set(giorno, { ore: mezzaOra(minuti / 60), stimata });
  }
  return out;
}

/**
 * Il controllo di un conto.
 * @param {object} p
 * @param {Array<{persona, giorno:string|null, ore_foglio:number}>} p.ore
 * @param {Array<{voce, unita, quantita_foglio, prezzo_foglio, importo_scritto}>} p.misura
 * @param {number|null} p.tariffaFoglio   €/h scritta nel foglio
 * @param {number|null} p.tariffaNota     €/h dei conti approvati
 * @param {Map|null} p.ingressi           da oreDaPresenze(); null = nessun ingresso registrato quel mese
 * @param {Array<{id, full_name}>} p.persone  persone registrate dell'impresa
 * @param {Map<string,{prezzo:number|null, contratto:number|null}>} p.prezzi  per voce_chiave
 * @param {Map<string, number>} p.giaApprovato  quantità già approvate nei mesi prima, per voce_chiave
 */
function controlla({ ore = [], misura = [], tariffaFoglio = null, tariffaNota = null, ingressi = null, persone = [], prezzi = new Map(), giaApprovato = new Map() }) {
  const senzaIngressi = ingressi == null;
  const righeOre = ore.map(r => {
    const out = { ...r, ore_foglio: r2(r.ore_foglio), ore_ingressi: null, problema: null, proposta: null };
    if (senzaIngressi) return out;
    const squadra = /^(squadra|tutti|totale)$/i.test(String(r.persona).trim());
    const chi = squadra ? null : abbinaPersona(r.persona, persone);
    let ing;
    if (squadra) {
      ing = 0;
      for (const giorni of ingressi.values()) for (const [g, v] of giorni) if (!r.giorno || g === r.giorno) ing += v.ore;
    } else if (!chi) {
      ing = 0;
    } else {
      const giorni = ingressi.get(chi.id) || new Map();
      ing = r.giorno ? (giorni.get(r.giorno)?.ore || 0) : [...giorni.values()].reduce((s, v) => s + v.ore, 0);
    }
    out.ore_ingressi = r2(ing);
    out.persona_id = chi ? chi.id : null;
    if (ing === 0) { out.problema = 'non_entrato'; out.proposta = 0; }
    else if (out.ore_foglio - ing > TOLLERANZA_ORE) { out.problema = 'ore_diverse'; out.proposta = r2(ing); }
    return out;
  });

  // Tariffa oraria: quella del foglio, confrontata con quella dei mesi approvati
  const haOre = righeOre.length > 0;
  let tariffa = { foglio: tariffaFoglio != null ? r2(tariffaFoglio) : null, nota: tariffaNota != null ? r2(tariffaNota) : null, problema: null, proposta: null };
  if (haOre) {
    if (tariffa.foglio == null && tariffa.nota == null) tariffa.problema = 'prezzo_mancante';
    else if (tariffa.foglio != null && tariffa.nota != null && Math.abs(tariffa.foglio - tariffa.nota) > TOLLERANZA_EURO) { tariffa.problema = 'prezzo_diverso'; tariffa.proposta = tariffa.nota; }
  }

  const righeMisura = misura.map(r => {
    const q = r2(r.quantita_foglio);
    let prezzo = r.prezzo_foglio != null ? r2(r.prezzo_foglio) : (r.importo_scritto != null && q ? r2(r.importo_scritto / q) : null);
    const chiave = voceChiave(r.voce);
    const nota = prezzi.get(chiave) || {};
    const gia = r2(giaApprovato.get(chiave) || 0);
    const out = {
      ...r, voce_chiave: chiave, quantita_foglio: q, prezzo_foglio: prezzo,
      prezzo_noto: nota.prezzo != null ? r2(nota.prezzo) : null,
      contratto: nota.contratto != null ? r2(nota.contratto) : null,
      gia_approvato: gia, problema: null, proposta: null,
      importo_sbagliato: r.importo_scritto != null && prezzo != null && Math.abs(r2(q * prezzo) - r2(r.importo_scritto)) > TOLLERANZA_EURO,
    };
    if (prezzo == null && out.prezzo_noto == null) out.problema = 'prezzo_mancante';
    else if (prezzo == null) out.prezzo_foglio = out.prezzo_noto;
    else if (out.prezzo_noto != null && Math.abs(prezzo - out.prezzo_noto) > TOLLERANZA_EURO) { out.problema = 'prezzo_diverso'; out.proposta = out.prezzo_noto; }
    else if (out.contratto != null && gia + q > out.contratto + 0.001) { out.problema = 'oltre_contratto'; out.proposta = r2(Math.max(0, out.contratto - gia)); }
    return out;
  });

  // La somma che il foglio avrebbe dovuto fare (per dire «somma sbagliata»)
  const sommaFoglio = r2(
    righeOre.reduce((s, r) => s + r.ore_foglio, 0) * (tariffa.foglio ?? tariffa.nota ?? 0)
    + righeMisura.reduce((s, r) => s + (r.importo_scritto != null ? Number(r.importo_scritto) : r.quantita_foglio * (r.prezzo_foglio || 0)), 0),
  );
  return { senzaIngressi, righeOre, righeMisura, tariffa, sommaFoglio };
}

/** Il valore che vale per una riga, data la decisione del tecnico. */
function valoreRiga(r) {
  if (r.tipo === 'ore') {
    if (!r.problema || r.decisione === 'foglio') return r2(r.ore_foglio);
    if (r.decisione === 'proposta') return r2(r.valore ?? r.proposta ?? r.ore_foglio);
    return null;
  }
  // misura: la quantità e il prezzo approvati
  let q = r2(r.quantita_foglio), prezzo = r.prezzo_foglio != null ? r2(r.prezzo_foglio) : null;
  if (r.problema === 'oltre_contratto' && r.decisione === 'proposta') q = r2(r.valore ?? r.proposta);
  if (r.problema === 'prezzo_diverso' && r.decisione === 'proposta') prezzo = r2(r.valore ?? r.proposta);
  if (r.problema === 'prezzo_mancante') prezzo = r.valore != null ? r2(r.valore) : null;
  if (r.problema && !r.decisione && r.problema !== 'prezzo_mancante') return null;
  if (prezzo == null) return null;
  return { quantita: q, prezzo, importo: r2(q * prezzo) };
}

function tariffaApprovata(c) {
  if (c.tariffa_decisione === 'proposta') return c.tariffa != null ? r2(c.tariffa) : null;
  if (c.tariffa_decisione === 'foglio') return c.tariffa_foglio != null ? r2(c.tariffa_foglio) : null;
  return c.tariffa_foglio ?? c.tariffa_nota ?? c.tariffa ?? null;
}

/** Problema della tariffa ancora da decidere? */
function tariffaAperta(c, haOre) {
  if (!haOre) return false;
  const foglio = c.tariffa_foglio != null ? Number(c.tariffa_foglio) : null, nota = c.tariffa_nota != null ? Number(c.tariffa_nota) : null;
  if (foglio == null && nota == null) return c.tariffa == null;
  if (foglio != null && nota != null && Math.abs(foglio - nota) > TOLLERANZA_EURO) return !c.tariffa_decisione;
  return false;
}

/** Totali del conto e quante cose restano da guardare. */
function totali(conto, righe) {
  const ore = righe.filter(r => r.tipo === 'ore');
  const mis = righe.filter(r => r.tipo === 'misura');
  const tariffa = tariffaApprovata(conto);
  let aperte = tariffaAperta(conto, ore.length > 0) ? 1 : 0;
  let oreTot = 0, misTot = 0;
  for (const r of ore) { const v = valoreRiga(r); if (v == null) aperte++; else oreTot += v; }
  for (const r of mis) { const v = valoreRiga(r); if (v == null) aperte++; else misTot += v.importo; }
  oreTot = r2(oreTot);
  const oreImporto = tariffa != null ? r2(oreTot * tariffa) : 0;
  return {
    aperte,
    ore: oreTot,
    giornate: r2(oreTot / ORE_GIORNATA),
    tariffa,
    oreImporto,
    misuraImporto: r2(misTot),
    totale: r2(oreImporto + misTot),
    problemi: ore.filter(r => r.problema).length + mis.filter(r => r.problema).length + (tariffaProblema(conto, ore.length > 0) ? 1 : 0),
  };
}

/** C'è da guardare la tariffa (mancante o diversa dai mesi approvati), decisa o no. */
function tariffaProblema(c, haOre) {
  if (!haOre) return null;
  const foglio = c.tariffa_foglio != null ? Number(c.tariffa_foglio) : null, nota = c.tariffa_nota != null ? Number(c.tariffa_nota) : null;
  if (foglio == null && nota == null) return 'prezzo_mancante';
  if (foglio != null && nota != null && Math.abs(foglio - nota) > TOLLERANZA_EURO) return 'prezzo_diverso';
  return null;
}

/** «41 giornate», «41½ giornate», «1 giornata», «½ giornata». */
function giornateTesto(ore) {
  const g = Number(ore) / ORE_GIORNATA;
  const intere = Math.floor(g + 1e-9), resto = g - intere;
  if (Math.abs(resto - 0.5) < 1e-9) return intere ? `${intere}½ giornate` : '½ giornata';
  if (resto > 1e-9) return `${g.toLocaleString('it-IT', { maximumFractionDigits: 1 })} giornate`;
  return intere === 1 ? '1 giornata' : `${intere} giornate`;
}

/**
 * Le fatture del sub (Da pagare) abbinate ai conti approvati.
 * Prima per importo uguale (entro 1 €), poi in ordine di tempo: la fattura più
 * vecchia va al conto approvato più vecchio ancora senza fattura.
 * @param {Array<{id, mese, totale_approvato, approvato_at}>} conti   approvati di UN'impresa
 * @param {Array<{id, amount, created_at}>} fatture                    della stessa impresa
 * @returns {Map<string, {contoId, mese, approvato, differenza}>}     per id della fattura
 */
function abbinaFatture(conti, fatture) {
  const liberi = [...conti].sort((a, b) => String(a.mese).localeCompare(String(b.mese)));
  const out = new Map();
  const prendi = (f, c) => {
    liberi.splice(liberi.indexOf(c), 1);
    out.set(f.id, { contoId: c.id, mese: c.mese, approvato: r2(c.totale_approvato), differenza: r2(Number(f.amount) - Number(c.totale_approvato)) });
  };
  const ordinate = [...fatture].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const f of ordinate) {
    const c = liberi.find(x => Math.abs(Number(x.totale_approvato) - Number(f.amount)) <= 1);
    if (c) prendi(f, c);
  }
  for (const f of ordinate) {
    if (out.has(f.id)) continue;
    const c = liberi.find(x => !x.approvato_at || String(x.approvato_at) <= String(f.created_at));
    if (c) prendi(f, c);
  }
  return out;
}

module.exports = {
  ORE_GIORNATA, normNome, voceChiave, abbinaPersona, oreDaPresenze, controlla,
  valoreRiga, tariffaApprovata, tariffaAperta, tariffaProblema, totali, giornateTesto, abbinaFatture, mezzaOra,
};
