'use strict';
/**
 * lib/quantoRende.js — F-509 (18/11/2026), conto rifatto con F-514 (19/11/2026).
 * AUDIT.md del frontend.
 *
 * Quanto costa la manodopera di ogni cantiere, senza chiedere a nessuno una
 * tariffa oraria. Tutto viene da dati che Palladia ha già:
 *
 *  1. Il prospetto contabile del commercialista (fra i «Prospetti del
 *     commercialista», buste_caricamenti.riepilogo_path), letto codice per
 *     codice (costoDelMese): retribuzioni lorde N0100 (dentro ci sono già gli
 *     accantonamenti Cassa Edile NA100-104, che stanno in AVERE), oneri ditta
 *     DZTOT, TFR del mese R0006, altri contributi ditta W1004, 13ª/14ª e
 *     ferie/ROL/riposi maturati (crescita delle righe Z dal mese prima).
 *     Malattia INPS, CIG, bonus e rimborsi sono fuori, ciascuno col perché.
 *     L'INAIL non è nel prospetto: si dichiara fuori. L'amministratore
 *     (co.co.co.) ha la sua sezione e il suo costo.
 *     Quadratura verificata su ottobre 2026 di MSC: DARE = NZTOT al centesimo.
 *  2. Ogni busta dà l'imponibile della persona (F.P.L.D. dipendenti, F.A.P.
 *     amministratori): serve a dividere il costo. Chi non si legge prende il
 *     resto, segnato «stimato».
 *  3. Costo orario = costo della persona ÷ ore di contratto del mese intero.
 *  4. Cantiere = ore timbrate lì × costo orario. Il resto non è «il resto»:
 *     è diviso in parti misurate (ufficio per nome, magazzino, ore pagate e
 *     non timbrate in cantiere).
 *
 * È una STIMA finché il commercialista non conferma il conto (F-514): il
 * risultato lo dice sempre (stima: true, verificatoCommercialista: false).
 * Le buste e i prospetti sono paghe: lo vedono solo owner e admin (F-494).
 */
const supabase = require('./supabase');
const { extractPdfText } = require('./pdfExtract');
const { buildOreMese } = require('./oreMese');

const BUCKET = 'site-documents';
// Posti che hanno un QR ma non sono cantieri: le loro ore vanno nelle spese generali
const NON_CANTIERE = /\b(magazzin\w*|deposit\w*|sede|ufficio|officina)\b/i;

const num = (s) => {
  const t = String(s).trim();
  const n = Number(t.replace(/-$/, '').replace(/\./g, '').replace(',', '.'));
  return t.endsWith('-') ? -n : n;
};
const cent = (x) => Math.round(x * 100) / 100;

const RIGA = /^([A-Z0-9]{5}) (.+?) (-?[\d.]+,\d\d-?)(?: (-?[\d.]+,\d\d-?))?\s*$/;

/**
 * Dal testo del prospetto (Centro Paghe): le voci per codice della sezione
 * GENERALE (dipendenti), la sezione dei co.co.co., TFR del mese e imponibile
 * INAIL dal riepilogo. null se non è un prospetto contabile.
 * Ritorna { lorde, oneri, voci: {codice: importo}, cococo, tfrMese, imponibileInail }.
 */
function leggiProspetto(testo) {
  const righe = String(testo || '').split(/\r?\n/).map(r => r.trim());
  if (!righe.some(r => /PROSPETTO CONTABILE/i.test(r))) return null;
  const voci = {}, coll = {};
  let sezione = null, dopoTipo = false, dentro = false;
  let tfrMese = null, imponibileInail = null;
  for (const r of righe) {
    if (/^PROSPETTO CONTABILE/i.test(r)) { dentro = true; continue; }
    if (/^TIPO SUDDIVISIONE PROSPETTO/i.test(r)) { dopoTipo = true; continue; }
    if (dopoTipo) { sezione = r.toUpperCase(); dopoTipo = false; continue; }
    const m = r.match(RIGA);
    if (!m) continue;
    // Il riepilogo prima del prospetto: il primo R0006/R0001 è quello dei dipendenti
    if (!dentro) {
      if (m[1] === 'R0006' && tfrMese == null) tfrMese = num(m[3]);
      if (m[1] === 'R0001' && imponibileInail == null) imponibileInail = num(m[3]);
      continue;
    }
    const dove = sezione === 'GENERALE' ? voci : /^COLLABORATORI/.test(sezione || '') ? coll : null;
    if (dove && dove[m[1]] == null) dove[m[1]] = num(m[3]);
  }
  if (voci.N0100 == null || voci.DZTOT == null) return null;
  return {
    lorde: voci.N0100, oneri: voci.DZTOT, voci,
    cococo: coll.N0103 != null ? { compensi: coll.N0103, oneri: coll.DZTOT || 0 } : null,
    tfrMese, imponibileInail,
  };
}

