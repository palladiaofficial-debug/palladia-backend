'use strict';
/**
 * lib/bustePaga/dividi.js — F-399 (AUDIT.md del frontend): il PDF unico delle
 * buste paga del commercialista, diviso una per operaio.
 *
 * Senza AI: ogni busta riporta il codice fiscale del dipendente, e il codice lo
 * cerca pagina per pagina tra quelli degli operai in Palladia (uguaglianza
 * esatta su 16 caratteri: un abbinamento sbagliato non può succedere). Pagine
 * consecutive della stessa persona = la stessa busta. Le pagine con molti
 * codici fiscali o nessuno (prospetti contabili, riepiloghi «DIPENDENTI (NORM)»)
 * sono dell'azienda, non di un operaio. Un codice fiscale che non è di nessuno
 * dei tuoi operai diventa una busta «da guardare», con il nome che somiglia.
 * Provato sul file vero di MSC (51 pagine: 17 buste, 21 pagine di prospetti e riepiloghi).
 */

const MESI = ['GENNAIO', 'FEBBRAIO', 'MARZO', 'APRILE', 'MAGGIO', 'GIUGNO', 'LUGLIO', 'AGOSTO', 'SETTEMBRE', 'OTTOBRE', 'NOVEMBRE', 'DICEMBRE'];
const CF_RE = /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/g;
const RIEPILOGO_RE = /PROSPETTO|RIEPILOGO|DIPENDENTI\s*\(NORM\)|CO\.?CO\.?CO\.?\s*\(NORM\)/i;
const PERIODO_RE = /(GENNAIO|FEBBRAIO|MARZO|APRILE|MAGGIO|GIUGNO|LUGLIO|AGOSTO|SETTEMBRE|OTTOBRE|NOVEMBRE|DICEMBRE)\s*[/-]?\s*(20\d\d)/gi;

const senzaAccenti = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();

/** Le pagine dal testo di lib/pdfExtract (marcatori «--- Pagina N ---»). */
function paginaPerPagina(testo, numPagine) {
  const out = Array.from({ length: numPagine }, (_, i) => ({ n: i + 1, testo: '' }));
  const parti = String(testo || '').split(/--- Pagina (\d+) ---\n?/).slice(1);
  for (let i = 0; i < parti.length; i += 2) {
    const n = Number(parti[i]);
    if (n >= 1 && n <= numPagine) out[n - 1].testo = parti[i + 1] || '';
  }
  return out;
}

/** Il nome che somiglia: tutte le parole del nome (3+ lettere) stanno nella pagina, e solo per un operaio. */
function somiglia(testo, workers) {
  // Parole intere confrontate come insiemi: niente RegExp costruite con un nome
  const nella = new Set(senzaAccenti(testo).split(/[^A-Z0-9]+/).filter(Boolean));
  const trovati = workers.filter(w => {
    const parole = senzaAccenti(w.nome).split(/[^A-Z0-9]+/).filter(p => p.length >= 3);
    return parole.length >= 2 && parole.every(p => nella.has(p));
  });
  return trovati.length === 1 ? trovati[0] : null;
}

/**
 * pagine: [{ n, testo }]; workers: [{ id, nome, cf, attivo }]
 * → { segmenti: [{ da, a, tipo: 'busta'|'sconosciuta'|'riepilogo', workerId?, nome?, attivo?, cf?, suggerito? }],
 *     periodo: { anno, mese } | null, senzaTesto }
 */
function dividi(pagine, workers) {
  const conCf = workers.filter(w => w.cf && /^[A-Z0-9]{16}$/i.test(w.cf)).map(w => ({ ...w, cf: w.cf.toUpperCase() }));
  const perCf = new Map(conCf.map(w => [w.cf, w]));
  const conTesto = pagine.filter(p => p.testo.trim().length >= 30).length;
  const senzaTesto = pagine.length > 0 && conTesto < pagine.length / 2;

  const classi = [];
  for (const p of pagine) {
    const su = p.testo.toUpperCase();
    const compatto = su.replace(/\s+/g, '');
    const noti = conCf.filter(w => compatto.includes(w.cf));
    const altri = [...new Set(su.match(CF_RE) || [])].filter(cf => !perCf.has(cf));
    const prima = classi[classi.length - 1];
    let c;
    // Prospetti e riepiloghi sono dell'azienda anche se nominano un solo operaio
    // (sul file vero: «PROSPETTO DETTAGLIO FONDI» con il codice fiscale di uno)
    if (RIEPILOGO_RE.test(p.testo)) c = { tipo: 'riepilogo' };
    else if (noti.length === 1) c = { tipo: 'busta', w: noti[0] };
    else if (noti.length > 1) c = { tipo: 'riepilogo' };
    else if (altri.length === 1) c = { tipo: 'sconosciuta', cf: altri[0], suggerito: somiglia(p.testo, workers) };
    // Seconda pagina di una busta senza intestazione ripetuta
    else if (!altri.length && p.testo.trim() && prima && prima.tipo !== 'riepilogo') c = { ...prima };
    else c = { tipo: 'riepilogo' };
    classi.push({ ...c, n: p.n });
  }

  const chiave = (c) => (c.tipo === 'busta' ? `b:${c.w.id}` : c.tipo === 'sconosciuta' ? `s:${c.cf}` : 'r');
  const segmenti = [];
  for (const c of classi) {
    const ultimo = segmenti[segmenti.length - 1];
    if (ultimo && ultimo._k === chiave(c) && ultimo.a === c.n - 1) { ultimo.a = c.n; continue; }
    const s = { _k: chiave(c), da: c.n, a: c.n, tipo: c.tipo };
    if (c.tipo === 'busta') Object.assign(s, { workerId: c.w.id, nome: c.w.nome, attivo: c.w.attivo !== false });
    if (c.tipo === 'sconosciuta') Object.assign(s, { cf: c.cf, suggerito: c.suggerito ? { id: c.suggerito.id, nome: c.suggerito.nome } : null });
    segmenti.push(s);
  }

  // Il mese: quello scritto più spesso sulle buste
  const conta = new Map();
  for (const c of classi) {
    if (c.tipo === 'riepilogo') continue;
    const p = pagine[c.n - 1];
    for (const m of p.testo.matchAll(PERIODO_RE)) {
      const k = `${m[2]}-${MESI.indexOf(m[1].toUpperCase()) + 1}`;
      conta.set(k, (conta.get(k) || 0) + 1);
    }
  }
  const top = [...conta.entries()].sort((a, b) => b[1] - a[1])[0];
  const periodo = top ? { anno: Number(top[0].split('-')[0]), mese: Number(top[0].split('-')[1]) } : null;

  return { segmenti: segmenti.map(({ _k, ...s }) => s), periodo, senzaTesto };
}

module.exports = { dividi, paginaPerPagina, MESI };
