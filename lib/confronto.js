'use strict';
/**
 * lib/confronto.js — F-423 (AUDIT.md del frontend): la fattura torna con le bolle?
 * (schermata 5 del disegno «Palladia per il lancio»).
 *
 *  confronta(bolle, fattura) — PURO: materiale per materiale, quanto è arrivato
 *     (somma delle righe delle bolle) e quanto c'è in fattura. Le descrizioni
 *     non sono mai scritte uguali («Cemento 32.5R sacchi 25 kg» in bolla,
 *     «Cemento Portland 32,5 R» in fattura): si abbinano per parole simili e
 *     stessa unità (t e q diventano kg). Le righe senza quantità (trasporto,
 *     contributi, IVA) non sono materiali e non si confrontano.
 *       · in_piu      in fattura più di quanto arrivato → «Ti fanno pagare 5 sacchi di cemento in più», con gli euro
 *       · non_arrivato in fattura un materiale che nelle bolle non c'è
 *       · in_meno     in fattura meno di quanto arrivato (non è un problema: si dice e basta)
 *       · torna
 *  abbina(companyId, fattura) — le bolle della fattura: quelle che cita (numero
 *     del DDT), altrimenti quelle dello stesso fornitore non ancora abbinate dei
 *     60 giorni prima. Mai una bolla già abbinata a un'altra fattura.
 *  messaggio(f) — il testo per «Chiedi a <fornitore>», lo manda il titolare.
 * Provato da scripts/selftest_confronto.js.
 */
const supabase = require('./supabase');
const { normName } = require('./fuzzyMatch');
const { scoreDitta } = require('./documentiLeggi');

// ── Unità: stesse cose scritte in modi diversi; t e q in kg ──────────────────
const UNITA = [
  [/^(sacch?[io]?|sac|sc|sacchi|bags?)$/, 'sacchi', 1],
  [/^(kg|kgs|chil[io]|chilogramm[io])$/, 'kg', 1],
  [/^(t|ton|tonn|tonnellat[ae])$/, 'kg', 1000],
  [/^(q|ql|qli|quintal[ie])$/, 'kg', 100],
  [/^(mc|m3|m³|metri ?cubi|metro ?cubo)$/, 'mc', 1],
  [/^(mq|m2|m²|metri ?quadri|metro ?quadro)$/, 'mq', 1],
  [/^(m|ml|mt|metri|metro|metri ?lineari)$/, 'm', 1],
  [/^(pz|pezz[io]|n|nr|num|cad|un|unit[aà]?)$/, 'pz', 1],
  [/^(l|lt|litr[io])$/, 'l', 1],
  [/^(pallet|bancal[ie]|plt)$/, 'pallet', 1],
];
function unita(u) {
  const t = String(u || '').toLowerCase().replace(/\./g, '').trim();
  if (!t) return { u: null, k: 1 };
  for (const [re, nome, k] of UNITA) if (re.test(t)) return { u: nome, k };
  return { u: t, k: 1 };
}
const NOME_UNITA = { sacchi: ['sacco', 'sacchi'], kg: ['kg', 'kg'], mc: ['metro cubo', 'metri cubi'], mq: ['metro quadro', 'metri quadri'], m: ['metro', 'metri'], pz: ['pezzo', 'pezzi'], l: ['litro', 'litri'], pallet: ['pallet', 'pallet'] };

