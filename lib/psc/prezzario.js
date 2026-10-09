'use strict';
/**
 * lib/psc/prezzario.js — F-293 (AUDIT.md del frontend). I prezzari regionali
 * per i costi della sicurezza.
 *
 *  - parseLiguriaPdfText: la sezione 95 "Sicurezza" del Prezzario Regione
 *    Liguria (testo estratto dal PDF ufficiale). Nel PDF ogni articolo ha il
 *    codice su una riga ("95.A10.A10.010 … m 7,51 € 100,00 0,44 €") e la
 *    descrizione spezzata sopra e sotto, centrata sul codice: le righe tra due
 *    codici si dividono quindi tra la coda dell'articolo prima (tante righe
 *    quante ne aveva sopra) e la testa di quello dopo. Il titolo del gruppo
 *    ("A10 - Recinzione di cantiere, avente altezza…") precede la descrizione.
 *  - parseListinoRighe: un prezzario in Excel/CSV (righe già lette), con le
 *    colonne riconosciute dall'intestazione (codice, descrizione, U.M., prezzo).
 *
 * Funzioni pure: nessun I/O.
 */

const CODICE_LIG = /^(\d{2}\.[A-Z]\d{2}\.[A-Z]\d{2}\.\d{3})\b\s*(.*)$/;
const COSTO = /^(.*?)\s*(\S+)\s+(\d{1,3}(?:\.\d{3})*,\d{2}) €\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s+(\d{1,3}(?:\.\d{3})*,\d{2}) €\s*$/;
const RUMORE = [/^--- Pagina \d+ ---$/, /^Pagina \d+ di \d+$/, /Prezzario Regione Liguria - Anno/, /^\d{2} \[.*\]$/, /^FINALE$/];
const INTESTAZIONE = /^CODICE DESCRIZIONE/;
const TITOLO = /^\d+(?:\.\d+)+\.\s+([A-Z]\d{2}) - (.*)$/;
const itNum = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
const pulisci = (s) => s.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();

/**
 * @param {string} text testo del PDF (con i separatori "--- Pagina N ---")
 * @param {{sezione?: string}} opts sezione del prezzario (default '95', sicurezza)
 * @returns {Array<{codice, descrizione, um, prezzo, capitolo}>}
 */
function parseLiguriaPdfText(text, { sezione = '95' } = {}) {
  const righe = String(text || '').split(/\r?\n/).map(r => r.trim()).filter(r => r && !RUMORE.some(re => re.test(r)));
  const out = [];
  let titolo = null, inTitolo = false;
  let blocco = []; // righe di testo dopo l'ultimo codice (o dopo il titolo)
  let ultimo = null; // { item, sopra }
  const chiudi = (nuovoSopra) => {
    // nuovoSopra: il prossimo articolo ha almeno una riga sopra il codice.
    // Le righe in `blocco` vanno: le prime `ultimo.sopra` in coda all'ultimo articolo, il resto in testa al prossimo
    let coda = [];
    if (ultimo) {
      const n = Math.min(ultimo.sopra, Math.max(0, blocco.length - (nuovoSopra ? 1 : 0)));
      coda = blocco.slice(0, n);
      ultimo.item.parti.push(...coda);
    }
    const testa = blocco.slice(coda.length);
    blocco = [];
    return testa;
  };
  for (const r of righe) {
    // L'intestazione della tabella chiude il titolo del gruppo (che può andare a capo)
    if (INTESTAZIONE.test(r)) { inTitolo = false; continue; }
    const t = r.match(TITOLO);
    if (t && !CODICE_LIG.test(r)) {
      chiudi(false); ultimo = null;
      titolo = t[2]; inTitolo = true;
      continue;
    }
    const c = r.match(CODICE_LIG);
    if (c && c[1].startsWith(`${sezione}.`)) {
      inTitolo = false;
      const costo = c[2].match(COSTO);
      if (!costo) { blocco.push(r); continue; }
      // se la riga del codice ha già il suo testo, la testa può essere vuota
      const testa = chiudi(!costo[1]);
      const item = { codice: c[1], um: costo[2], prezzo: itNum(costo[3]), capitolo: titolo, parti: [...testa, ...(costo[1] ? [costo[1]] : [])] };
      out.push(item);
      ultimo = { item, sopra: testa.length };
      continue;
    }
    if (inTitolo) { titolo = `${titolo} ${r}`; continue; }
    blocco.push(r);
  }
  chiudi(false);
  return out.map(i => {
    const corpo = pulisci(i.parti.join(' '));
    const cap = pulisci(i.capitolo || '').replace(/[,:]$/, '');
    const descrizione = cap && corpo ? `${cap}: ${corpo}` : cap || corpo;
    return { codice: i.codice, descrizione: descrizione.slice(0, 1200), um: i.um, prezzo: i.prezzo, capitolo: cap.slice(0, 300) || null };
  }).filter(i => i.descrizione && Number.isFinite(i.prezzo));
}

