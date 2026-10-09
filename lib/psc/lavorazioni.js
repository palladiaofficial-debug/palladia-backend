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
const { getScheda, rischiValutati, DPI, SCHEDE } = require('../lavorazioniSchede');

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

// ── Da una voce di computo alla scheda (F-287) ───────────────────────────────
// Prima si fermava alla prima parola chiave trovata in un punto qualsiasi del
// testo, anche dentro un'altra parola ("progetto" → getto → casseforme;
// "idrolavaggio … superfici intonacate" → casseforme; "smaltimento delle acque"
// → macerie). Ora ogni regola dà un punteggio: conta molto di più se compare nel
// titolo della voce (la prima frase: "Idrolavaggio.", "Frontalino.", "Pluviali e
// grondaia."), poco nel resto della descrizione, un po' nella categoria del
// computo. Le parole si cercano a inizio parola (\b), mai a metà.
// `tutte`: regole che valgono solo se compaiono insieme (rimozione + guaina);
// una regex o un elenco di regex che devono esserci tutte.
const R = (re, scheda, peso = 1, tutte = null) => ({ re, scheda, peso, tutte });
const REGOLE = [
  R(/\bponteggi|\bimpalcatur|\btubo[- ]giunto|\btubi innocenti/i, 'ponteggio-montaggio', 1.5),
  R(/\btrabattell/i, 'trabattello'),
  R(/\bpiattaform[ae] (aere|elevabil)|\bple\b|\bcestell/i, 'ple'),
  R(/\bimpianto di cantiere|\brecinzion|\bbaraccament|\ballestiment|\bcantierizzazion|\bapprestamenti di cantiere/i, 'allestimento-cantiere', 1.2),
  R(/\bidrolavagg|\bidropulit|\bidrosabbiat|\blavaggio (a pressione|delle (facciat|superfic))|\bpulizia (delle|della) (facciat|superfic)/i, 'idrolavaggio-facciate', 1.6),
  R(/\bspicconatur|\bscrostatur/i, 'spicconatura-intonaci', 1.6),
  R(/\b(rimozion|demoli|smontag|asportazion)/i, 'spicconatura-intonaci', 1.7, /\bintonac|\brivestiment[io] di facciat/i),
  R(/\b(rimozion|demoli|asportazion|smontag)/i, 'rimozione-guaine-copertura', 1.8, /\bimpermeabilizz|\bguain|\bmembran/i),
  // pavimenti: di balconi e terrazzi solo se il testo lo dice, altrimenti interni
  R(/\b(rimozion|demoli|asportazion|smontag)/i, 'rimozione-pavimenti-esterni', 1.6, [/\bpavimen|\bpiastrell|\bmattonell|\bbattiscop/i, /\bbalcon|\bterrazz|\blastric|\bstrato impermeab|\bcopertura piana|\bestern/i]),
  R(/\b(rimozion|demoli|asportazion|smontag)/i, 'demolizioni-interne', 1.5, /\bpavimen|\bpiastrell|\bmattonell|\btramezz|\bcontrosoff|\bdivisori|\bsanitari/i),
  R(/\bfrontalin|\bcornicion|\bcalcestruzzo (degradat|ammalorat)|\bferri d.armatura|\bpassivant|\bantiruggine|\b(ripristino|risanamento) (del |dei )?(calcestruzz|cls|c\.a\.)/i, 'risanamento-calcestruzzo', 1.4),
  R(/\bcanne fumari|\bcanna fumari|\bcomignol|\bcamin|\blattoneri|\bgronda|\bgrondai|\bpluvial|\bscossalin|\bconvers[ae]\b|\bmessican[io]|\bbocchetton/i, 'lattonerie-canne-fumarie', 1.3),
  R(/\bscav[io]|\bsbancament|\bsterr/i, 'scavo-sbancamento'),
  R(/\btrince/i, 'scavo-trincea', 1.2),
  R(/\bcasser[io]|\bcasseform|\bgett[oi]\b|\bcalcestruzz|\bcemento armato|\bc\.a\.(?!\w)|\bpilastr|\bfondazion|\bplate[ae]\b|\bplint/i, 'casseforme-armature', 0.9),
  R(/\bsolai|\bsolaio|\bpredall|\blateroceme/i, 'solai-posa'),
  R(/\bmuratur|\btramezz|\blaterizi|\btamponament|\bmattoni\b|\bblocchi in/i, 'murature-movimentazione'),
  R(/\bmassett|\bsottofond|\bvespa|\bpendenz|\bpiano di posa|\bmalta autolivellant/i, 'massetti-sottofondi', 1.4),
  R(/\bintonac|\brasatur|\bstuccatur/i, 'intonaci'),
  R(/\bcappott|\bisolamento termic/i, 'cappotto'),
  R(/\ba fiamma|\brinvenimento|\bcannello|\bsfiammatur/i, 'guaina-fiamma', 1.4),
  R(/\bimpermeabilizz|\bguain|\bmembran|\bbitum/i, 'impermeabilizzazioni-fredde'),
  R(/\belettric/i, 'impianti-elettrici'),
  R(/\bidraulic|\bidric|\bsanitar|\btermoidraul|\briscaldament/i, 'impianti-idraulici'),
  R(/\bgas\b|\bmetano/i, 'impianto-gas'),
  R(/\bpavimen|\brivestiment|\bpiastrell/i, 'pavimenti-rivestimenti'),
  R(/\bcartongess|\bcontrosoff/i, 'cartongesso'),
  R(/\bcopertur|\btetto\b|\bmanto di copertura|\btegol|\bcoppi\b|\bardesia/i, 'coperture-lavori'),
  R(/\bserrament|\binfiss|\bfinestr/i, 'serramenti'),
  R(/\btinteggi|\bpittur|\bverniciat|\bidropittur/i, 'tinteggiature'),
  R(/\bamianto|\beternit|\bfibrocemento/i, 'amianto-compatto', 1.2),
  R(/\bfotovolt/i, 'fotovoltaico'),
  R(/\bascensor/i, 'ascensore-vano'),
  R(/\bringhier|\bcancell|\binferriat|\bgrat[ae]\b|\bcarpenteria metall/i, 'opere-metalliche-posa'),
  R(/\bmacerie|\btrasporto (a|in) discarica|\bconferimento (a|in) discarica|\bmateriali di risulta/i, 'macerie', 0.8),
  R(/\basfalt/i, 'asfalto-caldo'),
  R(/\balber[io]|\bgiardin|\bprato\b|\bsiepi/i, 'opere-verde'),
  R(/\bautobloccant|\bmarciapied|\bpavimentazion[ei] estern/i, 'pavimentazioni-esterne', 1.2),
  // F-299: lavorazioni aggiunte dopo la prima prova di un coordinatore vero
  R(/\blinea vita|\blinee vita|\bancoragg\w* permanent|\bdispositiv[io] di ancoraggio/i, 'linee-vita-permanenti', 1.4),
  R(/\brinterr|\breinterr|\briempiment|\bcompattazion|\brullatur/i, 'rinterri-compattazione', 1.1),
  R(/\bfognatur|\bacquedott|\bpozzett|\bcamerett|\bcaditoi|\btubazion[ei] in (pvc|pead|gres|ghisa)/i, 'fognature-tubazioni', 1.2),
  R(/\bferro (tondo|d.armatura|per c)|\bbarre d.armatura|\bb450|\brete elettrosaldata|\barmatur[ae] metallic/i, 'ferro-lavorazione', 1.2),
  R(/\blegno lamellare|\bx-?lam\b|\b(travi|travetti|capriat\w*|tavolato|orditura)\b[^.]{0,30}\blegno/i, 'strutture-legno', 1.3),
  R(/\bfrp\b|\bfrcm\b|\bcfrp\b|\bfibr[ae] di (carbonio|vetro|basalto)|\bplaccagg/i, 'rinforzi-frp', 1.5),
  R(/\bcuci[- ]scuci|\biniezion|\bintonaco armato|\bconsolidament\w* (della|delle|di) muratur/i, 'consolidamento-murature', 1.3),
  R(/\bamianto friabile|\bfriabil/i, 'amianto-friabile', 1.6),
  R(/\bmontacarich|\bargan[io]\b|\bpiazzol[ae] di carico/i, 'montacarichi-argani', 1.1),
  R(/\bfacciat[ae] ventilat|\brivestiment[io] (di|in) (facciat|pietra|lastre|gres)|\blastre di rivestimento/i, 'rivestimenti-facciata', 1.3),
  R(/\bsabbiatur|\bidrosabbiat/i, 'sabbiatura', 1.7),
  R(/\bporte interne|\bport[ae] (in legno|tamburat)|\bcontrotelai|\bfalegnam/i, 'porte-falegnameria', 1.2),
  R(/\blevigatur|\blucidatur|\bparquet/i, 'levigatura-pavimenti', 1.2),
  R(/\bclimatizz|\bcondizionat|\bventilazione meccanica|\bcanalizzazion|\bunit[aà] estern|\bpompa di calore/i, 'impianti-climatizzazione', 1.2),
  R(/\bantincendio|\bsprinkler|\bidranti\b|\brivelazione (fumi|incendi)|\bporte tagliafuoco/i, 'impianti-antincendio', 1.2),
  R(/\bcolonn[ae] di scarico|\bbraghe\b|\bcollettor[ei] (di scarico|fognari)/i, 'colonne-scarico', 1.3),
  R(/\bvideosorveglian|\bcitofon|\bantintrusion|\bimpianto (dati|tv)\b|\bfibra ottica|\bcablaggio strutturato/i, 'impianti-speciali', 1.2),
  R(/\bcordol[io]\b|\bmurett[io] di recinzion|\brecinzion[ei] (definitiv|metallic|perimetral)|\bcancellat/i, 'recinzioni-muretti', 1.5),
  // ultima: rimozioni generiche, vincono solo se nient'altro è più preciso
  R(/\bdemoli|\brimozion|\bsmontag/i, 'demolizioni-interne', 0.6),
];

