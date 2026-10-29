#!/usr/bin/env node
/**
 * scripts/selftest_imprese_carica.js — F-401 (AUDIT.md del frontend).
 *
 * «Carica documenti» delle imprese in subappalto, tutti in un colpo:
 *  - lettura: scadenze calcolate (DURC +120 gg, formazione 5 anni, preposto 2,
 *    primo soccorso 3…), dati sporchi ripuliti, documenti lunghi come testo;
 *  - attribuzione: partita IVA, operaio (codice fiscale o nome), ragione
 *    sociale, impresa di partenza, impresa nuova, da assegnare; un foglio con
 *    la NOSTRA partita IVA non finisce su un'impresa; POS al cantiere giusto;
 *  - giudizio: scaduto, visura vecchia, firma mancante, impresa sbagliata;
 *  - ordine: doppioni, superati (si tiene il migliore), per impresa e operaio;
 *  - giro completo sul DB con un modello finto: PDF con più documenti diviso,
 *    foto, ZIP aperto, doppione, HEIC rifiutato, correzioni, salvataggio nelle
 *    tabelle vere (operaio nuovo creato, date dell'impresa portate avanti).
 */
'use strict';
require('dotenv').config();
const AdmZip = require('adm-zip');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const { pulisci, contenutoPer } = require('../lib/impreseCarica/lettura');
const { attribuisci, giudizio } = require('../lib/impreseCarica/attribuisci');
const { ordina } = require('../lib/impreseCarica/ordina');
const { extractPdfText } = require('../lib/pdfExtract');
const K = require('../lib/impreseCarica');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const rifiuta = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const OGGI = '2026-10-29';
const PIVA = { noi: '01234567897', A: '09876543217', B: '11122233344', nuova: '55566677788' };

function lettura() {
  console.log('\n\x1b[1mF-401 — lettura e scadenze\x1b[0m');
  const durc = pulisci({ tipo: 'durc', partita_iva: 'IT 0987654321 7', data_documento: '2026-09-01' });
  check('DURC con la sola emissione: scade dopo 120 giorni, calcolata; P.IVA ripulita', durc.scadenza === '2026-12-30' && durc.scadenzaCalcolata && durc.piva === PIVA.A, durc);
  const prep = pulisci({ tipo: 'attestato', corso: 'preposto', persona: 'ROSSI MARIO', codice_fiscale_persona: 'rss mra 80a01 d969a', data_documento: '2026-03-10' });
  check('attestato preposto: 2 anni, titolo «Corso preposto», nome e codice fiscale puliti', prep.scadenza === '2028-03-10' && prep.titolo === 'Corso preposto' && prep.persona === 'Rossi Mario' && prep.cfPersona === 'RSSMRA80A01D969A', prep);
  check('primo soccorso 3 anni, formazione 5 anni', pulisci({ tipo: 'attestato', corso: 'primo_soccorso', data_documento: '2026-01-01' }).scadenza === '2029-01-01' && pulisci({ tipo: 'formazione', data_documento: '2026-01-01' }).scadenza === '2031-01-01');
  const vis = pulisci({ tipo: 'idoneita', data_documento: '2026-01-01' });
  check('visita medica senza scadenza: resta senza (la decide il medico)', vis.scadenza === null && !vis.scadenzaCalcolata, vis);
  check('scritta sul foglio: vale quella', pulisci({ tipo: 'formazione', data_documento: '2026-01-01', scadenza: '2027-05-05' }).scadenza === '2027-05-05');
  check('risposta strana: tipo «altro», niente errori, date non ISO scartate', (() => { const x = pulisci({ tipo: 'boh', scadenza: '31/12/2027', partita_iva: '123' }); return x.tipo === 'altro' && x.scadenza === null && x.piva === null; })());
  check('foto → immagine; PDF corto → documento intero', contenutoPer({ buffer: Buffer.from('x'), mimetype: 'image/png' })[0].type === 'image' && contenutoPer({ buffer: Buffer.from('x'), mimetype: 'application/pdf', pagine: 3 })[0].type === 'document');
  const lungo = contenutoPer({ buffer: Buffer.from('x'), mimetype: 'application/pdf', pagine: 80, testoPagine: Array.from({ length: 80 }, (_, i) => `p${i + 1}`) });
  check('PDF lungo (un POS di 80 pagine) → testo delle prime 6 e delle ultime 2 pagine', lungo[0].type === 'text' && /p1\n.*p6\np79\np80/s.test(lungo[0].text) && !/p7\n/.test(lungo[0].text), lungo[0].text.slice(0, 120));
}