// Righe Z (accantonamenti dell'anno): 13ª/14ª e ferie/ROL/riposi non goduti, con i contributi
const Z_RATEI = ['Z0104', 'Z0105', 'Z0106', 'Z0107'];
const Z_RESIDUI = ['Z0071', 'Z0073', 'Z0074', 'Z0076', 'Z0077', 'Z0079', 'Z0080', 'Z0082', 'Z0101', 'Z0102', 'Z0103'];
const crescita = (ora, prima, codici) => {
  if (!prima) return null;
  if (!codici.some(k => ora.voci[k] != null)) return null;
  return cent(codici.reduce((s, k) => s + (ora.voci[k] || 0) - (prima.voci[k] || 0), 0));
};

/**
 * Il costo del mese voce per voce (puro). p = prospetto del mese, prima = del
 * mese prima (o null). Ritorna { voci, fuori, inail, totaleDipendenti,
 * amministratori, totale, incompleto }.
 * Le voci con importo null non si possono calcolare e non entrano nel totale.
 */
function costoDelMese(p, prima) {
  const v = p.voci;
  const voci = [
    { chiave: 'lorde', nome: 'Stipendi lordi (dentro c\'è già quello che va alla Cassa Edile per ferie e gratifica degli operai)', importo: v.N0100, fonte: 'N0100' },
    { chiave: 'oneri', nome: 'Contributi pagati dall\'impresa (INPS, Cassa Edile, fondi)', importo: v.DZTOT, fonte: 'DZTOT' },
    { chiave: 'tfr', nome: 'TFR maturato nel mese', importo: p.tfrMese, fonte: 'R0006' },
    { chiave: 'altriContributi', nome: 'Altri contributi a carico dell\'impresa', importo: v.W1004 ?? null, fonte: 'W1004', daConfermare: true },
    { chiave: 'ratei', nome: '13ª e 14ª degli impiegati maturate nel mese, con i contributi', importo: crescita(p, prima, Z_RATEI), fonte: 'Z0104-Z0107', daConfermare: false },
    { chiave: 'residui', nome: 'Ferie, permessi e riposi maturati e non ancora goduti, con i contributi', importo: crescita(p, prima, Z_RESIDUI), fonte: 'Z0071-Z0103', daConfermare: true },
  ];
  // Se nel prospetto non c'è una voce (es. nessun impiegato) vale zero, non «manca»
  for (const x of voci) if (x.importo == null && x.chiave === 'altriContributi') x.importo = 0;
  if (voci[2].importo == null && prima && v.Z0032 != null && prima.voci.Z0032 != null && v.Z0032 >= prima.voci.Z0032) {
    voci[2].importo = cent(v.Z0032 - prima.voci.Z0032); voci[2].fonte = 'Z0032';
  }
  const fuori = [
    ['N0359', 'Indennità di malattia INPS', 'la anticipa l\'impresa ma la recupera dall\'INPS'],
    ['N0310', 'Anticipi di cassa integrazione', 'li anticipa l\'impresa ma li recupera dall\'INPS'],
    ['NC704', 'Bonus L.207/2024', 'lo anticipa l\'impresa ma lo recupera con l\'F24'],
    ['N0127', 'Rimborsi spese e chilometri', 'sono spese rimborsate, non stipendio'],
    ['N0240', 'Anticipi del TFR', 'è TFR già messo da parte negli anni scorsi'],
    ['Z0008', 'Rivalutazione del TFR degli anni passati', 'non è lavoro di questo mese'],
  ].filter(([k]) => v[k]).map(([fonte, nome, perche]) => ({ fonte, nome, importo: v[fonte], perche }));
  if (v.N0420) fuori.push({ fonte: 'N0420', nome: 'Anticipo dell\'impresa per malattia e infortunio', importo: v.N0420, perche: 'non sappiamo se viene recuperato: da chiedere al commercialista', daChiedere: true });

  const totaleDipendenti = cent(voci.reduce((s, x) => s + (x.importo || 0), 0));
  const amministratori = p.cococo ? cent(p.cococo.compensi + p.cococo.oneri) : 0;
  return {
    voci, fuori,
    inail: { compreso: false, imponibile: p.imponibileInail, perche: 'l\'INAIL non è nel prospetto: serve il tasso della vostra posizione' },
    totaleDipendenti, amministratori, totale: cent(totaleDipendenti + amministratori),
    incompleto: voci.some(x => x.importo == null),
  };
}

