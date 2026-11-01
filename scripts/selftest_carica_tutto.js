#!/usr/bin/env node
/**
 * scripts/selftest_carica_tutto.js — F-415 (AUDIT.md del frontend).
 *
 * «Carica un documento»: una porta sola. Oltre ai documenti dei subappaltatori
 * (F-401, scripts/selftest_imprese_carica.js) ci passano quelli della TUA impresa
 * e dei TUOI operai, e le bolle e le fatture dei fornitori:
 *  - DURC con la tua partita IVA → la tua impresa, da salvare (prima: scartato);
 *  - visita col codice fiscale di un tuo operaio → la sua scheda;
 *  - attestato di un tuo operaio solo per nome → la sua scheda;
 *  - visita della tua impresa per una persona che non è tra i tuoi operai →
 *    da guardare, MAI un operaio nuovo inventato nell'organico;
 *  - bolla e fattura con ragione sociale e P.IVA di un fornitore → bolle e
 *    fatture, MAI un subappaltatore nuovo; un «altro documento» nemmeno;
 *  - in ordine: un gruppo «La tua impresa» che si salva;
 *  - giro completo sul DB (modello finto): il DURC nei documenti dell'impresa
 *    con la data portata avanti, la visita nella scheda dell'operaio con la
 *    scadenza che guarda il badge, nessun subappaltatore inventato.
 */
'use strict';
require('dotenv').config();
const { pulisci } = require('../lib/impreseCarica/lettura');
const { attribuisci, NOSTRA } = require('../lib/impreseCarica/attribuisci');
const { ordina } = require('../lib/impreseCarica/ordina');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const { extractPdfText } = require('../lib/pdfExtract');
const K = require('../lib/impreseCarica');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const L = (x) => pulisci(x);
const PIVA = { noi: '01234567897', A: '09876543217', fornitore: '44455566671' };
const CTX = {
  oggi: '2026-10-31', pivaNostra: PIVA.noi, pre: null,
  imprese: [
    { id: NOSTRA, nome: 'MSC Edilizia Srl', piva: PIVA.noi, daCompletare: false, nostra: true },
    { id: 'A', nome: 'Impianti Verdi Srl', piva: PIVA.A, daCompletare: false },
  ],
  operai: [
    { id: 'n1', nome: 'Elton Lika', cf: 'LKILTN85A01Z100X', subId: NOSTRA },
    { id: 'n2', nome: 'Carlo Di Leonardo', cf: null, subId: NOSTRA },
    { id: 'a1', nome: 'Mario Rossi', cf: 'RSSMRA80A01D969A', subId: 'A' },
  ],
  cantieriPer: { [NOSTRA]: [{ id: 's9', nome: 'Via Balbi 31', indirizzo: 'Via Balbi 31, Genova' }], A: [] },
};