const COL = {
  codice: /^(cod(ice)?|tariffa|articolo|art\.?|voce|n\.? ?art)/i,
  descrizione: /^(descr|denominaz|declaratoria)/i,
  um: /^(u\.? ?m\.?|unit[aà]|um)$/i,
  prezzo: /^(prezzo|importo unit|euro|€|p\.? ?u\.?)/i,
};

/**
 * Prezzario da righe di un foglio (array di array). Cerca l'intestazione nelle
 * prime 30 righe; senza intestazione riconoscibile restituisce [].
 */
function parseListinoRighe(rows) {
  let head = -1, map = null;
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    const m = {};
    (rows[i] || []).forEach((cell, j) => {
      const v = String(cell ?? '').trim();
      for (const [k, re] of Object.entries(COL)) if (m[k] === undefined && re.test(v)) m[k] = j;
    });
    if (m.codice !== undefined && m.descrizione !== undefined && m.prezzo !== undefined) { head = i; map = m; break; }
  }
  if (!map) return [];
  const out = [];
  let cap = null;
  for (const row of rows.slice(head + 1)) {
    const codice = String(row[map.codice] ?? '').trim();
    const desc = pulisci(String(row[map.descrizione] ?? ''));
    const raw = row[map.prezzo];
    const prezzo = typeof raw === 'number' ? raw : itNum(String(raw ?? '').replace(/[€\s]/g, ''));
    if (!desc) continue;
    if (!codice || !Number.isFinite(prezzo) || prezzo <= 0) { if (desc.length < 200) cap = desc; continue; }
    out.push({ codice: codice.slice(0, 60), descrizione: desc.slice(0, 1200), um: map.um !== undefined ? String(row[map.um] ?? '').trim().slice(0, 20) || null : null, prezzo: Math.round(prezzo * 100) / 100, capitolo: cap });
  }
  return out;
}

// ── Prezzari inclusi in Palladia ─────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'prezzari');
const PUBBLICI = fs.existsSync(DIR)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file della cartella fissa del codice
  ? fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
  : [];
const pubblico = (id) => PUBBLICI.find(p => p.id === id) || null;