/**
 * Dal testo di una busta: { imp, tipo } o null. F-512: dipendenti
 * «IMP.LE F.P.L.D.» (anche senza il punto finale, come sulla busta di un
 * apprendista), amministratori in gestione separata «IMP.LE F.A.P.».
 */
function leggiImponibileTipo(testo) {
  const t = String(testo || '').replace(/\s+/g, ' ');
  const m = t.match(/IMP\.LE F\.(P\.L\.D|A\.P)\.?\s+([\d.]+,\d\d)/);
  if (!m) return null;
  // «QUALIFICA INPS 1 OPERAIO(A)», «2 IMPIEGATO/A», «Y IMP P.TIME», «5 APP.OPERAIO», «CO.CO.CO.»
  const q = (t.match(/QUALIFICA INPS (.{0,30}?) TIPO RAPPORTO/) || [])[1] || '';
  const qualifica = /CO\.CO\.CO/i.test(q) ? 'amministratore' : /OPERAI/i.test(q) ? 'operaio' : /\bIMP/i.test(q) ? 'impiegato' : null;
  return { imp: num(m[2]), tipo: m[1] === 'A.P' ? 'FAP' : 'FPLD', qualifica };
}
function leggiImponibile(testo) { return leggiImponibileTipo(testo)?.imp ?? null; }

/**
 * Divide il costo fra le persone.
 * costo = costo dei dipendenti; cococo = { compensi, oneri } degli amministratori.
 * imponibili: { workerId: { imp, tipo } | numero | null }.
 * Dipendenti: in proporzione all'imponibile; se tutti si leggono, la somma
 * torna esattamente al costo. Chi non si legge prende il resto, «stimato».
 * Amministratori (F.A.P.): il costo del co.co.co., non quello degli operai.
 * Ritorna { workerId: { costo, stimato, amministratore? } }.
 */
function ripartisci({ lorde, costo, oneri, cococo, imponibili, ratei = 0 }) {
  const totale = costo ?? (lorde + oneri);
  const out = {};
  const dip = [], amm = [], ignoti = [];
  for (const [id, x] of Object.entries(imponibili)) {
    const it = x == null ? null : typeof x === 'number' ? { imp: x, tipo: 'FPLD' } : x;
    if (!it) ignoti.push(id);
    else (it.tipo === 'FAP' ? amm : dip).push([id, it.imp, it.qualifica]);
  }
  // 13ª e 14ª maturano solo per gli impiegati (agli operai edili le paga la
  // Cassa Edile, già dentro le lorde): se nessuno risulta impiegato, su tutti
  const impiegati = dip.filter(d => d[2] === 'impiegato');
  const rateiImp = impiegati.length && ratei ? ratei : 0;
  const totImp = impiegati.reduce((s, [, imp]) => s + imp, 0);
  const comune = totale - rateiImp;
  const letti = dip.reduce((s, [, imp]) => s + imp, 0);
  // Tutti letti: si divide sull'imponibile letto (la somma torna al costo).
  // Qualcuno no: chi si legge vale come la sua parte delle lorde, il resto agli altri.
  const base = ignoti.length ? lorde : letti;
  for (const [id, imp, q] of dip) {
    out[id] = { costo: (base > 0 ? comune * imp / base : 0) + (q === 'impiegato' && totImp > 0 ? rateiImp * imp / totImp : 0), stimato: false };
  }
  const resto = Math.max(0, totale - dip.reduce((s, [id]) => s + out[id].costo, 0));
  for (const id of ignoti) out[id] = { costo: resto / ignoti.length, stimato: true };
  const totAmm = amm.reduce((s, [, imp]) => s + imp, 0);
  for (const [id, imp] of amm) {
    out[id] = cococo
      ? { costo: totAmm > 0 ? (cococo.compensi + cococo.oneri) * imp / totAmm : 0, stimato: false, amministratore: true }
      : { costo: imp, stimato: true, amministratore: true };
  }
  return out;
}