// ── Parole che contano in una descrizione ────────────────────────────────────
const VUOTE = new Set(['di', 'da', 'del', 'della', 'per', 'con', 'il', 'la', 'lo', 'in', 'tipo', 'sacchi', 'sacco', 'kg', 'mc', 'pz', 'nr', 'cad', 'diametro', 'diam', 'mm', 'cm', 'fornitura', 'materiale', 'art', 'cod', 'codice', 'e']);
function parole(s) {
  return normName(String(s || '').replace(/(\d),(\d)/g, '$1.$2').replace(/\bd\.?\s?(\d)/gi, '$1'))
    .split(' ').map(w => w.replace(/[^a-z0-9.]/g, '')).filter(w => w && !VUOTE.has(w) && (w.length >= 3 || /\d/.test(w)));
}
/** Quanto somigliano due descrizioni (0–1): parole in comune sul totale della più corta; i numeri devono coincidere. */
function somiglia(a, b) {
  const pa = parole(a), pb = parole(b);
  if (!pa.length || !pb.length) return 0;
  const na = pa.filter(w => /^\d/.test(w)), nb = pb.filter(w => /^\d/.test(w));
  // «Ferro d.12» e «Ferro d.16» sono due cose diverse
  if (na.length && nb.length && !na.some(n => nb.includes(n))) return 0;
  const sb = new Set(pb.map(w => w.slice(0, 5)));
  const comuni = pa.filter(w => sb.has(w.slice(0, 5))).length;
  return comuni / Math.min(pa.length, pb.length);
}
const nomeMateriale = (descr) => (parole(descr).find(w => !/\d/.test(w)) || String(descr || 'materiale').split(' ')[0]).toLowerCase();
const tondo = (n) => Math.round(n * 1000) / 1000;
const euro = (n) => Math.round(n * 100) / 100;

/**
 * PURO. bolle: [{ id, numero, righe:[{descrizione, quantita, unita}] }]
 *       fattura: { righe:[{descrizione, quantita, unita, prezzo, importo}] }
 * → { esito, righe:[{descrizione, unita, arrivati, fatturati, differenza, prezzo, euro, stato}], inPiuEuro, frase, tornano }
 */
function confronta(bolle, fattura) {
  if (!bolle.length) return { esito: 'senza_bolle', righe: [], inPiuEuro: 0, frase: 'Non trovo bolle di questa fattura', tornano: [] };
  // Arrivati: le righe delle bolle, sommate per materiale simile e stessa unità
  const arrivati = [];
  for (const b of bolle) for (const r of b.righe || []) {
    if (r.quantita == null) continue;
    const un = unita(r.unita);
    const g = arrivati.find(x => x.u === un.u && somiglia(x.descrizione, r.descrizione) >= 0.6);
    if (g) g.q += r.quantita * un.k; else arrivati.push({ descrizione: r.descrizione, u: un.u, q: r.quantita * un.k, usata: false });
  }
  const righe = [];
  for (const r of fattura.righe || []) {
    if (r.quantita == null || !r.descrizione) continue;  // trasporto, contributi, IVA: non sono materiali
    const un = unita(r.unita);
    const q = r.quantita * un.k;
    const prezzo = r.prezzo != null ? r.prezzo / un.k : r.importo != null && r.quantita ? r.importo / q : null;
    const cand = arrivati.filter(a => (a.u === un.u || !a.u || !un.u)).map(a => ({ a, s: somiglia(a.descrizione, r.descrizione) })).filter(x => x.s >= 0.5).sort((x, y) => y.s - x.s)[0];
    if (!cand) { righe.push({ descrizione: r.descrizione, materiale: nomeMateriale(r.descrizione), unita: un.u, arrivati: 0, fatturati: tondo(q), differenza: tondo(q), prezzo, euro: prezzo != null ? euro(q * prezzo) : null, stato: 'non_arrivato' }); continue; }
    cand.a.usata = true;
    const d = tondo(q - cand.a.q);
    const tol = Math.max(0.001, cand.a.q * 0.005);
    const stato = d > tol ? 'in_piu' : d < -tol ? 'in_meno' : 'torna';
    // il nome è quello della bolla: è quello che il titolare ha visto arrivare in cantiere
    righe.push({ descrizione: r.descrizione, materiale: nomeMateriale(cand.a.descrizione), unita: un.u || cand.a.u, arrivati: tondo(cand.a.q), fatturati: tondo(q), differenza: d, prezzo, euro: stato === 'in_piu' && prezzo != null ? euro(d * prezzo) : null, stato });
    cand.a.q = Math.max(0, cand.a.q - q);  // la stessa merce non si conta due volte
  }
  const problemi = righe.filter(r => r.stato === 'in_piu' || r.stato === 'non_arrivato');
  const inPiuEuro = euro(problemi.reduce((t, r) => t + (r.euro || 0), 0));
  const tornano = righe.filter(r => r.stato === 'torna' || r.stato === 'in_meno').map(r => r.materiale);
  let frase;
  if (!righe.length) frase = 'In fattura non ci sono materiali da confrontare';
  else if (!problemi.length) frase = 'Torna tutto con le bolle';
  else {
    const p = [...problemi].sort((a, b) => (b.euro || 0) - (a.euro || 0))[0];
    const n = (p.unita && NOME_UNITA[p.unita]) ? NOME_UNITA[p.unita][Math.abs(p.differenza) === 1 ? 0 : 1] : (p.unita || '');
    frase = p.stato === 'in_piu'
      ? `Ti fanno pagare ${String(p.differenza).replace('.', ',')} ${n} di ${p.materiale} in più`
      : `In fattura c'è ${p.descrizione.toLowerCase()}, che nelle bolle non c'è`;
    if (problemi.length > 1) frase += ` (e ${problemi.length - 1 === 1 ? "un'altra cosa" : `altre ${problemi.length - 1} cose`})`;
  }
  return { esito: problemi.length ? 'non_torna' : 'torna', righe, inPiuEuro, frase, tornano };
}