const CTX = {
  oggi: OGGI, pivaNostra: PIVA.noi, pre: null,
  imprese: [{ id: 'A', nome: 'Impianti Verdi Srl', piva: PIVA.A, daCompletare: false }, { id: 'B', nome: 'Edil Bianchi Srl', piva: PIVA.B, daCompletare: false }],
  operai: [{ id: 'a1', nome: 'Mario Rossi', cf: 'RSSMRA80A01D969A', subId: 'A' }, { id: 'b1', nome: 'Paolo Neri', cf: null, subId: 'B' }],
  cantieriPer: { A: [{ id: 's1', nome: 'Via Roma', indirizzo: 'Via Roma 1, Genova' }, { id: 's2', nome: 'Galileo', indirizzo: 'Piazza Galileo Ferraris 1, Genova' }], B: [{ id: 's3', nome: 'Corso Sardegna', indirizzo: 'Corso Sardegna 88' }] },
};
const L = (x) => pulisci(x);

function attribuzione() {
  console.log('\n\x1b[1mF-401 — di chi è, e se va bene\x1b[0m');
  let p = attribuisci(L({ tipo: 'durc', partita_iva: PIVA.A, ragione_sociale: 'IMPIANTI VERDI SRL', data_documento: '2026-09-01' }), CTX);
  check('DURC con la P.IVA di Impianti Verdi → loro, certo, va bene (scade il 30/12)', p.impresa?.id === 'A' && p.come === 'piva' && p.esito === 'va_bene' && p.scadenza === '2026-12-30', p);
  p = attribuisci(L({ tipo: 'durc', ragione_sociale: 'EDIL BIANCHI S.R.L.', data_documento: '2026-09-01' }), CTX);
  check('DURC senza P.IVA, nome «EDIL BIANCHI S.R.L.» → Edil Bianchi per nome', p.impresa?.id === 'B' && p.come === 'nome', p);
  p = attribuisci(L({ tipo: 'durc', partita_iva: PIVA.noi, ragione_sociale: 'MSC', data_documento: '2026-09-01' }), { ...CTX, pre: 'A' });
  check('DURC con la NOSTRA P.IVA → non va su un subappaltatore («documento della tua impresa»)', p.nostra && !p.impresa && p.esito === 'non_va' && p.motivo.codice === 'nostra_impresa', p);
  p = attribuisci(L({ tipo: 'idoneita', persona: 'ROSSI MARIO', codice_fiscale_persona: 'RSSMRA80A01D969A', scadenza: '2027-06-01' }), CTX);
  check('visita col codice fiscale di Mario Rossi → Impianti Verdi, Mario Rossi', p.impresa?.id === 'A' && p.come === 'operaio' && p.operaio?.id === 'a1' && p.esito === 'va_bene', p);
  p = attribuisci(L({ tipo: 'formazione', persona: 'NERI PAOLO', data_documento: '2026-02-01' }), CTX);
  check('corso di «NERI PAOLO» senza ditta → Edil Bianchi dal nome dell\'operaio', p.impresa?.id === 'B' && p.operaio?.id === 'b1' && p.scadenza === '2031-02-01', p);
  p = attribuisci(L({ tipo: 'attestato', corso: 'preposto', persona: 'LUCA GIALLI', data_documento: '2026-02-01' }), { ...CTX, pre: 'B' });
  check('attestato di uno sconosciuto, caricato dalla scheda di Edil Bianchi → loro, operaio nuovo «Luca Gialli»', p.impresa?.id === 'B' && p.come === 'scelta' && p.operaio?.nuovo?.nome === 'Luca Gialli', p);
  p = attribuisci(L({ tipo: 'durc', partita_iva: PIVA.nuova, ragione_sociale: 'PONTEGGI GIALLI SRL', sede: 'Via X', data_documento: '2026-09-01' }), { ...CTX, pre: 'A' });
  check('DURC con una P.IVA di nessuno, anche partendo da Impianti Verdi → impresa nuova (non Impianti Verdi)', p.impresa?.nuova?.piva === PIVA.nuova && p.come === 'nuova', p);
  // Trovato dal test Playwright su palladia.net: il DURC di un'altra ditta, senza P.IVA letta, finiva sull'impresa di partenza
  p = attribuisci(L({ tipo: 'durc', ragione_sociale: 'PONTEGGI GIALLI E2E S.R.L.', data_documento: '2026-10-01' }), { ...CTX, pre: 'A' });
  check("DURC che nomina un'altra ditta, senza P.IVA, partendo da Impianti Verdi → impresa nuova «Ponteggi Gialli», MAI Impianti Verdi", p.impresa?.nuova?.nome === 'PONTEGGI GIALLI E2E S.R.L.' && p.impresa?.id !== 'A', p);
  p = attribuisci(L({ tipo: 'durc', ragione_sociale: 'IMPIANTI VERDI', data_documento: '2026-10-01' }), { ...CTX, pre: 'A' });
  check("…se il nome somiglia all'impresa di partenza, resta lì", p.impresa?.id === 'A', p);
  p = attribuisci(L({ tipo: 'dvr' }), CTX);
  check('un DVR senza nome né P.IVA, senza impresa di partenza → da assegnare', p.impresa === null, p);
  p = attribuisci(L({ tipo: 'pos', partita_iva: PIVA.A, cantiere: 'Piazza Galileo Ferraris 1A, 16142 Genova' }), CTX);
  check('POS di Impianti Verdi per Piazza Galileo → il cantiere giusto dei loro due', p.siteId === 's2' && p.esito === 'va_bene', p);
  p = attribuisci(L({ tipo: 'dichiarazione', partita_iva: PIVA.A, firmato: false }), CTX);
  check('dichiarazione senza firma → non va, «Manca la firma»', p.esito === 'non_va' && p.motivo.codice === 'senza_firma', p);
  p = attribuisci(L({ tipo: 'visura', partita_iva: PIVA.A, data_documento: '2026-01-10' }), CTX);
  check('visura di gennaio → non va, più di 6 mesi', p.esito === 'non_va' && p.motivo.codice === 'visura_vecchia', p);
  p = attribuisci(L({ tipo: 'durc', partita_iva: PIVA.A, scadenza: '2026-09-30' }), CTX);
  check('DURC scaduto → non va, scaduto', p.esito === 'non_va' && p.motivo.codice === 'scaduto', p);
  const letto = L({ tipo: 'durc', partita_iva: PIVA.A, scadenza: '2027-01-30' });
  const spostato = { ...attribuisci(letto, CTX), impresa: { id: 'B' } };
  check('spostato a mano su Edil Bianchi un DURC con la P.IVA di Impianti Verdi → «È di un\'altra impresa»', giudizio(spostato, letto, CTX).motivo?.codice === 'altra_impresa', giudizio(spostato, letto, CTX));
}