/** Titolo della voce: la prima frase, senza "In alternativa:" / "Eventuale". */
function titoloVoce(desc) {
  const s = String(desc || '').replace(/^\s*(in alternativa|eventual[ei]|variante)\s*[:,]?\s*/i, '');
  const m = s.match(/^(.{3,140}?)[.:;](\s|$)/);
  return (m ? m[1] : s.slice(0, 140)).trim();
}

/**
 * La scheda più adatta a una voce di computo, o null.
 * @param {string} descrizione
 * @param {string|null} categoria la categoria/capitolo del computo
 */
function classifica(descrizione, categoria = null) {
  const desc = String(descrizione || '');
  const titolo = titoloVoce(desc);
  const resto = desc.slice(titolo.length);
  const cat = String(categoria || '');
  const punti = new Map();
  REGOLE.forEach((r, i) => {
    const ok = (t) => r.re.test(t) && (!r.tutte || [].concat(r.tutte).every(x => x.test(t)));
    let p = 0;
    if (ok(titolo)) p += 3 * r.peso;
    else if (ok(desc)) p += 1 * r.peso;
    if (!r.tutte && r.re.test(resto) && p >= 3) p += 0.2; // ripetuta anche nel testo
    if (cat && ok(cat)) p += 1.5 * r.peso;
    if (p > 0) punti.set(r.scheda, Math.max(punti.get(r.scheda) || 0, p - i * 1e-4));
  });
  let best = null, max = 0;
  for (const [k, v] of punti) if (v > max) { best = k; max = v; }
  return best;
}

