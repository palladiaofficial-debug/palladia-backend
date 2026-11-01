#!/usr/bin/env node
/**
 * scripts/selftest_pronto_subappalto.js — F-421 (AUDIT.md del frontend).
 *
 * «Pronta a lavorare», fase 3: TU, quando lavori per un'altra impresa. Sul DB vero:
 *  - regole pure: patente che manca, SOA classe III che esenta, visura più vecchia di 6 mesi,
 *    DURC dal profilo; le cose che mancano raggruppate («Visita medica di Elton Lika»);
 *  - la patente e la dichiarazione della tua impresa ora si possono salvare (CHECK, migrazione 265);
 *  - statoTuo: un operaio con la visita scaduta → non sei pronto, e si dice di chi;
 *  - il link per un'impresa con il solo operaio in regola → «pronto»; mostra i tuoi documenti e
 *    quelli dell'operaio scelto, MAI quelli di un operaio non scelto (nemmeno chiedendoli per chiave);
 *  - un file si apre con un link firmato; «Scarica tutto» è un PDF con copertina + documenti;
 *  - il link spento risponde «non più disponibile»; un token inventato non trova niente.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const P = require('../lib/prontoSubappalto');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const OGGI = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const tra = (g) => { const x = new Date(`${OGGI}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + g); return x.toISOString().slice(0, 10); };
const rifiuta = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
async function pdfFinto(t) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText(t, { x: 40, y: 780, size: 12, font: f });
  return Buffer.from(await d.save());
}

function puri() {
  console.log('\n\x1b[1mF-421 — le regole della tua impresa\x1b[0m');
  const doc = (extra = {}) => ({ id: 'x', created_at: `${tra(-10)}T10:00:00Z`, ...extra });
  let r = P.requisitiImpresa({ durc: doc(), visura: doc(), dvr: doc(), dichiarazione: doc() }, { durc_expiry: tra(90) }, OGGI);
  check('senza patente: «Patente a crediti» manca; DURC fino alla data del profilo', r.find(x => x.key === 'patente').stato === 'manca' && r.find(x => x.key === 'durc').scadenza === tra(90), r);
  r = P.requisitiImpresa({ durc: doc(), visura: doc(), dvr: doc(), dichiarazione: doc() }, { durc_expiry: tra(90), soa_classifica: 'III', soa_expiry: tra(400) }, OGGI);
  check('con una SOA classe III valida: patente «esente (SOA classe III)»', r[0].stato === 'ok' && /esente \(SOA classe III\)/.test(r[0].label), r[0]);
  r = P.requisitiImpresa({ visura: doc({ created_at: `${tra(-200)}T10:00:00Z` }) }, {}, OGGI);
  check('visura caricata 200 giorni fa → «vecchia»', r.find(x => x.key === 'visura').stato === 'vecchia', r.find(x => x.key === 'visura'));
  const v = P.verdettoTuo(r, [
    { id: 'a', nome: 'Elton Lika', idoneita: { stato: 'scaduto' }, formazione: { stato: 'ok' } },
    { id: 'b', nome: 'Festim Dervishaj', idoneita: { stato: 'manca' }, formazione: { stato: 'ok' } },
  ]);
  check('due operai senza visita → una cosa sola «Visita medica di 2 operai», con i nomi', v.stato === 'no' && v.cose.some(c => c.label === 'Visita medica di 2 operai' && c.nomi.join() === 'Elton Lika,Festim Dervishaj'), v.cose);
}

async function db() {
  console.log('\n\x1b[1mF-421 — sul DB\x1b[0m');
  const T = `TEST-F421-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T, piva: '01234567897', durc_expiry: tra(90), legale_rappresentante: 'Mario Bianchi' });
  const paths = [];
  const carica = async (nome) => { const path = `${co.id}/test-f421/${nome}.pdf`; await supabase.storage.from('site-documents').upload(path, await pdfFinto(`${T} ${nome}`), { contentType: 'application/pdf', upsert: true }); paths.push(path); return path; };
  try {
    for (const cat of ['patente_crediti', 'durc', 'visura', 'dvr', 'dichiarazione_art14']) {
      await ins('company_documents', { company_id: co.id, name: cat, category: cat, file_path: await carica(cat), mime_type: 'application/pdf', file_size: 900, ai_expiry_date: cat === 'durc' ? tra(90) : null });
    }
    check('la patente a crediti e la dichiarazione della tua impresa si salvano (migrazione 265)', true);
    const lika = await ins('workers', { company_id: co.id, first_name: 'Elton', last_name: 'Lika', full_name: 'Elton Lika', is_active: true, badge_code: `T421A${Date.now()}`, health_fitness_expiry: tra(-3), safety_training_expiry: tra(400) });
    const carlo = await ins('workers', { company_id: co.id, first_name: 'Carlo', last_name: 'Di Leonardo', full_name: 'Carlo Di Leonardo', is_active: true, badge_code: `T421B${Date.now()}`, health_fitness_expiry: tra(200), safety_training_expiry: tra(400) });
    await ins('worker_documents', { company_id: co.id, worker_id: carlo.id, name: 'Visita medica', doc_type: 'idoneita_medica', file_path: await carica('idoneita-carlo'), mime_type: 'application/pdf', expiry_date: tra(200) });
    await ins('worker_documents', { company_id: co.id, worker_id: lika.id, name: 'Visita medica', doc_type: 'idoneita_medica', file_path: await carica('idoneita-lika'), mime_type: 'application/pdf', expiry_date: tra(-3) });

    const st = await P.statoTuo(co.id);
    check('Elton Lika con la visita scaduta → non sei pronto: «Visita medica di Elton Lika»', st.stato === 'no' && st.cose.length === 1 && st.cose[0].label === 'Visita medica di Elton Lika', st.cose);
    check('la tua impresa ha tutto: patente, DURC, visura, DVR, dichiarazione', st.impresa.every(r => r.stato === 'ok' || r.stato === 'in_scadenza'), st.impresa.map(r => `${r.key}:${r.stato}`));

    const nuovo = await P.crea(co.id, null, { destinatario: 'Rossi Costruzioni', cantiere: 'Via Roma 10, Genova', operai: [carlo.id] });
    const token = nuovo.url.split('/').pop();
    check('il link per Rossi Costruzioni, col solo Carlo: «pronto», messaggio con il link', nuovo.verdetto.stato === 'si' && nuovo.testo.includes(nuovo.url) && /Via Roma 10/.test(nuovo.testo), nuovo);
    const pub = await P.pubblico(token);
    check('chi apre il link vede la tua impresa, Rossi Costruzioni, il cantiere e «in regola»', pub.azienda === T && pub.destinatario === 'Rossi Costruzioni' && pub.cantiere === 'Via Roma 10, Genova' && pub.stato === 'si', pub);
    check('…i tuoi 5 documenti e il giudizio di idoneità di Carlo, niente di Elton Lika', ['i-patente', 'i-durc', 'i-visura', 'i-dvr', 'i-dichiarazione', `o-${carlo.id}-idoneita`].every(k => pub.documenti.some(d => d.chiave === k)) && !pub.documenti.some(d => /Lika/.test(d.label)), pub.documenti.map(d => d.chiave));
    const f = await P.file(token, 'i-durc');
    check('un documento si apre con un link firmato', /^https:\/\/.+token=/.test(f.url), f);
    const spia = await rifiuta(() => P.file(token, `o-${lika.id}-idoneita`));
    check('il documento di un operaio NON scelto non si apre, nemmeno chiedendolo per chiave', spia?.status === 404, spia?.code);
    const tutto = await P.pdf(token);
    const letto = await PDFDocument.load(tutto.buffer);
    check('«Scarica tutto»: un PDF con la copertina e i 6 documenti (7 pagine)', tutto.buffer.slice(0, 4).toString() === '%PDF' && letto.getPageCount() === 7, letto.getPageCount());
    const el = await P.elenco(co.id);
    check('il link è nell\'elenco, già aperto', el.length === 1 && el[0].destinatario === 'Rossi Costruzioni' && !!el[0].aperto, el);
    await P.spegni(co.id, nuovo.id);
    const spento = await rifiuta(() => P.pubblico(token));
    check('spento: «non più disponibile» (410)', spento?.status === 410 && spento.code === 'SPENTO', spento?.code);
    const inventato = await rifiuta(() => P.pubblico('abcdefghijklmnopqrstuvwxyz123456'));
    check('un token inventato non trova niente (404)', inventato?.status === 404, inventato?.code);
    const dest = await rifiuta(() => P.crea(co.id, null, { destinatario: '' }));
    check('senza il nome dell\'impresa non si crea', dest?.code === 'DESTINATARIO', dest?.code);
  } finally {
    if (paths.length) await supabase.storage.from('site-documents').remove(paths);
    for (const t of ['pacchetti_documenti', 'worker_documents', 'worker_certificates', 'company_documents', 'documents']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('workers').delete().eq('company_id', co.id);
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
