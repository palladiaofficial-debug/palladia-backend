'use strict';
/**
 * lib/psc/lavorazioni.js — F-270. Dalle schede lavorazione (lib/lavorazioniSchede)
 * alle lavorazioni del PSC: rischi valutati P×D, misure con la loro fonte
 * (le frasi del coordinatore prima di quelle proposte da Palladia), DPI,
 * apprestamenti. E dal computo metrico alle lavorazioni, con durata e
 * uomini-giorno stimati e un primo cronoprogramma.
 *
 * Funzioni pure: nessun I/O.
 */
const crypto = require('crypto');
const { getScheda, rischiValutati, DPI, PSC_PAROLE, SCHEDE } = require('../lavorazioniSchede');

const rid = () => crypto.randomBytes(6).toString('hex');

// Ordine tipico delle fasi in un cantiere, per il primo cronoprogramma.
const ORDINE_CATEGORIE = ['allestimento', 'demolizioni', 'scavi', 'strutture', 'sollevamenti', 'quota', 'elettrico', 'impianti', 'caldo_chimico', 'altri', 'finiture', 'esterni'];
// Categorie che di solito procedono insieme alla fase precedente (impianti con finiture).
const PARALLELE = new Set(['elettrico', 'impianti']);

// Stima uomini-giorno: incidenza della manodopera e costo di una giornata.
// Valori prudenziali, sempre modificabili e dichiarati come stima.
const INCIDENZA_MDO = 0.35;
const COSTO_GIORNATA = 256; // 8 h × 32 €/h
const ADDETTI_DEFAULT = 3;

/** Misure della scheda, con quelle della libreria del coordinatore davanti. */
function misureFor(schedaId, library = []) {
  const mie = library
    .filter(l => l.kind === 'misura' && l.scheda_id === schedaId)
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, 12)
    .map(l => ({ id: rid(), testo: l.testo, fonte: 'mia', fonte_nome: l.source_name || 'la tua libreria', library_id: l.id, approvata: false }));
  const s = getScheda(schedaId);
  const seen = new Set(mie.map(m => m.testo.toLowerCase().slice(0, 60)));
  const proposte = (s ? s.misure : [])
    .filter(t => !seen.has(t.toLowerCase().slice(0, 60)))
    .map(t => ({ id: rid(), testo: t, fonte: 'palladia', approvata: false }));
  return [...mie, ...proposte];
}

/** Bozza di una lavorazione del PSC a partire da una scheda. */
function fromScheda(schedaId, { library = [], nome } = {}) {
  const s = getScheda(schedaId);
  if (!s) return null;
  return {
    nome: nome || s.nome,
    descrizione: s.descrizione,
    scheda_id: s.id,
    fasi: [...s.fasi],
    rischi: rischiValutati(s).map(r => ({ id: rid(), testo: r.rischio, p: r.p, d: r.d, r: r.r, livello: r.livello, fonte: 'palladia' })),
    misure: misureFor(s.id, library),
    dpi: s.dpi.map(k => (DPI[k] ? `${DPI[k].nome} (${DPI[k].norma})` : k)),
    apprestamenti: s.attrezzature.map(([nome, verifica]) => ({ nome, verifica })),
  };
}

/** Una lavorazione libera (senza scheda), tutta da compilare. */
function libera(nome) {
  return { nome, descrizione: '', scheda_id: null, fasi: [], rischi: [], misure: [], dpi: [], apprestamenti: [] };
}

// PSC_PAROLE copre le lavorazioni più comuni; aggiungiamo i nomi delle schede.
const PAROLE = [
  // PSC_PAROLE è una costante del codice (lib/lavorazioniSchede.js), non input utente
  // eslint-disable-next-line security/detect-non-literal-regexp
  ...PSC_PAROLE.map(p => ({ re: new RegExp(p.parole, 'i'), scheda: p.schede[0] })),
  { re: /ponteggi.*montag|montag.*ponteg|nolo.*ponteg|ponteggio/i, scheda: 'ponteggio-montaggio' },
  { re: /trabattell/i, scheda: 'trabattello' },
  { re: /piattaform|\bple\b/i, scheda: 'ple' },
  { re: /cappott/i, scheda: 'cappotto' },
  { re: /gas\b|metano/i, scheda: 'impianto-gas' },
  { re: /asfalt|bitum/i, scheda: 'asfalto-caldo' },
  { re: /verde|alber|giardin|prato/i, scheda: 'opere-verde' },
  { re: /pavimentaz.*estern|autobloccant|marciapied/i, scheda: 'pavimentazioni-esterne' },
  { re: /ringhier|cancell|carpenteria metall|inferriat/i, scheda: 'opere-metalliche-posa' },
  { re: /macerie|trasporto a discarica|smaltiment/i, scheda: 'macerie' },
];