/**
 * Il conto di un mese, già con ore e costi (puro, per i test).
 * persone: [{ id, nome, costo, stimato, perCantiere: { siteId: minuti } }]
 * generali = le spese generali in parti misurate:
 *   ufficio: chi non ha ore in nessun cantiere né in magazzino, per nome;
 *   magazzino: ore timbrate in magazzino/sede × costo orario;
 *   nonInCantiere: per chi lavora nei cantieri, costo delle ore di contratto
 *     non timbrate in cantiere (ferie, pioggia, permessi, malattia) — negativo
 *     se ha fatto più ore del contratto;
 *   nonAttribuito: costo del mese non diviso fra le persone (+ arrotondamenti).
 */
function contoMese({ persone, cantieri, giorniLavorativi, oreGiornoMin, costoMese }) {
  const minContratto = giorniLavorativi * oreGiornoMin;
  const perCantiere = {};
  let attribuito = 0, magazzino = 0, nonInCantiere = 0, diviso = 0;
  const ufficio = [];
  for (const p of persone) {
    diviso += p.costo;
    const orario = minContratto > 0 ? p.costo / (minContratto / 60) : 0;
    let suoCantiere = 0, suoMagazzino = 0, minuti = 0;
    for (const [sid, min] of Object.entries(p.perCantiere || {})) {
      if (!min) continue;
      minuti += min;
      const nome = cantieri[sid] || 'Cantiere';
      if (NON_CANTIERE.test(nome)) { suoMagazzino += orario * (min / 60); continue; }
      const c = perCantiere[sid] || (perCantiere[sid] = { siteId: sid, nome, minuti: 0, costo: 0, persone: 0 });
      c.minuti += min;
      c.costo += orario * (min / 60);
      c.persone += 1;
      suoCantiere += orario * (min / 60);
    }
    attribuito += suoCantiere;
    if (!minuti) { if (p.costo) ufficio.push({ nome: p.nome || 'Senza nome', costo: Math.round(p.costo), stimato: !!p.stimato }); continue; }
    magazzino += suoMagazzino;
    nonInCantiere += p.costo - suoCantiere - suoMagazzino;
  }
  const elenco = Object.values(perCantiere)
    .map(c => ({ ...c, ore: Math.round(c.minuti / 60 * 2) / 2, costo: Math.round(c.costo) }))
    .sort((a, b) => b.costo - a.costo);
  ufficio.sort((a, b) => b.costo - a.costo);
  const speseGenerali = Math.round(costoMese - attribuito);
  const generali = { ufficio, magazzino: Math.round(magazzino), nonInCantiere: Math.round(nonInCantiere) };
  generali.nonAttribuito = speseGenerali - ufficio.reduce((s, u) => s + u.costo, 0) - generali.magazzino - generali.nonInCantiere;
  return { cantieri: elenco, costoMese: Math.round(costoMese), aiCantieri: Math.round(attribuito), speseGenerali, generali, nonDiviso: Math.round(costoMese - diviso) };
}

async function testoPdf(path, maxPages) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return '';
  const { text } = await extractPdfText(Buffer.from(await data.arrayBuffer()), { maxPages, minChars: 10 });
  return text || '';
}

