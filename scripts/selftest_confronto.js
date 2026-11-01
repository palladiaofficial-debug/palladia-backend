#!/usr/bin/env node
/**
 * scripts/selftest_confronto.js — F-423 (AUDIT.md del frontend).
 *
 * La fattura torna con le bolle? Prima le regole pure (lib/confronto.js), poi il giro
 * sul DB con «Carica un documento» (modello finto):
 *  - 40 sacchi arrivati, 45 in fattura a 7,50 → «Ti fanno pagare 5 sacchi di cemento in più», 37,50 €;
 *  - descrizioni scritte diverse (bolla e fattura) e unità diverse (t e kg) si abbinano;
 *  - «Ferro d.12» non è «Ferro d.16»; trasporto e contributi non si confrontano;
 *  - un materiale in fattura che nelle bolle non c'è «non torna»; in fattura meno di quanto arrivato torna;
 *  - abbinamento: le bolle citate dalla fattura; altrimenti stesso fornitore, ultimi 60 giorni, libere;
 *  - DB: bolla e fattura caricate insieme → salvate, la bolla prende la fattura, esito e messaggio.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { confronta, scegliBolle, messaggio, somiglia, unita } = require('../lib/confronto');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}

function puri() {
  console.log('\n\x1b[1mF-423 — il confronto (regole)\x1b[0m');
  const bolla = { id: 'b1', numero: '1482', righe: [
    { descrizione: 'Cemento 32.5R sacchi 25 kg', quantita: 40, unita: 'sacchi' },
    { descrizione: 'Ferro B450C diametro 12', quantita: 600, unita: 'kg' },
    { descrizione: 'Sabbia lavata', quantita: 2, unita: 'mc' },
  ] };
  const fattura = { righe: [
    { descrizione: 'Cemento Portland 32,5 R in sacchi', quantita: 45, unita: 'sac', prezzo: 7.5, importo: 337.5 },
    { descrizione: 'Tondino ferro B450C d.12', quantita: 0.6, unita: 't', prezzo: 950, importo: 570 },
    { descrizione: 'Sabbia lavata 0/4', quantita: 2, unita: 'm3', prezzo: 38 },
    { descrizione: 'Trasporto', quantita: null, unita: null, importo: 60 },
  ] };
  const c = confronta([bolla], fattura);
  const cem = c.righe.find(r => /emento/.test(r.descrizione));
  check('cemento: 40 arrivati, 45 in fattura → 5 sacchi in più, 37,50 €', cem?.stato === 'in_piu' && cem.arrivati === 40 && cem.fatturati === 45 && cem.euro === 37.5, cem);
  check('la frase: «Ti fanno pagare 5 sacchi di cemento in più»', c.esito === 'non_torna' && c.frase === 'Ti fanno pagare 5 sacchi di cemento in più' && c.inPiuEuro === 37.5, c);
  check('ferro 0,6 t in fattura = 600 kg arrivati: torna; sabbia torna; «tornano» ferro e sabbia', c.righe.find(r => /erro/.test(r.descrizione))?.stato === 'torna' && c.tornano.join(',') === 'ferro,sabbia', c.tornano);
  check('il trasporto (senza quantità) non si confronta', !c.righe.some(r => /rasporto/.test(r.descrizione)));
  check('tutto uguale → «Torna tutto con le bolle»', confronta([bolla], { righe: bolla.righe }).esito === 'torna' && confronta([bolla], { righe: bolla.righe }).frase === 'Torna tutto con le bolle');
  check('«Ferro d.12» e «Ferro d.16» non sono la stessa cosa', somiglia('Ferro B450C d.12', 'Ferro B450C d.16') === 0 && somiglia('Ferro B450C d.12', 'tondino ferro diametro 12') > 0.5);
  const non = confronta([bolla], { righe: [{ descrizione: 'Rete elettrosaldata', quantita: 10, unita: 'pz', prezzo: 20 }] });
  check('un materiale in fattura che nelle bolle non c\'è → non torna, «… che nelle bolle non c\'è»', non.esito === 'non_torna' && /nelle bolle non c'è/.test(non.frase) && non.inPiuEuro === 200, non);
  const meno = confronta([bolla], { righe: [{ descrizione: 'Cemento 32.5R', quantita: 38, unita: 'sacchi' }] });
  check('in fattura meno di quanto arrivato → torna (in_meno)', meno.esito === 'torna' && meno.righe[0].stato === 'in_meno', meno);
  const due = confronta([bolla, { id: 'b2', numero: '1490', righe: [{ descrizione: 'Cemento 32.5R sacchi', quantita: 10, unita: 'sacchi' }] }], { righe: [{ descrizione: 'Cemento 32,5R', quantita: 50, unita: 'sacchi' }] });
  check('due bolle (40 + 10 sacchi) e una fattura da 50 → torna', due.esito === 'torna', due);
  check('unità: «t» = 1000 kg, «q» = 100 kg, «m3» = mc', unita('t').k === 1000 && unita('q').k === 100 && unita('m3').u === 'mc');
  check('nessuna bolla → «senza_bolle»', confronta([], fattura).esito === 'senza_bolle');

  console.log('\n\x1b[1mF-423 — quali bolle\x1b[0m');
  const cand = [
    { id: 'a', numero: '1482', fornitore: 'Edilmateriali Liguria Srl', fornitore_piva: '01987654329', data: '2026-10-30', fattura_id: null },
    { id: 'b', numero: '1490', fornitore: 'EDILMATERIALI LIGURIA S.R.L.', fornitore_piva: null, data: '2026-10-20', fattura_id: null },
    { id: 'c', numero: '1300', fornitore: 'Edilmateriali Liguria', fornitore_piva: '01987654329', data: '2026-07-01', fattura_id: null },
    { id: 'd', numero: '1495', fornitore: 'Edilmateriali Liguria', fornitore_piva: '01987654329', data: '2026-10-25', fattura_id: 'altra' },
    { id: 'e', numero: '77', fornitore: 'Noleggi Genova', fornitore_piva: '09999999999', data: '2026-10-29', fattura_id: null },
  ];
  check('la fattura cita il DDT 1482 → solo quella bolla', scegliBolle(cand, { bolle_citate: ['DDT n. 1482'], piva: '01987654329', data: '2026-10-31' }).map(b => b.id).join() === 'a');
  check('senza bolle citate: stesso fornitore (P.IVA o nome), ultimi 60 giorni, non già abbinate', scegliBolle(cand, { fornitore: 'Edilmateriali Liguria S.r.l.', data: '2026-10-31' }).map(b => b.id).sort().join() === 'a,b', scegliBolle(cand, { fornitore: 'Edilmateriali Liguria S.r.l.', data: '2026-10-31' }).map(b => b.id));
  const m = messaggio({ azienda: 'MSCedilizia', fornitore: 'Edilmateriali', numero: 'FT/245', data: '2026-10-31', confronto: c, bolle: [bolla] });
  check('il messaggio per il fornitore: numero della fattura, bolla, cemento 45 contro 40', /fattura n\. FT\/245 del 31 ottobre 2026/.test(m) && /n\. 1482/.test(m) && /in fattura 45 sacchi, con le bolle ne sono arrivati 40 sacchi/.test(m), m);
}

// ── Giro sul DB: bolla e fattura caricate insieme da «Carica un documento» (modello finto) ──
async function db() {
  console.log('\n\x1b[1mF-423 — sul DB\x1b[0m');
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const supabase = require('../lib/supabase');
  const K = require('../lib/impreseCarica');
  const B = require('../lib/bolle');
  const F = require('../lib/fatture');
  const { costruisci } = require('../lib/oggi');
  const { extractPdfText } = require('../lib/pdfExtract');
  const pdf = async (t) => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([595, 842]).drawText(t, { x: 40, y: 780, size: 12, font: f }); return Buffer.from(await d.save()); };
  const R = {
    bolla: { tipo: 'bolla', ragione_sociale: 'EDILMATERIALI LIGURIA SRL', partita_iva: '01987654329', numero: '1482', data_documento: '2026-10-30', firmato: true, cantiere: 'Via Balbi 31, Genova',
      righe: [{ descrizione: 'Cemento 32.5R sacchi 25 kg', quantita: 40, unita: 'sacchi' }, { descrizione: 'Ferro B450C d.12', quantita: 600, unita: 'kg' }, { descrizione: 'Sabbia lavata', quantita: 2, unita: 'mc' }] },
    fattura: { tipo: 'fattura', ragione_sociale: 'Edilmateriali Liguria S.r.l.', partita_iva: '01987654329', numero: 'FT/245', data_documento: '2026-10-31', totale: 1214.6, bolle_citate: ['1482'],
      righe: [{ descrizione: 'Cemento Portland 32,5 R', quantita: 45, unita: 'sacchi', prezzo: 7.5, importo: 337.5 }, { descrizione: 'Tondino B450C d.12', quantita: 600, unita: 'kg', prezzo: 0.95, importo: 570 }, { descrizione: 'Sabbia lavata', quantita: 2, unita: 'mc', prezzo: 38, importo: 76 }, { descrizione: 'Trasporto', quantita: null, importo: 60 }] },
    sola: { tipo: 'fattura', ragione_sociale: 'Noleggi Genova Srl', numero: '88', data_documento: '2026-10-31', righe: [{ descrizione: 'Nolo betoniera', quantita: 1, unita: 'pz', prezzo: 120 }] },
  };
  const chiedi = async ({ contenuto }) => { const { text } = await extractPdfText(Buffer.from(contenuto[0].source.data, 'base64'), { maxPages: 2, minChars: 0 }); return R[text.match(/DOC:(\w+)/)[1]]; };
  const dividi = async () => [{ da: 1, a: 1 }];
  const UTENTE = 'a56d9d41-20aa-4b69-a5b9-913bf1707ac4';
  const T = `TEST-F423-${Date.now()}`;
  const { data: co } = await supabase.from('companies').insert({ name: T }).select().single();
  try {
    await supabase.from('company_feature_flags').insert({ company_id: co.id, feature: 'subappaltatori', enabled: true });
    const { data: site } = await supabase.from('sites').insert({ company_id: co.id, name: `${T} Via Balbi`, address: 'Via Balbi 31, Genova', status: 'attivo' }).select().single();
    const { id } = await K.crea(co.id, UTENTE, {});
    for (const k of ['bolla', 'fattura', 'sola']) await K.aggiungi(co.id, id, { originalname: `${k}.pdf`, mimetype: 'application/pdf', buffer: await pdf(`DOC:${k} ${T}`) }, { senzaLavoro: true });
    await K.lavora(co.id, id, { chiedi, dividi });
    const s = await K.stato(co.id, id);
    const fv = s.bolle.find(x => x.fattura?.numero === 'FT/245');
    check('prima di salvare: la fattura confrontata con la bolla dello stesso caricamento → «5 sacchi di cemento in più»', fv?.fattura.anteprima?.esito === 'non_torna' && fv.fattura.anteprima.frase === 'Ti fanno pagare 5 sacchi di cemento in più' && fv.fattura.anteprima.bolle === 1, fv);
    check('le due fatture e la bolla sono tutte da salvare', s.daSalvare.length === 3, s.daSalvare);
    const r = await K.salva(co.id, UTENTE, id);
    check('salvate: la bolla e due fatture, «una non torna», verificate', r.salvati === 3 && r.fatture.length === 2 && /una non torna/.test(r.resultCard.fatto.after) && r.resultCard.fatto.verified, r);
    const ft = r.fatture.find(x => x.esito === 'non_torna');
    const el = await B.elenco(co.id, site.id);
    check('nel cantiere la bolla dice «la fattura non torna», col numero della fattura', el.bolle[0]?.stato === 'non_torna' && el.bolle[0].fattura?.numero === 'FT/245', el.bolle[0]);
    const sc = await F.scheda(co.id, ft.id);
    check('la pagina del confronto: 40 arrivati, 45 in fattura, 37,50 € in più; ferro e sabbia tornano', sc.righe.find(x => x.stato === 'in_piu')?.arrivati === 40 && sc.inPiuEuro === 37.5 && sc.tornano.join(',') === 'ferro,sabbia' && sc.bolle.length === 1, sc);
    check('«Chiedi a Edilmateriali»: il messaggio con fattura, bolla e quantità, per WhatsApp ed email', /FT\/245/.test(sc.chiedi?.testo) && /n\. 1482/.test(sc.chiedi.testo) && /^https:\/\/wa\.me\/\?text=/.test(sc.chiedi.whatsapp) && /^mailto:/.test(sc.chiedi.email), sc.chiedi);
    const sola = r.fatture.find(x => x.fornitore === 'Noleggi Genova Srl');
    check('la fattura senza bolle: salvata, «senza bolle»', sola?.esito === 'senza_bolle', sola);
    let h = await costruisci(co.id, null, 'owner');
    const riga = [h.prima, ...h.poi].find(x => x?.titolo === 'La fattura di Edilmateriali Liguria S.r.l. non torna');
    check('su Oggi: «La fattura di Edilmateriali non torna · 5 sacchi di cemento in più · 37,50 € in più», arancione', riga?.tono === 'arancio' && /5 sacchi di cemento in più · 37,50 € in più/.test(riga.sotto) && riga.link === `/fatture/${ft.id}`, riga);
    await F.vaBene(co.id, ft.id);
    h = await costruisci(co.id, null, 'owner');
    const el2 = await B.elenco(co.id, site.id);
    check('«Va bene così»: sparisce da Oggi, la bolla torna con la fattura', ![h.prima, ...h.poi].some(x => /non torna/.test(x?.titolo || '')) && el2.bolle[0].stato === 'torna', el2.bolle[0]);
  } finally {
    const { data: fb } = await supabase.from('bolle').select('file_path').eq('company_id', co.id);
    const { data: ff } = await supabase.from('fatture').select('file_path').eq('company_id', co.id);
    const files = [...(fb || []), ...(ff || [])].map(x => x.file_path).filter(Boolean);
    if (files.length) await supabase.storage.from('site-documents').remove(files);
    for (const t of ['bolle', 'fatture', 'imprese_caricamento_doc', 'imprese_caricamenti', 'company_feature_flags']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    const { error } = await supabase.from('companies').delete().eq('id', co.id);
    if (error) console.error('pulizia azienda di prova:', error.message);
  }
}

(async () => {
  puri();
  await db();
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