function schedaPerTesto(t) {
  const s = String(t || '');
  // La regola del ponteggio va prima di "struttur" ecc.
  if (/ponteggi/i.test(s)) return 'ponteggio-montaggio';
  for (const p of PAROLE) if (p.re.test(s)) return p.scheda;
  return null;
}

function addWorkdays(iso, n) {
  let ms = Date.parse(`${iso}T12:00:00Z`);
  let left = Math.max(0, Math.round(n));
  // il primo giorno conta: n giorni lavorativi a partire da iso
  const isWork = (m) => { const d = new Date(m).getUTCDay(); return d !== 0 && d !== 6; };
  while (!isWork(ms)) ms += 86400000;
  while (left > 1) { ms += 86400000; if (isWork(ms)) left--; }
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Dal computo (voci già lette) alle lavorazioni del PSC.
 * @param {Array} voci {descrizione, categoria, importo, unita_misura, quantita, codice}
 * @param {{start?:string, library?:Array}} opts
 */
function fromComputo(voci, { start = null, library = [] } = {}) {
  const groups = new Map();
  for (const v of voci) {
    if (!v || !v.descrizione) continue;
    const sid = schedaPerTesto(`${v.descrizione} ${v.categoria || ''}`);
    const key = sid || `cat:${(v.categoria || 'Altre lavorazioni').trim()}`;
    if (!groups.has(key)) groups.set(key, { scheda_id: sid, nomeCat: v.categoria || 'Altre lavorazioni', voci: [], importo: 0 });
    const g = groups.get(key);
    g.voci.push({ codice: v.codice || null, descrizione: String(v.descrizione).slice(0, 300), um: v.unita_misura || null, quantita: v.quantita ?? null, importo: v.importo ?? null });
    g.importo += Number(v.importo) || 0;
  }
  if (![...groups.values()].some(g => g.scheda_id === 'allestimento-cantiere')) {
    groups.set('allestimento-cantiere', { scheda_id: 'allestimento-cantiere', voci: [], importo: 0, aggiunta: true });
  }

  const out = [];
  for (const g of groups.values()) {
    const base = g.scheda_id ? fromScheda(g.scheda_id, { library }) : libera(g.nomeCat);
    const ug = g.importo > 0 ? Math.max(1, Math.round((g.importo * INCIDENZA_MDO / COSTO_GIORNATA) * 2) / 2) : (g.aggiunta ? 5 : 6);
    const addetti = ADDETTI_DEFAULT;
    out.push({
      ...base,
      voci_computo: g.voci,
      uomini_giorno: ug,
      addetti,
      giorni: Math.max(1, Math.ceil(ug / addetti)),
      importo: Math.round(g.importo * 100) / 100,
      categoria: g.scheda_id ? (getScheda(g.scheda_id) || {}).categoria : 'altri',
    });
  }
  out.sort((a, b) => ORDINE_CATEGORIE.indexOf(a.categoria) - ORDINE_CATEGORIE.indexOf(b.categoria));
  if (start) schedule(out, start);
  return out;
}

/**
 * Primo cronoprogramma: una fase dopo l'altra; impianti in parallelo alla
 * fase precedente (come succede davvero, e il coordinatore vede subito
 * l'interferenza da decidere).
 */
function schedule(list, start) {
  let cursor = start;
  let prevStart = start;
  for (const l of list) {
    const giorni = l.giorni || Math.max(1, Math.ceil((l.uomini_giorno || 3) / (l.addetti || ADDETTI_DEFAULT)));
    const s = PARALLELE.has(l.categoria) ? prevStart : cursor;
    l.start_date = addWorkdays(s, 1);
    l.end_date = addWorkdays(l.start_date, giorni);
    prevStart = l.start_date;
    const next = addWorkdays(l.end_date, 2);
    if (next > cursor) cursor = next;
  }
  return list;
}

/** Le schede che il coordinatore può scegliere quando aggiunge una lavorazione. */
function catalogo() {
  return SCHEDE.map(s => ({ id: s.id, nome: s.nome, categoria: s.categoria, pericolosita: s.pericolosita }));
}

module.exports = { fromScheda, libera, misureFor, fromComputo, schedule, schedaPerTesto, addWorkdays, catalogo, INCIDENZA_MDO, COSTO_GIORNATA, rid };