function ordine() {
  console.log('\n\x1b[1mF-401 — in ordine\x1b[0m');
  const doc = (id, letto, extra = {}) => ({ id, stato: 'pronto', nome_file: `${id}.pdf`, pagine: '1', content_hash: extra.hash || id, letto: L(letto), proposta: attribuisci(L(letto), { ...CTX, pre: extra.pre || null }), gia: !!extra.gia });
  const docs = [
    doc('durc-vecchio', { tipo: 'durc', partita_iva: PIVA.A, scadenza: '2026-11-15' }),
    doc('durc-nuovo', { tipo: 'durc', partita_iva: PIVA.A, scadenza: '2027-02-10' }),
    doc('durc-copia', { tipo: 'durc', partita_iva: PIVA.A, scadenza: '2027-02-10' }, { hash: 'durc-nuovo' }),
    doc('visita-mario', { tipo: 'idoneita', codice_fiscale_persona: 'RSSMRA80A01D969A', persona: 'Rossi Mario', scadenza: '2027-06-01' }),
    doc('gia', { tipo: 'visura', partita_iva: PIVA.B, data_documento: '2026-10-01' }, { gia: true }),
    doc('dvr-chi', { tipo: 'dvr' }),
    doc('nostro', { tipo: 'durc', partita_iva: PIVA.noi }),
    doc('pos-b', { tipo: 'pos', partita_iva: PIVA.B }),
    { id: 'rotto', stato: 'errore', nome_file: 'rotto.pdf', errore: 'Non sono riuscito a leggerlo' },
  ];
  const o = ordina(docs, CTX);
  const A = o.imprese.find(g => g.id === 'A');
  check('il DURC migliore resta (fino al 10/02/2027), quello vecchio è superato', A?.documenti.filter(d => d.tipo === 'durc').length === 1 && o.superati.some(d => d.id === 'durc-vecchio'), { A, superati: o.superati });
  check('lo stesso file due volte → doppione', o.doppioni.some(d => d.id === 'durc-copia' && /Uguale a durc-nuovo/.test(d.perche)), o.doppioni);
  check('un file già in Palladia → doppione «È già in Palladia»', o.doppioni.some(d => d.id === 'gia' && d.perche === 'È già in Palladia'));
  check('la visita di Mario Rossi sotto Impianti Verdi › Mario Rossi', A?.operai.length === 1 && A.operai[0].nome === 'Mario Rossi' && A.operai[0].documenti[0].label === 'Visita medica', A?.operai);
  check('il DVR senza nome da assegnare; il DURC nostro a parte; il file rotto tra i non letti', o.daAssegnare.some(d => d.id === 'dvr-chi') && o.nostri.some(d => d.id === 'nostro') && o.errori.some(d => d.id === 'rotto'), o);
  check('POS di Edil Bianchi con un solo cantiere → «POS · Corso Sardegna»', o.imprese.find(g => g.id === 'B')?.documenti[0]?.label === 'POS · Corso Sardegna');
  check('si salvano solo quelli in ordine (DURC nuovo, visita, POS)', o.daSalvare.sort().join(',') === ['durc-nuovo', 'pos-b', 'visita-mario'].sort().join(','), o.daSalvare);
  check('pezzi del PDF: sovrapposti o fuori dal file → un documento solo', K.pezziValidi([{ da: 1, a: 2 }, { da: 2, a: 3 }], 3).length === 1 && K.pezziValidi([{ da: 1, a: 1 }, { da: 2, a: 5 }], 3).length === 1 && K.pezziValidi([{ da: 1, a: 1 }, { da: 2, a: 3 }], 3).length === 2);
}

