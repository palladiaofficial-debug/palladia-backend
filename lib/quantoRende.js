'use strict';
/**
 * lib/quantoRende.js — F-509 (AUDIT.md del frontend, 18/11/2026).
 *
 * Quanto costa davvero la manodopera di ogni cantiere, senza chiedere a
 * nessuno una tariffa oraria. Tutto viene da dati che Palladia ha già:
 *
 *  1. Il prospetto contabile del commercialista (fra i «Prospetti del
 *     commercialista», buste_caricamenti.riepilogo_path) dà il costo del mese
 *     di tutto il personale: retribuzioni lorde + oneri a carico della ditta.
 *  2. Ogni busta paga dà l'imponibile previdenziale (IMP.LE F.P.L.D.) della
 *     persona: serve a dividere quel costo fra le persone. Chi non si legge
 *     (impaginazione diversa) prende in parti uguali quello che resta.
 *  3. Costo orario della persona = suo costo ÷ ore di contratto del mese
 *     intero (giorni lavorativi × ore al giorno): non le ore timbrate, che il
 *     primo mese con Palladia sono solo una parte e gonfierebbero il costo.
 *  4. Cantiere = ore timbrate lì (lib/oreMese.js) × costo orario di chi le ha
 *     fatte. Il resto (tecnici, ufficio, ferie, pioggia, magazzino) sono spese
 *     generali: mai spalmate sui cantieri.
 *
 * Le buste e i prospetti sono paghe: lo vedono solo owner e admin (F-494).
 */
const supabase = require('./supabase');
const { extractPdfText } = require('./pdfExtract');
const { buildOreMese } = require('./oreMese');

const BUCKET = 'site-documents';
// Posti che hanno un QR ma non sono cantieri: le loro ore vanno nelle spese generali
const NON_CANTIERE = /\b(magazzin\w*|deposit\w*|sede|ufficio|officina)\b/i;

const num = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));

/** Dal testo del prospetto contabile: { lorde, oneri } o null. */
function leggiProspetto(testo) {
  const t = String(testo || '').replace(/\s+/g, ' ');
  if (!/PROSPETTO CONTABILE/i.test(t)) return null;
  const l = t.match(/Retribuzioni lorde\s+([\d.]+,\d\d)/i);
  const o = t.match(/Totale oneri ditta\s+([\d.]+,\d\d)/i);
  if (!l || !o) return null;
  return { lorde: num(l[1]), oneri: num(o[1]) };
}

/** Dal testo di una busta: imponibile previdenziale (F.P.L.D.) o null. */
function leggiImponibile(testo) {
  const m = String(testo || '').replace(/\s+/g, ' ').match(/IMP\.LE F\.P\.L\.D\.\s+([\d.]+,\d\d)/);
  return m ? num(m[1]) : null;
}

/**
 * Divide il costo del mese fra le persone.
 * imponibili: { workerId: numero | null }. Ritorna { workerId: { costo, stimato } }.
 */
function ripartisci({ lorde, oneri, imponibili }) {
  const fattore = (lorde + oneri) / lorde;
  const out = {};
  let letti = 0;
  const ignoti = [];
  for (const [id, imp] of Object.entries(imponibili)) {
    if (imp == null) { ignoti.push(id); continue; }
    out[id] = { costo: imp * fattore, stimato: false };
    letti += imp;
  }
  const resto = Math.max(0, lorde - letti) * fattore;
  for (const id of ignoti) out[id] = { costo: ignoti.length ? resto / ignoti.length : 0, stimato: true };
  return out;
}

/**
 * Il conto di un mese, già con ore e costi (puro, per i test).
 * persone: [{ id, nome, costo, stimato, perCantiere: { siteId: minuti } }]
 */
function contoMese({ persone, cantieri, giorniLavorativi, oreGiornoMin, costoMese }) {
  const minContratto = giorniLavorativi * oreGiornoMin;
  const perCantiere = {};
  let attribuito = 0;
  for (const p of persone) {
    const orario = minContratto > 0 ? p.costo / (minContratto / 60) : 0;
    for (const [sid, min] of Object.entries(p.perCantiere || {})) {
      if (!min) continue;
      const nome = cantieri[sid] || 'Cantiere';
      if (NON_CANTIERE.test(nome)) continue;
      const c = perCantiere[sid] || (perCantiere[sid] = { siteId: sid, nome, minuti: 0, costo: 0, persone: 0 });
      c.minuti += min;
      c.costo += orario * (min / 60);
      c.persone += 1;
      attribuito += orario * (min / 60);
    }
  }
  const elenco = Object.values(perCantiere)
    .map(c => ({ ...c, ore: Math.round(c.minuti / 60 * 2) / 2, costo: Math.round(c.costo) }))
    .sort((a, b) => b.costo - a.costo);
  return { cantieri: elenco, costoMese: Math.round(costoMese), aiCantieri: Math.round(attribuito), speseGenerali: Math.round(costoMese - attribuito) };
}

async function testoPdf(path, maxPages) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return '';
  const { text } = await extractPdfText(Buffer.from(await data.arrayBuffer()), { maxPages, minChars: 10 });
  return text || '';
}

/** Il costo del mese dal prospetto contabile, o null se non c'è. */
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

  const { data: buste } = await supabase.from('payslips').select('worker_id, file_path')
    .eq('company_id', companyId).eq('period_year', anno).eq('period_month', mese);
  const imponibili = {};
  for (let i = 0; i < (buste || []).length; i += 6) {
    await Promise.all(buste.slice(i, i + 6).map(async b => {
      const imp = leggiImponibile(await testoPdf(b.file_path, 4));
      // due buste della stessa persona nello stesso mese (es. tredicesima a parte): si sommano
      imponibili[b.worker_id] = imp == null ? (imponibili[b.worker_id] ?? null) : (imponibili[b.worker_id] || 0) + imp;
    }));
  }
  const costi = ripartisci({ lorde: prospetto.lorde, oneri: prospetto.oneri, imponibili });

  const ore = await buildOreMese(companyId, month, { esatto: true });
  const minTimbrati = ore.lavoratori.reduce((s, l) => s + Object.values(l.tot.perCantiere || {}).reduce((a, b) => a + b, 0), 0);
  if (!minTimbrati) return { mese: month, pronto: false, manca: 'ore' };

  const persone = ore.lavoratori.map(l => ({
    id: l.id, nome: l.nome, perCantiere: l.tot.perCantiere || {},
    costo: costi[l.id]?.costo || 0, stimato: !!costi[l.id]?.stimato, senzaBusta: !costi[l.id],
  }));
  const conto = contoMese({
    persone, cantieri: ore.cantieri, giorniLavorativi: ore.giorniLavorativi,
    oreGiornoMin: ore.regole.oreGiornoMin, costoMese: prospetto.lorde + prospetto.oneri,
  });
  return {
    mese: month, pronto: true, ...conto,
    affidabilita: {
      busteLette: Object.values(imponibili).filter(v => v != null).length,
      buste: Object.keys(imponibili).length,
      senzaBusta: persone.filter(p => p.senzaBusta && Object.keys(p.perCantiere).length).map(p => p.nome),
    },
  };
}

module.exports = { leggiProspetto, leggiImponibile, ripartisci, contoMese, quantoRendeMese, NON_CANTIERE };