// Compatibilità: chi passava "descrizione + categoria" in un'unica stringa.
const schedaPerTesto = (t) => classifica(t, null);

const AMIANTO = /\bamianto|\beternit|\bfibrocemento|\bcemento[- ]amianto/i;

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
function fromComputo(voci, { start = null, end = null, library = [] } = {}) {
  const groups = new Map();
  for (const v of voci) {
    if (!v || !v.descrizione) continue;
    const sid = classifica(v.descrizione, v.categoria);
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
  // F-287: una voce che cita l'amianto (es. "eventuale bonifica amianto" nella
  // sostituzione delle canne fumarie) non diventa per questo una rimozione di
  // amianto, ma il segnale non si perde: rischio e misura da verificare.
  for (const l of out) {
    if (l.scheda_id === 'amianto-compatto') continue;
    const citano = l.voci_computo.filter(v => AMIANTO.test(v.descrizione));
    if (!citano.length) continue;
    const rif = citano.map(v => v.codice).filter(Boolean).slice(0, 4).join(', ');
    l.rischi = [...l.rischi, { id: rid(), testo: `Possibile presenza di amianto, citata nel computo${rif ? ` (voce ${rif})` : ''}`, p: 2, d: 4, r: 8, livello: 'Alto', fonte: 'palladia' }];
    l.misure = [...l.misure, { id: rid(), testo: 'Prima dei lavori, verifica della presenza di amianto; se c\'è, rimozione solo da impresa iscritta all\'Albo gestori ambientali (cat. 10) con piano di lavoro presentato all\'ASL (art. 256)', fonte: 'palladia', approvata: false }];
  }
  out.sort((a, b) => ORDINE_CATEGORIE.indexOf(a.categoria) - ORDINE_CATEGORIE.indexOf(b.categoria));
  if (start) {
    schedule(out, start);
    // F-286: con una fine lavori dichiarata il cronoprogramma ci deve stare dentro.
    if (end && end > start) adattaAllaDurata(out, start, end);
  }
  return out;
}

const DAY_MS = 86400000;
const ms = (iso) => Date.parse(`${iso}T12:00:00Z`);
const iso = (m) => new Date(m).toISOString().slice(0, 10);
function giorniLavorativi(s, e) {
  let n = 0;
  for (let m = ms(s); m <= ms(e); m += DAY_MS) { const d = new Date(m).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return Math.max(1, n);
}

/**
 * F-286. Riporta le lavorazioni dentro inizio–fine lavori comprimendo il
 * cronoprogramma in proporzione: l'ordine e le sovrapposizioni restano, le
 * durate si accorciano, gli addetti si ricalcolano dagli uomini-giorno.
 * Se tutto è già dentro, non tocca niente.
 * @param {Array<{start_date,end_date,uomini_giorno?,addetti?}>} list (modificata e restituita)
 */
function adattaAllaDurata(list, start, end) {
  const dated = list.filter(l => l.start_date && l.end_date);
  if (!dated.length || !start || !end || end < start) return list;
  const first = dated.reduce((m, l) => (l.start_date < m ? l.start_date : m), start);
  const last = dated.reduce((m, l) => (l.end_date > m ? l.end_date : m), dated[0].end_date);
  if (first >= start && last <= end) return list;
  const span = ms(end) - ms(start);
  const used = Math.max(DAY_MS, ms(last) - ms(first));
  const f = span / used;
  for (const l of dated) {
    let s = ms(start) + Math.round(((ms(l.start_date) - ms(first)) * f) / DAY_MS) * DAY_MS;
    let e = ms(start) + Math.round(((ms(l.end_date) - ms(first)) * f) / DAY_MS) * DAY_MS;
    if (e > ms(end)) e = ms(end);
    if (s > e) s = e;
    l.start_date = iso(s);
    l.end_date = iso(e);
    const ug = Number(l.uomini_giorno) || 0;
    if (ug > 0) l.addetti = Math.max(1, Math.ceil(ug / giorniLavorativi(l.start_date, l.end_date)));
  }
  return list;
}

/**
 * F-289. Le lavorazioni lette dal computo che hanno la stessa scheda di una già
 * presente nel PSC non diventano un doppione: le loro voci si aggiungono a
 * quella esistente. L'allestimento aggiunto d'ufficio (senza voci) si salta.
 * @returns {{nuove: Array, aggiorna: Array<{id, voci_computo}>}}
 */
function unisciAlleEsistenti(nuove, esistenti = []) {
  const bySch = new Map();
  for (const e of esistenti) if (e.scheda_id && !bySch.has(e.scheda_id)) bySch.set(e.scheda_id, e);
  const out = [], aggiorna = new Map();
  for (const l of nuove) {
    const e = l.scheda_id ? bySch.get(l.scheda_id) : null;
    if (!e) { out.push(l); continue; }
    if (!l.voci_computo.length) continue;
    const cur = aggiorna.get(e.id) || { id: e.id, voci_computo: [...(e.voci_computo || [])], rischi: null, misure: null };
    cur.voci_computo.push(...l.voci_computo);
    // il rischio amianto citato nel computo segue le voci
    const amianto = l.rischi.filter(r => /amianto, citata nel computo/.test(r.testo));
    if (amianto.length) { cur.rischi = [...(cur.rischi || e.rischi || []), ...amianto]; cur.misure = [...(cur.misure || e.misure || []), ...l.misure.filter(m => /amianto/i.test(m.testo))]; }
    aggiorna.set(e.id, cur);
  }
  return { nuove: out, aggiorna: [...aggiorna.values()] };
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
// F-307: "molto concentrato su lavori esterni". I lavori interni c'erano, ma
// sparsi tra finiture, demolizioni e impianti: qui li raccogliamo in un gruppo.
const INTERNI = new Set([
  'demolizioni-interne', 'aperture-muri-portanti', 'taglio-calcestruzzo', 'consolidamento-murature', 'massetti-sottofondi',
  'intonaci', 'cartongesso', 'isolamenti-interni', 'pavimenti-rivestimenti', 'levigatura-pavimenti', 'serramenti',
  'porte-falegnameria', 'tinteggiature', 'impianti-elettrici', 'impianti-speciali', 'impianti-idraulici', 'impianto-gas',
  'impianti-climatizzazione', 'impianti-antincendio', 'colonne-scarico', 'ascensore-vano', 'aperture-vuoti',
  'scale-portatili', 'trabattello', 'resine-solventi', 'amianto-compatto',
]);
function catalogo() {
  // alias: le voci che la scheda comprende (es. "Impianto idrico di cantiere" in Allestimento), per la ricerca
  return SCHEDE.map(s => ({ id: s.id, nome: s.nome, categoria: s.categoria, pericolosita: s.pericolosita, interno: INTERNI.has(s.id), alias: (s.sostituisce || []).join(' · ') }));
}

module.exports = { fromScheda, libera, misureFor, fromComputo, schedule, schedaPerTesto, classifica, titoloVoce, adattaAllaDurata, unisciAlleEsistenti, addWorkdays, catalogo, INCIDENZA_MDO, COSTO_GIORNATA, rid };