// ── Giro completo sul DB, con un modello finto ──────────────────────────────
async function pdf(pagine) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pagine) doc.addPage([595, 842]).drawText(t, { x: 40, y: 780, size: 12, font });
  return Buffer.from(await doc.save());
}
// Il modello finto legge il marcatore «DOC:nome» scritto nel PDF
const RISPOSTE = {};
async function chiediFinto({ contenuto }) {
  const b = contenuto[0];
  if (b.type === 'image') return RISPOSTE.foto;
  const { text } = await extractPdfText(Buffer.from(b.source.data, 'base64'), { maxPages: 10, minChars: 0 });
  const m = text.match(/DOC:(\w+)/);
  if (!m || !RISPOSTE[m[1]]) throw new Error('marcatore sconosciuto');
  return RISPOSTE[m[1]];
}
// Il pacchetto si divide pagina per pagina
const dividiFinto = async ({ pagine }) => Array.from({ length: pagine }, (_, i) => ({ da: i + 1, a: i + 1 }));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function db() {
  console.log('\n\x1b[1mF-401 — giro completo sul DB (modello finto)\x1b[0m');
  const T = `TEST-F401-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T, piva: PIVA.noi });
  const altra = await ins('companies', { name: `${T}-altra` });
  try {
    const A = await ins('subcontractors', { company_id: co.id, company_name: 'Impianti Verdi Srl', piva: PIVA.A, is_active: true, durc_expiry: '2026-11-01' });
    const B = await ins('subcontractors', { company_id: co.id, company_name: 'Edil Bianchi Srl', piva: PIVA.B, is_active: true });
    const site = await ins('sites', { company_id: co.id, name: `${T} Galileo`, address: 'Piazza Galileo Ferraris 1, Genova', status: 'attivo' });
    await ins('site_subcontractors', { company_id: co.id, site_id: site.id, subcontractor_id: A.id });
    const mario = await ins('sub_workers', { company_id: co.id, subcontractor_id: A.id, full_name: 'Mario Rossi', fiscal_code: `RSSMRA80A01D9${String(Date.now()).slice(-2)}A`.slice(0, 16), added_via: 'ufficio' });

    Object.assign(RISPOSTE, {
      durcA: { tipo: 'durc', partita_iva: PIVA.A, ragione_sociale: 'IMPIANTI VERDI SRL', scadenza: '2027-02-10' },
      prepLuca: { tipo: 'attestato', corso: 'preposto', persona: 'LUCA GIALLI', data_documento: '2026-03-10', ragione_sociale: 'IMPIANTI VERDI SRL' },
      formMario: { tipo: 'formazione', persona: 'ROSSI MARIO', codice_fiscale_persona: mario.fiscal_code, data_documento: '2026-02-01' },
      visuraA: { tipo: 'visura', partita_iva: PIVA.A, data_documento: '2026-10-01' },
      durcB: { tipo: 'durc', partita_iva: PIVA.B, scadenza: '2026-09-30' },
      posA: { tipo: 'pos', partita_iva: PIVA.A, cantiere: 'Piazza Galileo Ferraris 1, Genova' },
      chi: { tipo: 'dvr' },
      foto: { tipo: 'idoneita', persona: 'Mario Rossi', codice_fiscale_persona: mario.fiscal_code, scadenza: '2027-06-01' },
    });
    const pacchetto = await pdf(['DOC:durcA', 'DOC:prepLuca', 'DOC:formMario']);
    const zip = new AdmZip();
    zip.addFile('mail/visura.pdf', await pdf(['DOC:visuraA']));
    zip.addFile('mail/durc_bianchi.pdf', await pdf(['DOC:durcB']));
    zip.addFile('__MACOSX/._visura.pdf', Buffer.from('spazzatura'));
    const pos = await pdf(['DOC:posA']);

    const { id } = await K.crea(co.id, null, { subcontractorId: A.id });
    const o = { senzaLavoro: true };
    await K.aggiungi(co.id, id, { originalname: 'pacchetto.pdf', mimetype: 'application/pdf', buffer: pacchetto }, o);
    await K.aggiungi(co.id, id, { originalname: 'idoneita_mario.jpg', mimetype: 'image/png', buffer: PNG }, o);
    const z = await K.aggiungi(co.id, id, { originalname: 'documenti.zip', mimetype: 'application/zip', buffer: zip.toBuffer() }, o);
    check('lo ZIP si apre: 2 PDF, la spazzatura di macOS no', z.aggiunti === 2, z);
    await K.aggiungi(co.id, id, { originalname: 'pos.pdf', mimetype: 'application/pdf', buffer: pos }, o);
    await K.aggiungi(co.id, id, { originalname: 'pos (1).pdf', mimetype: 'application/pdf', buffer: pos }, o);
    await K.aggiungi(co.id, id, { originalname: 'chi.pdf', mimetype: 'application/pdf', buffer: await pdf(['DOC:chi']) }, o);
    await K.aggiungi(co.id, id, { originalname: 'IMG_0001.HEIC', mimetype: 'image/heic', buffer: Buffer.from('heic') }, o);
    const strano = await rifiuta(() => K.aggiungi(co.id, id, { originalname: 'fattura.xlsx', mimetype: 'application/vnd.ms-excel', buffer: Buffer.from('x') }, o));
    check('un file che non è PDF, foto o ZIP: rifiutato', strano?.code === 'TIPO_NON_VALIDO', strano?.code);

    await K.lavora(co.id, id, { chiedi: chiediFinto, dividi: dividiFinto });
    let s = await K.stato(co.id, id, { chiedi: chiediFinto, dividi: dividiFinto });
    const gA = s.imprese.find(g => g.id === A.id), gB = s.imprese.find(g => g.id === B.id);
    check('letti tutti: 8 file (lo ZIP ne vale 2), 9 documenti (il pacchetto diviso in 3)', s.avanzamento.finito && s.avanzamento.file === 8 && s.avanzamento.documenti === 9, s.avanzamento);
    check('Impianti Verdi: DURC, visura, POS del cantiere Galileo', ['durc', 'visura', 'pos'].every(t => gA?.documenti.some(d => d.tipo === t)) && gA.documenti.find(d => d.tipo === 'pos').siteId === site.id, gA?.documenti);
    check('Impianti Verdi › Mario Rossi: corso (5 anni) e visita dalla foto; Luca Gialli nuovo, preposto fino al 10/03/2028',
      gA?.operai.find(x => x.id === mario.id)?.documenti.map(d => d.tipo).sort().join(',') === 'formazione,idoneita'
      && gA.operai.find(x => x.nuovo)?.nome === 'Luca Gialli' && gA.operai.find(x => x.nuovo).documenti[0].scadenza === '2028-03-10', gA?.operai);
    check('Edil Bianchi: il DURC (scaduto) smistato da solo, anche partendo da Impianti Verdi', gB?.documenti[0]?.tipo === 'durc' && gB.documenti[0].esito === 'non_va', gB);
    check('il POS caricato due volte: un doppione', s.doppioni.length === 1 && /Uguale a/.test(s.doppioni[0].perche), s.doppioni);
    check('la foto HEIC tra i non letti, col perché', s.errori.some(e => /HEIC/.test(e.errore)), s.errori);
    check('dopo il salvataggio a Impianti Verdi mancherà la dichiarazione (il DVR senza nome è finito su di loro)', gA?.dopo && !gA.dopo.puoLavorare && gA.dopo.mancano.join(',') === 'Dichiarazione che non è sospesa', gA?.dopo);

    // Il DVR «chi.pdf» è stato messo su Impianti Verdi perché si è partiti dalla loro scheda: lo sposto su Edil Bianchi
    const dvr = gA.documenti.find(d => d.tipo === 'dvr');
    check('il DVR senza nome è andato sull\'impresa di partenza', !!dvr && dvr.come === 'scelta', gA.documenti);
    await K.correggi(co.id, id, dvr.id, { impresa: { id: B.id } });
    const nonValido = await rifiuta(() => K.correggi(co.id, id, dvr.id, { impresa: { id: '00000000-0000-0000-0000-000000000000' } }));
    check('correggi: un\'impresa che non è tua è rifiutata', nonValido?.code === 'IMPRESA_NON_VALIDA', nonValido?.code);
    const presto = await rifiuta(() => K.salva(altra.id, null, id));
    check('un\'altra azienda non vede il caricamento', presto?.status === 404);
    s = await K.stato(co.id, id);
    check('dopo la correzione il DVR è di Edil Bianchi', s.imprese.find(g => g.id === B.id)?.documenti.some(d => d.tipo === 'dvr'));
    check('…e a Impianti Verdi torna a mancare il DVR', s.imprese.find(g => g.id === A.id)?.dopo.mancano.join(',') === 'DVR o autocertificazione,Dichiarazione che non è sospesa', s.imprese.find(g => g.id === A.id)?.dopo);

    const r = await K.salva(co.id, null, id);
    check('salva: 8 documenti (il POS doppio no), 2 imprese, 1 operaio nuovo, ResultCard verificata', r.salvati === 8 && r.imprese.length === 2 && r.operaiNuovi === 1 && r.resultCard.fatto.verified, r);
    const { data: sd } = await supabase.from('subcontractor_documents').select('subcontractor_id, category, site_id, esito, valid_until').eq('company_id', co.id);
    check('nelle schede: DURC, visura, POS (col cantiere) di Impianti Verdi; DURC (non va) e DVR di Edil Bianchi',
      sd.filter(x => x.subcontractor_id === A.id).map(x => x.category).sort().join(',') === 'durc,pos,visura'
      && sd.find(x => x.category === 'pos').site_id === site.id
      && sd.filter(x => x.subcontractor_id === B.id).map(x => `${x.category}:${x.esito}`).sort().join(',') === 'durc:non_va,dvr:va_bene', sd);
    const { data: ops } = await supabase.from('sub_workers').select('id, full_name').eq('company_id', co.id);
    const { data: od } = await supabase.from('sub_worker_documenti').select('sub_worker_id, tipo, titolo, scadenza').eq('company_id', co.id);
    const luca = ops.find(x => x.full_name === 'Luca Gialli');
    check('operai: Luca Gialli creato col suo preposto; Mario con visita e corso', !!luca && od.some(x => x.sub_worker_id === luca.id && x.tipo === 'altro' && x.titolo === 'Corso preposto' && x.scadenza === '2028-03-10') && od.filter(x => x.sub_worker_id === mario.id).map(x => x.tipo).sort().join(',') === 'formazione,idoneita', { ops, od });
    const schedaA = await require('../lib/impreseLink').statoImpresa(co.id, { id: A.id, company_name: A.company_name, piva: A.piva });
    const lucaScheda = schedaA.operai.find(x => x.nome === 'Luca Gialli');
    check("nella scheda dell'impresa, sotto Luca Gialli, si vede il suo «Corso preposto» con la scadenza", lucaScheda?.altri?.[0]?.titolo === 'Corso preposto' && lucaScheda.altri[0].scadenza === '2028-03-10', lucaScheda);
    const { data: imp } = await supabase.from('subcontractors').select('id, durc_expiry').in('id', [A.id, B.id]);
    check('il DURC buono porta avanti la data di Impianti Verdi; quello scaduto di Edil Bianchi no', imp.find(x => x.id === A.id).durc_expiry === '2027-02-10' && !imp.find(x => x.id === B.id).durc_expiry, imp);
    const { data: resto } = await supabase.storage.from('site-documents').list(`${co.id}/caricamenti-imprese/${id}`);
    check('i file del caricamento sono cancellati', !(resto || []).length, resto);
    const due = await rifiuta(() => K.salva(co.id, null, id));
    check('salvare due volte: no', due?.code === 'GIA_SALVATO');
  } finally {
    const { data: sd } = await supabase.from('subcontractor_documents').select('file_path').eq('company_id', co.id);
    const { data: od } = await supabase.from('sub_worker_documenti').select('file_path').eq('company_id', co.id);
    const paths = [...(sd || []), ...(od || [])].map(x => x.file_path);
    if (paths.length) await supabase.storage.from('site-documents').remove(paths).catch(() => {});
    for (const t of ['sub_worker_documenti', 'imprese_caricamento_doc', 'imprese_caricamenti', 'subcontractor_documents', 'site_subcontractors', 'sub_workers', 'admin_audit_log']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('subcontractors').delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    await supabase.from('companies').delete().in('id', [co.id, altra.id]);
  }
}

(async () => {
  lettura();
  attribuzione();
  ordine();
  await db();
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