function attribuzione() {
  console.log('\n\x1b[1mF-415 — la tua impresa e i tuoi operai\x1b[0m');
  let p = attribuisci(L({ tipo: 'durc', partita_iva: PIVA.noi, ragione_sociale: 'MSC EDILIZIA SRL', data_documento: '2026-10-01' }), CTX);
  check('DURC con la TUA P.IVA → la tua impresa, va bene (prima: «non va», scartato)', p.impresa?.id === NOSTRA && p.esito === 'va_bene' && p.scadenza === '2027-01-29', p);
  p = attribuisci(L({ tipo: 'idoneita', persona: 'LIKA ELTON', codice_fiscale_persona: 'LKILTN85A01Z100X', scadenza: '2027-10-01' }), CTX);
  check('visita col codice fiscale di Elton Lika → la tua impresa, Elton Lika', p.impresa?.id === NOSTRA && p.operaio?.id === 'n1' && p.esito === 'va_bene', p);
  p = attribuisci(L({ tipo: 'formazione', persona: 'DI LEONARDO CARLO', data_documento: '2026-03-01' }), CTX);
  check('corso di «DI LEONARDO CARLO» senza codice fiscale → Carlo Di Leonardo, dal nome', p.impresa?.id === NOSTRA && p.operaio?.id === 'n2' && p.scadenza === '2031-03-01', p);
  p = attribuisci(L({ tipo: 'idoneita', persona: 'GINO SCONOSCIUTO', partita_iva: PIVA.noi, scadenza: '2027-10-01' }), CTX);
  check('visita con la tua P.IVA ma di una persona che non è tra i tuoi operai → da guardare, non si salva', p.impresa?.id === NOSTRA && !p.operaio?.id && p.esito === 'non_va' && p.motivo?.codice === 'operaio_non_trovato', p);
  p = attribuisci(L({ tipo: 'pos', partita_iva: PIVA.noi, cantiere: 'Via Balbi 31, 16126 Genova' }), CTX);
  check('il tuo POS per Via Balbi → il tuo cantiere', p.impresa?.id === NOSTRA && p.siteId === 's9', p);
  p = attribuisci(L({ tipo: 'idoneita', persona: 'ROSSI MARIO', codice_fiscale_persona: 'RSSMRA80A01D969A', scadenza: '2027-06-01' }), CTX);
  check('la visita di un operaio di Impianti Verdi resta a loro', p.impresa?.id === 'A' && p.operaio?.id === 'a1', p);

  console.log('\n\x1b[1mF-415 — bolle e fatture non sono imprese\x1b[0m');
  p = attribuisci(L({ tipo: 'bolla', partita_iva: PIVA.fornitore, ragione_sociale: 'EDILMATERIALI SRL', data_documento: '2026-10-30' }), CTX);
  check('una bolla di Edilmateriali → bolla, nessuna impresa (prima: «impresa nuova: la aggiungo»)', p.tipo === 'bolla' && p.impresa === null, p);
  p = attribuisci(L({ tipo: 'fattura', partita_iva: PIVA.fornitore, ragione_sociale: 'EDILMATERIALI SRL' }), CTX);
  check('una fattura di Edilmateriali → fattura, nessuna impresa', p.tipo === 'fattura' && p.impresa === null, p);
  p = attribuisci(L({ tipo: 'altro', partita_iva: PIVA.fornitore, ragione_sociale: 'NOLEGGI LIGURIA SRL' }), CTX);
  check('un «altro documento» di una ditta sconosciuta → mai un subappaltatore nuovo', !p.impresa?.nuova, p);
}

function ordine() {
  console.log('\n\x1b[1mF-415 — in ordine\x1b[0m');
  const doc = (id, letto) => ({ id, stato: 'pronto', nome_file: `${id}.pdf`, pagine: '1', content_hash: id, letto: L(letto), proposta: attribuisci(L(letto), CTX), gia: false });
  const o = ordina([
    doc('durc-nostro', { tipo: 'durc', partita_iva: PIVA.noi, data_documento: '2026-10-01' }),
    doc('visita-elton', { tipo: 'idoneita', codice_fiscale_persona: 'LKILTN85A01Z100X', persona: 'Lika Elton', scadenza: '2027-10-01' }),
    doc('visita-gino', { tipo: 'idoneita', persona: 'Gino Sconosciuto', partita_iva: PIVA.noi, scadenza: '2027-10-01' }),
    doc('bolla', { tipo: 'bolla', partita_iva: PIVA.fornitore, ragione_sociale: 'EDILMATERIALI SRL' }),
    doc('durc-a', { tipo: 'durc', partita_iva: PIVA.A, data_documento: '2026-10-01' }),
  ], CTX);
  const N = o.imprese.find(g => g.id === NOSTRA);
  check('un gruppo «La tua impresa» col DURC e la visita di Elton Lika', N?.nostra === true && N.documenti.some(d => d.id === 'durc-nostro') && N.operai[0]?.nome === 'Elton Lika', N);
  check('la visita di uno sconosciuto della tua impresa → da guardare, col motivo', o.daAssegnare.some(d => d.id === 'visita-gino' && /Gino Sconosciuto/.test(d.motivo || '')), o.daAssegnare);
  // F-422: la bolla va nel tuo unico cantiere (Via Balbi 31) e si salva lì
  check('la bolla tra le bolle, nel cantiere Via Balbi 31, da salvare (F-422)', o.bolle?.some(d => d.id === 'bolla' && d.bolla?.cantiere?.id === 's9') && o.daSalvare.includes('bolla'), o.bolle);
  check('si salvano DURC nostro, visita di Elton, DURC di Impianti Verdi e la bolla', [...o.daSalvare].sort().join(',') === ['bolla', 'durc-a', 'durc-nostro', 'visita-elton'].join(','), o.daSalvare);
  check('niente più «nostri» scartati', !o.nostri || o.nostri.length === 0, o.nostri);
}