/** Il prospetto contabile letto di un mese, o null se non c'è. */
async function costoDalProspetto(companyId, anno, mese) {
  const { data } = await supabase.from('buste_caricamenti')
    .select('id, riepilogo_path, esito, created_at').eq('company_id', companyId).not('riepilogo_path', 'is', null)
    .order('created_at', { ascending: false });
  for (const r of (data || []).filter(x => x.esito?.anno === anno && x.esito?.mese === mese)) {
    const p = leggiProspetto(await testoPdf(r.riepilogo_path, 40));
    if (p) return { ...p, caricamentoId: r.id };
  }
  return null;
}

/**
 * Il conto vero di un mese per un'impresa.
 * Ritorna { mese, pronto: false, manca } se manca il prospetto o le ore.
 */
async function quantoRendeMese(companyId, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) { const e = new Error('mese deve essere YYYY-MM'); e.status = 400; throw e; }
  const [anno, mese] = month.split('-').map(Number);
  const prospetto = await costoDalProspetto(companyId, anno, mese);
  if (!prospetto) return { mese: month, pronto: false, manca: 'prospetto' };
  const prima = await costoDalProspetto(companyId, mese === 1 ? anno - 1 : anno, mese === 1 ? 12 : mese - 1);
  const conto = costoDelMese(prospetto, prima);

  const { data: buste } = await supabase.from('payslips').select('worker_id, file_path')
    .eq('company_id', companyId).eq('period_year', anno).eq('period_month', mese);
  const imponibili = {};
  for (let i = 0; i < (buste || []).length; i += 6) {
    await Promise.all(buste.slice(i, i + 6).map(async b => {
      const it = leggiImponibileTipo(await testoPdf(b.file_path, 4));
      // due buste della stessa persona nello stesso mese (es. tredicesima a parte): si sommano
      const prec = imponibili[b.worker_id];
      imponibili[b.worker_id] = !it ? (prec ?? null) : { imp: (prec?.imp || 0) + it.imp, tipo: it.tipo, qualifica: it.qualifica || prec?.qualifica || null };
    }));
  }
  const ratei = conto.voci.find(v => v.chiave === 'ratei')?.importo || 0;
  const costi = ripartisci({ lorde: prospetto.lorde, costo: conto.totaleDipendenti, cococo: prospetto.cococo, imponibili, ratei });

  const ore = await buildOreMese(companyId, month, { esatto: true });
  const minTimbrati = ore.lavoratori.reduce((s, l) => s + Object.values(l.tot.perCantiere || {}).reduce((a, b) => a + b, 0), 0);
  if (!minTimbrati) return { mese: month, pronto: false, manca: 'ore' };

  const persone = ore.lavoratori.map(l => ({
    id: l.id, nome: l.nome, perCantiere: l.tot.perCantiere || {},
    costo: costi[l.id]?.costo || 0, stimato: !!costi[l.id]?.stimato, senzaBusta: !costi[l.id],
  }));
  // Chi ha la busta ma non timbra (tecnici, impiegati, amministratore): in ufficio, con il nome
  const fuoriOre = Object.keys(costi).filter(id => !persone.some(p => p.id === id));
  if (fuoriOre.length) {
    const { data: ws } = await supabase.from('workers').select('id, full_name, first_name, last_name').eq('company_id', companyId).in('id', fuoriOre);
    const nomi = new Map((ws || []).map(w => [w.id, w.full_name || [w.first_name, w.last_name].filter(Boolean).join(' ')]));
    for (const id of fuoriOre) persone.push({ id, nome: nomi.get(id) || 'Senza nome', perCantiere: {}, costo: costi[id].costo, stimato: costi[id].stimato });
  }
  const r = contoMese({
    persone, cantieri: ore.cantieri, giorniLavorativi: ore.giorniLavorativi,
    oreGiornoMin: ore.regole.oreGiornoMin, costoMese: conto.totale,
  });
  const lette = Object.values(imponibili).filter(v => v != null).length;
  return {
    mese: month, pronto: true, ...r,
    stima: true, verificatoCommercialista: false,
    conto: { ...conto, meseprimaLetto: !!prima },
    affidabilita: {
      busteLette: lette,
      buste: Object.keys(imponibili).length,
      senzaBusta: persone.filter(p => p.senzaBusta && Object.keys(p.perCantiere).length).map(p => p.nome),
    },
  };
}