const cifre = (s) => String(s || '').replace(/\D/g, '');
const giorni = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** PURO: tra le bolle candidate, quelle di questa fattura. */
function scegliBolle(candidate, f) {
  const libere = candidate.filter(b => !b.fattura_id);
  const citate = (f.bolle_citate || []).map(cifre).filter(Boolean);
  if (citate.length) {
    const per = libere.filter(b => b.numero && citate.includes(cifre(b.numero)));
    if (per.length) return per;
  }
  const stessoFornitore = (b) => (f.piva && b.fornitore_piva ? cifre(b.fornitore_piva) === cifre(f.piva) : !!(f.fornitore && b.fornitore && scoreDitta(f.fornitore, b.fornitore) >= 70));
  const dal = f.data ? giorni(f.data, -60) : null, al = f.data ? giorni(f.data, 3) : null;
  return libere.filter(b => stessoFornitore(b) && (!dal || !b.data || (b.data >= dal && b.data <= al)));
}

/** Le bolle della fattura (DB) + quelle ancora da salvare nello stesso caricamento (`extra`). */
async function abbina(companyId, f, extra = []) {
  const { data, error } = await supabase.from('bolle').select('id, site_id, fornitore, fornitore_piva, numero, data, righe, fattura_id, sites(name)')
    .eq('company_id', companyId).is('fattura_id', null).order('data', { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  const db = (data || []).map(b => ({ ...b, data: b.data ? String(b.data).slice(0, 10) : null, cantiere: b.sites?.name || null }));
  return scegliBolle([...db, ...extra], f);
}

/** Il testo per «Chiedi a <fornitore>»: lo manda il titolare, su WhatsApp o per email. */
function messaggio({ azienda, fornitore, numero, data, confronto, bolle }) {
  const problemi = (confronto.righe || []).filter(r => r.stato === 'in_piu' || r.stato === 'non_arrivato');
  const q = (n, u) => `${String(n).replace('.', ',')}${u ? ` ${u}` : ''}`;
  const righe = problemi.map(r => (r.stato === 'in_piu'
    ? `- ${r.descrizione}: in fattura ${q(r.fatturati, r.unita)}, con le bolle ne sono arrivati ${q(r.arrivati, r.unita)}`
    : `- ${r.descrizione}: in fattura ${q(r.fatturati, r.unita)}, ma non è in nessuna bolla`));
  const nb = bolle.map(b => b.numero).filter(Boolean);
  const quando = data ? ` del ${new Date(`${data}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}` : '';
  return `Buongiorno${fornitore ? ` ${fornitore}` : ''}, sono di ${azienda || 'nostra impresa'}. Nella fattura${numero ? ` n. ${numero}` : ''}${quando} ci sono cose che non tornano con le bolle${nb.length ? ` (n. ${nb.join(', ')})` : ''}:\n${righe.join('\n')}\nPotete controllare e mandarci una nota di credito o la fattura corretta? Grazie.`;
}

module.exports = { confronta, scegliBolle, abbina, messaggio, somiglia, unita, nomeMateriale };