async function pdf(t) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(t, { x: 40, y: 780, size: 12, font });
  return Buffer.from(await doc.save());
}
const RISPOSTE = {};
async function chiediFinto({ contenuto }) {
  const { text } = await extractPdfText(Buffer.from(contenuto[0].source.data, 'base64'), { maxPages: 2, minChars: 0 });
  return RISPOSTE[text.match(/DOC:(\w+)/)[1]];
}
const unoAllaVolta = async () => [{ da: 1, a: 1 }];
// chat_uploads vuole un utente vero: il titolare dell'azienda E2E
const UTENTE = 'a56d9d41-20aa-4b69-a5b9-913bf1707ac4';
const rifiuta = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function db() {
  console.log('\n\x1b[1mF-415 — giro completo sul DB (modello finto)\x1b[0m');
  const T = `TEST-F415-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T, piva: PIVA.noi });
  try {
    const cf = `LKILTN85A01Z1${String(Date.now()).slice(-2)}X`.slice(0, 16);
    const elton = await ins('workers', { company_id: co.id, first_name: 'Elton', last_name: 'Lika', full_name: 'Elton Lika', fiscal_code: cf, is_active: true, badge_code: `T415E${Date.now()}` });
    const carlo = await ins('workers', { company_id: co.id, first_name: 'Carlo', last_name: 'Bianco', full_name: 'Carlo Bianco', is_active: true, badge_code: `T415C${Date.now()}` });
    Object.assign(RISPOSTE, {
      durc: { tipo: 'durc', partita_iva: PIVA.noi, ragione_sociale: T, data_documento: '2026-10-01' },
      visita: { tipo: 'idoneita', persona: 'LIKA ELTON', codice_fiscale_persona: cf, scadenza: '2027-10-01', ragione_sociale: T },
      chi: { tipo: 'idoneita', persona: 'CARLETTO B.', partita_iva: PIVA.noi, scadenza: '2027-09-01' },
      bolla: { tipo: 'bolla', partita_iva: PIVA.fornitore, ragione_sociale: 'EDILMATERIALI SRL', data_documento: '2026-10-30' },
    });
    const { id } = await K.crea(co.id, UTENTE, {});
    const o = { senzaLavoro: true };
    for (const k of Object.keys(RISPOSTE)) await K.aggiungi(co.id, id, { originalname: `${k}.pdf`, mimetype: 'application/pdf', buffer: await pdf(`DOC:${k} ${T}`) }, o);
    await K.lavora(co.id, id, { chiedi: chiediFinto, dividi: unoAllaVolta });
    let s = await K.stato(co.id, id, { chiedi: chiediFinto, dividi: unoAllaVolta });
    const N = s.imprese.find(g => g.nostra);
    check('«La tua impresa»: il DURC e la visita di Elton Lika', N?.nome === 'La tua impresa' && N.documenti.some(d => d.tipo === 'durc') && N.operai.find(x => x.id === elton.id)?.documenti[0]?.tipo === 'idoneita', s.imprese);
    check('la bolla tra le bolle, nessuna impresa nuova', s.bolle.length === 1 && !s.imprese.some(g => g.nuova), { bolle: s.bolle, imprese: s.imprese });
    const chi = s.daAssegnare.find(d => d.persona === 'Carletto B.');
    check('la visita di «Carletto B.» da guardare: non trovo chi è', !!chi && /Carletto B\./.test(chi.motivo || ''), s.daAssegnare);
    check('tra le scelte: la tua impresa e i tuoi operai', s.opzioni.imprese[0]?.id === NOSTRA && s.opzioni.imprese[0].nome === 'La tua impresa' && s.opzioni.operaiPer[NOSTRA]?.length === 2, s.opzioni);
    const nuovo = await rifiuta(() => K.correggi(co.id, id, chi.id, { operaio: { nuovo: { nome: 'Carletto Bianco' } } }));
    check('un operaio nuovo della tua impresa non si inventa da qui', nuovo?.code === 'OPERAIO_NON_VALIDO', nuovo?.code);
    await K.correggi(co.id, id, chi.id, { operaio: { id: carlo.id } });
    s = await K.stato(co.id, id);
    check('scelto Carlo Bianco: la visita va nella sua scheda', s.imprese.find(g => g.nostra)?.operai.some(x => x.id === carlo.id), s.imprese);

    const r = await K.salva(co.id, UTENTE, id);
    check('salva: 3 documenti per la tua impresa, verificati', r.salvati === 3 && r.imprese[0]?.id === NOSTRA && r.resultCard.fatto.verified && /per la tua impresa/.test(r.resultCard.fatto.after), r);
    const { data: cd } = await supabase.from('company_documents').select('category, ai_expiry_date').eq('company_id', co.id);
    check("il DURC nei documenti dell'impresa, con la scadenza", cd?.length === 1 && cd[0].category === 'durc' && cd[0].ai_expiry_date === '2027-01-29', cd);
    const { data: wd } = await supabase.from('worker_documents').select('worker_id, doc_type, expiry_date').eq('company_id', co.id);
    check('le visite nelle schede di Elton e Carlo', wd?.length === 2 && wd.every(x => x.doc_type === 'idoneita_medica') && wd.some(x => x.worker_id === elton.id && x.expiry_date === '2027-10-01') && wd.some(x => x.worker_id === carlo.id), wd);
    const { data: w } = await supabase.from('workers').select('health_fitness_expiry').eq('id', elton.id).single();
    check('la scadenza della visita sulla scheda di Elton (quella che guarda il badge)', String(w.health_fitness_expiry).slice(0, 10) === '2027-10-01', w);
    const { data: c2 } = await supabase.from('companies').select('durc_expiry').eq('id', co.id).single();
    check('la data del DURC della tua impresa portata avanti', String(c2.durc_expiry).slice(0, 10) === '2027-01-29', c2);
    const { count } = await supabase.from('subcontractors').select('id', { count: 'exact', head: true }).eq('company_id', co.id);
    check('nessun subappaltatore creato (né la tua impresa, né Edilmateriali)', count === 0, count);
    const { data: resto } = await supabase.storage.from('site-documents').list(`${co.id}/caricamenti-imprese/${id}`);
    check('i file del caricamento sono cancellati', !(resto || []).length, resto);
  } finally {
    const { data: f1 } = await supabase.from('company_documents').select('file_path').eq('company_id', co.id);
    const { data: f2 } = await supabase.from('worker_documents').select('file_path').eq('company_id', co.id);
    const paths = [...(f1 || []), ...(f2 || [])].map(x => x.file_path).filter(Boolean);
    if (paths.length) await supabase.storage.from('site-documents').remove(paths).catch(() => {});
    for (const t of ['worker_certificates', 'worker_documents', 'company_documents', 'documents', 'chat_uploads', 'imprese_caricamento_doc', 'imprese_caricamenti', 'ladia_action_history', 'admin_audit_log', 'notifications']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('workers').delete().eq('company_id', co.id);
    const { error } = await supabase.from('companies').delete().eq('id', co.id);
    if (error) console.error('pulizia azienda di prova:', error.message);
  }
}

(async () => {
  attribuzione();
  ordine();
  await db();
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})();