// ── Congruità della manodopera (DM 143/2021, tabella dell'Accordo 10/9/2020) ──
// Percentuale minima della manodopera sul valore dell'opera. Testo verificato
// sul decreto ufficiale il 18/11/2026 (tutte e 17 le righe).
const CATEGORIE = {
  ristrutturazione_civile:      { nome: 'Ristrutturazione', lungo: 'Ristrutturazione di edifici civili', perc: 22.00 },
  nuova_civile:                 { nome: 'Nuova costruzione', lungo: 'Nuova edilizia civile, compresi impianti e forniture', perc: 14.28 },
  restauro_tutelati:            { nome: 'Restauro di edificio vincolato', lungo: 'Restauro e manutenzione di beni tutelati', perc: 30.00 },
  nuova_industriale:            { nome: 'Nuovo capannone', lungo: 'Nuova edilizia industriale, esclusi impianti', perc: 5.36 },
  ristrutturazione_industriale: { nome: 'Ristrutturazione industriale', lungo: 'Ristrutturazione di edifici industriali, esclusi impianti', perc: 6.69 },
  opere_stradali:               { nome: 'Strade e ponti', lungo: 'Opere stradali, ponti, etc.', perc: 13.77 },
  sottosuolo:                   { nome: 'Opere nel sottosuolo', lungo: "Opere d'arte nel sottosuolo", perc: 10.82 },
  dighe:                        { nome: 'Dighe', lungo: 'Dighe', perc: 16.07 },
  acquedotti_fognature:         { nome: 'Acquedotti e fognature', lungo: 'Acquedotti e fognature', perc: 14.63 },
  gasdotti:                     { nome: 'Gasdotti', lungo: 'Gasdotti', perc: 13.66 },
  oleodotti:                    { nome: 'Oleodotti', lungo: 'Oleodotti', perc: 13.66 },
  irrigazione:                  { nome: 'Irrigazione', lungo: 'Opere di irrigazione ed evacuazione', perc: 12.48 },
  marittime:                    { nome: 'Opere marittime', lungo: 'Opere marittime', perc: 12.16 },
  fluviali:                     { nome: 'Opere fluviali', lungo: 'Opere fluviali', perc: 13.31 },
  impianti_energia:             { nome: 'Impianti per energia', lungo: 'Impianti per la produzione di energia elettrica', perc: 14.23 },
  impianti_distribuzione:       { nome: 'Impianti di distribuzione', lungo: 'Impianti per la trasformazione e distribuzione', perc: 5.36 },
  bonifica:                     { nome: 'Bonifica ambientale', lungo: 'Bonifica e protezione ambientale', perc: 16.47 },
};
const SOGLIA_PRIVATI = 70000; // art. 2 c. 3: lavori privati di valore pari o superiore

/** Congruità stimata (puro). manodopera = costo dei propri operai finora. */
function congruita({ valore, categoria, manodopera }) {
  const c = CATEGORIE[categoria];
  if (!c || !(valore > 0)) return null;
  const serve = Math.round(valore * c.perc / 100);
  const fatta = Math.round(manodopera || 0);
  return {
    categoria, nome: c.nome, perc: c.perc, serve, fatta,
    percentuale: serve > 0 ? Math.round(fatta / serve * 100) : 0,
    mancano: Math.max(0, serve - fatta),
    obbligatoria: valore >= SOGLIA_PRIVATI,
  };
}