const PROVINCE_LIGURIA = /\b(genova|savona|la spezia|spezia|imperia|ge|sv|sp|im)\b/i;
/** La regione del cantiere, se si riconosce (per ora: Liguria). */
function regioneDi(project) {
  const p = project || {};
  if (PROVINCE_LIGURIA.test(`${p.provincia || ''}`) || /liguria/i.test(`${p.provincia || ''} ${p.comune || ''} ${p.address || ''}`)) return 'Liguria';
  if (/\b(genova|savona|la spezia|imperia|sanremo|chiavari|rapallo|albenga|sarzana|ventimiglia)\b/i.test(`${p.comune || ''} ${p.address || ''}`)) return 'Liguria';
  if (Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat > 43.75 && p.lat < 44.7 && p.lon > 7.45 && p.lon < 10.1) return 'Liguria';
  return null;
}
/** Il prezzario incluso più recente della regione del cantiere. */
function regionalePer(project) {
  const reg = regioneDi(project);
  return reg ? PUBBLICI.filter(p => p.regione === reg).sort((a, b) => b.anno - a.anno)[0] || null : null;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const VUOTE = new Set(['di', 'del', 'della', 'delle', 'dei', 'e', 'a', 'al', 'in', 'con', 'per', 'su', 'da', 'il', 'la', 'lo', 'le', 'gli', 'i', 'un', 'una', 'compreso', 'compresa']);
const SINONIMI = {
  bagno: ['igienic', 'bagn', ' wc'], wc: ['igienic', ' wc'], chimi: ['chimic'], barac: ['locale', 'box', 'baracc'], box: ['box', 'locale'],
  spogl: ['spogliat'], ponte: ['ponteg', 'impalcat'], impal: ['impalcat', 'ponteg'], traba: ['trabat'], parap: ['parapett'],
  carte: ['cartell', 'segnalet'], segna: ['segnal'], riuni: ['riunion'], estin: ['estint'], recin: ['recinz'], trans: ['transenn', 'delimitaz'],
};
/**
 * Ricerca nelle voci di un prezzario: ogni parola cercata deve comparire (anche
 * come inizio di parola) nella descrizione o nel codice. Ordine: più parole
 * nel titolo del gruppo, poi codice.
 */
function cerca(voci, q, limit = 30) {
  // radice delle parole (ponteggio/ponteggiature, recinzione/recinzioni) e
  // qualche sinonimo del linguaggio di cantiere
  const parole = norm(q).split(/[^a-z0-9.]+/).filter(w => w.length > 1 && !VUOTE.has(w))
    .map(w => (/^\d|\./.test(w) ? [w] : SINONIMI[w.slice(0, 5)] || [w.length > 6 ? w.slice(0, w.length > 8 ? 7 : 6) : w]));
  if (!parole.length) return voci.slice(0, limit);
  const out = [];
  for (const v of voci) {
    const testo = ` ${norm(`${v.codice} ${v.descrizione}`)}`;
    if (!parole.every(alt => alt.some(w => testo.includes(w)))) continue;
    const cap = norm(v.capitolo);
    const punti = parole.reduce((n, alt) => n + (alt.some(w => cap.includes(w)) ? 2 : 0) + (alt.some(w => testo.includes(` ${w}`)) ? 1 : 0), 0);
    out.push({ v, punti });
  }
  return out.sort((a, b) => b.punti - a.punti || a.v.codice.localeCompare(b.v.codice)).slice(0, limit).map(x => x.v);
}

// Voci tipiche di Palladia (lib/psc/catalog.js, VOCI_COSTO) → articoli del
// prezzario ligure, sezione 95. `q` come in VOCI_COSTO ('zero' = da misurare).
// Solo dove l'articolo regionale è davvero la stessa cosa; le altre restano
// con il prezzo indicativo da confermare.
const MAPPA = {
  liguria: {
    recinzione: [{ codice: '95.A10.A10.010', q: 'zero' }, { codice: '95.A10.A10.015', q: 'zero' }],
    baracca: [{ codice: '95.C10.A20.010', q: 'uno' }],
    wc: [{ codice: '95.C10.A10.050', q: 'mesi' }],
    ponteggio: [{ codice: '95.B10.S10.011', q: 'zero' }],
    ponteggio_nolo: [{ codice: '95.B10.S10.016', q: 'zero' }],
    mantovana: [{ codice: '95.B10.S10.030', q: 'zero' }],
    teli: [{ codice: '95.B10.S10.085', q: 'zero' }],
    parapetti: [{ codice: '95.A10.A50.010', q: 'zero' }],
    transenne_interferenze: [{ codice: '95.A10.A15.005', q: 'zero' }],
    cartelli: [{ codice: '95.F10.A10.010', q: 'uno' }, { codice: '95.F10.A10.020', q: 'zero' }],
    moviere: [{ codice: '95.F10.A35.010', q: 'zero' }],
    riunioni: [{ codice: '95.H10.A10.005', q: 'riunioni' }],
    informazione: [{ codice: '95.H10.A15.010', q: 'uno' }],
  },
};
/** Gli articoli regionali per una voce tipica, o null. */
function perVoce(prez, key) {
  if (!prez) return null;
  const m = (MAPPA[String(prez.regione || '').toLowerCase()] || {})[key];
  if (!m) return null;
  const out = m.map(x => ({ ...x, voce: prez.voci.find(v => v.codice === x.codice) })).filter(x => x.voce);
  return out.length === m.length ? out : null;
}

/**
 * F-310: costi presi da un prezzario regionale più vecchio di quello incluso
 * oggi (es. Liguria 2025 → 2026). Stesso codice, prezzo nuovo; le voci che
 * nel prezzario nuovo non ci sono restano come sono.
 */
function aggiornamentiPrezzario(costi, project) {
  const reg = regionalePer(project);
  if (!reg) return { prezzario: null, voci: [] };
  const vecchi = new Set(PUBBLICI.filter(p => p.regione === reg.regione && p.anno < reg.anno).map(p => p.nome));
  const voci = [];
  for (const c of costi || []) {
    if (c.prezzo_fonte !== 'prezzario' || !vecchi.has(c.prezzario_fonte) || !c.codice) continue;
    const v = reg.voci.find(x => x.codice === c.codice);
    if (v) voci.push({ id: c.id, codice: c.codice, da: Number(c.prezzo), a: v.prezzo });
  }
  return { prezzario: reg.nome, voci };
}

module.exports = { aggiornamentiPrezzario, parseLiguriaPdfText, parseListinoRighe, PUBBLICI, pubblico, regioneDi, regionalePer, cerca, perVoce, MAPPA };