// ── Memoria dei mesi già calcolati ──
const ORA = 3600 * 1000;
// F-514: cambia ogni volta che cambia il modo di fare il conto; un conto ricordato
// con un altro numero si rifà (prima restava fino a 24 ore con la formula vecchia)
const VERSIONE_CONTO = 2;
function meseCorrente() { return new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' }).slice(0, 7); }

/** Il conto del mese, dalla memoria se ancora buono (24 h per i mesi chiusi, 1 h per quello in corso). */
async function quantoRendeMeseRicordato(companyId, month, { forza = false } = {}) {
  if (!forza) {
    const { data } = await supabase.from('quanto_rende_mesi').select('risultato, calcolato_at')
      .eq('company_id', companyId).eq('mese', month).maybeSingle();
    if (data) {
      const eta = Date.now() - Date.parse(data.calcolato_at);
      const [a, m] = month.split('-').map(Number);
      const { data: nuove } = await supabase.from('payslips').select('id').eq('company_id', companyId)
        .eq('period_year', a).eq('period_month', m).gt('created_at', data.calcolato_at).limit(1);
      const { data: prosp } = await supabase.from('buste_caricamenti').select('id').eq('company_id', companyId)
        .gt('created_at', data.calcolato_at).limit(1);
      const fresco = eta < (month === meseCorrente() ? ORA : 24 * ORA);
      if (fresco && data.risultato?.versione === VERSIONE_CONTO && !nuove?.length && !prosp?.length) return data.risultato;
    }
  }
  const r = { ...(await quantoRendeMese(companyId, month)), versione: VERSIONE_CONTO };
  // Anche «non pronto» (es. luglio senza timbrature) si ricorda: rileggere 17 buste
  // a ogni apertura per riscoprire che mancano le ore costava secondi
  await supabase.from('quanto_rende_mesi').upsert({ company_id: companyId, mese: month, risultato: r, calcolato_at: new Date().toISOString() });
  return r;
}

/** I mesi per cui c'è il prospetto contabile, dal più recente. */
async function mesiConProspetto(companyId) {
  const { data } = await supabase.from('buste_caricamenti').select('esito')
    .eq('company_id', companyId).not('riepilogo_path', 'is', null);
  const mesi = new Set((data || []).filter(r => r.esito?.anno && r.esito?.mese)
    .map(r => `${r.esito.anno}-${String(r.esito.mese).padStart(2, '0')}`));
  return [...mesi].sort().reverse();
}

/** I soldi di un cantiere: operai mese per mese, fatture, subappaltatori, congruità. */
async function soldiCantiere(companyId, siteId) {
  const { data: site } = await supabase.from('sites').select('id, name, budget_totale, congruita_categoria')
    .eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!site) return null;
  const elenco = await mesiConProspetto(companyId);
  const conti = await Promise.all(elenco.map(m => quantoRendeMeseRicordato(companyId, m)));
  const mesi = [];
  conti.forEach((r, i) => {
    const c = r.pronto ? r.cantieri.find(x => x.siteId === siteId) : null;
    if (c) mesi.push({ mese: elenco[i], ore: c.ore, costo: c.costo });
  });
  const operai = mesi.reduce((s, x) => s + x.costo, 0);

  const { data: spese } = await supabase.from('company_expenses').select('amount, is_credit_note')
    .eq('company_id', companyId).eq('site_id', siteId);
  const fatture = Math.round((spese || []).reduce((s, e) => s + (e.is_credit_note ? -1 : 1) * Math.abs(Number(e.amount) || 0), 0));

  const { data: accordi } = await supabase.from('sub_accordi').select('id').eq('company_id', companyId).eq('site_id', siteId);
  let sub = 0;
  if (accordi?.length) {
    const { data: pag } = await supabase.from('sub_pagamenti').select('importo').in('accordo_id', accordi.map(a => a.id));
    sub = Math.round((pag || []).reduce((s, p) => s + Number(p.importo || 0), 0));
  }
  const valore = site.budget_totale != null ? Number(site.budget_totale) : null;
  return {
    siteId, nome: site.name, valore, categoria: site.congruita_categoria || null,
    speso: { totale: operai + fatture + sub, operai, fatture, nFatture: (spese || []).length, sub },
    mesi,
    resta: valore != null ? valore - (operai + fatture + sub) : null,
    congruita: congruita({ valore, categoria: site.congruita_categoria, manodopera: operai }),
  };
}

module.exports = {
  leggiProspetto, leggiImponibile, leggiImponibileTipo, costoDelMese, ripartisci, contoMese, quantoRendeMese, NON_CANTIERE,
  CATEGORIE, SOGLIA_PRIVATI, congruita, quantoRendeMeseRicordato, mesiConProspetto, soldiCantiere,
};
