#!/usr/bin/env node
/**
 * scripts/selftest_buste_carica.js — F-399 (AUDIT.md del frontend).
 *
 * «Carica le buste del mese»: il PDF unico del commercialista diviso una busta
 * per operaio, senza AI, dal codice fiscale scritto su ogni pagina.
 *  - pagine consecutive della stessa persona = una busta; seconda pagina senza
 *    intestazione attaccata alla precedente;
 *  - prospetti e riepiloghi all'azienda anche se nominano un operaio;
 *  - un codice fiscale che non è di nessuno → «da guardare», col nome che somiglia;
 *  - il mese letto dal file; una scansione senza testo rifiutata;
 *  - alla conferma: una busta per operaio, mandata, con le pagine giuste;
 *    riepilogo in Documenti; chi l'aveva già firmata la deve rifirmare;
 *    il file caricato si cancella; due volte no.
 * Se c'è scripts/../scratch/CI10119_original.pdf (il file vero di MSC, non nel
 * repo) prova anche quello: 17 buste, pagine 31-51 all'azienda.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');
const { dividi, paginaPerPagina } = require('../lib/bustePaga/dividi');
const B = require('../lib/bustePaga');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const rifiuta = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const CF = { A: 'RSSMRA80A01D969A', B: 'BNCLGU85B02D969B', C: 'VRDPLA75C12D969C', D: 'NRIGNN90D03D969D' };
const busta = (nome, cf, mese = 'SETTEMBRE 2026') => `DITTA PROVA EDILE SRL PERIODO DI LIQUIDAZIONE ${mese}\nCODICE FISCALE 01234567897\nDIPENDENTE ${nome}\nCODICE FISCALE ${cf}\nELEMENTI DELLA RETRIBUZIONE Paga base 1.850,00 Netto in busta 1.640,00`;
const PAGINE = [
  busta('ROSSI MARIO', CF.A), busta('ROSSI MARIO', CF.A),                                   // 1-2 A
  busta('BIANCHI LUIGI', CF.B), 'Segue: trattenute e ritenute del mese, totale competenze 2.100,00', // 3-4 B (+ continuazione)
  busta('VERDI PAOLO', 'VRDPLA75C12D969X'),                                                  // 5 sconosciuta, somiglia a C
  `PROSPETTO DETTAGLIO FONDI SETTEMBRE 2026\n${CF.A} quota TFR 120,00`,                    // 6 riepilogo con un CF noto
  `DIPENDENTI (NORM) SETTEMBRE 2026 ${CF.A} ${CF.B} totali ditta`,                           // 7 riepilogo
];

async function pdfDa(testi) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of testi) {
    const p = doc.addPage([595, 842]);
    t.split('\n').forEach((riga, i) => p.drawText(riga, { x: 40, y: 800 - i * 16, size: 10, font }));
  }
  return Buffer.from(await doc.save());
}

function puri() {
  console.log('\n\x1b[1mF-399 — divisione delle buste (senza AI)\x1b[0m');
  const ws = [
    { id: 'a', nome: 'Mario Rossi', cf: CF.A, attivo: true }, { id: 'b', nome: 'Luigi Bianchi', cf: CF.B, attivo: true },
    { id: 'c', nome: 'Paolo Verdi', cf: CF.C, attivo: true }, { id: 'd', nome: 'Gianni Neri', cf: CF.D, attivo: true },
  ];
  const r = dividi(PAGINE.map((testo, i) => ({ n: i + 1, testo })), ws);
  const s = r.segmenti;
  check('pagine 1-2: una busta sola, di Mario Rossi', s[0].da === 1 && s[0].a === 2 && s[0].tipo === 'busta' && s[0].workerId === 'a', s[0]);
  check('pagina 4 senza intestazione: attaccata alla busta di Luigi (3-4)', s[1].da === 3 && s[1].a === 4 && s[1].workerId === 'b', s[1]);
  check('pagina 5: codice fiscale di nessuno → da guardare, somiglia a Paolo Verdi', s[2].tipo === 'sconosciuta' && s[2].cf === 'VRDPLA75C12D969X' && s[2].suggerito?.id === 'c', s[2]);
  check('prospetto con il CF di un operaio e riepilogo con molti CF → all\'azienda (6-7)', s[3].tipo === 'riepilogo' && s[3].da === 6 && s[3].a === 7 && s.length === 4, s);
  check('il mese letto dal file: settembre 2026', r.periodo?.anno === 2026 && r.periodo?.mese === 9, r.periodo);
  check('un abbinamento richiede il codice fiscale intero (16 caratteri)', dividi([{ n: 1, testo: busta('ROSSI MARIO', CF.A.slice(0, 15)) }], ws).segmenti[0].tipo !== 'busta');
  check('una scansione senza testo è riconosciuta', dividi([{ n: 1, testo: '' }, { n: 2, testo: ' ' }], ws).senzaTesto === true);
  const pp = paginaPerPagina('--- Pagina 2 ---\nciao\n--- Pagina 3 ---\nmondo', 3);
  check('paginaPerPagina: le pagine vuote restano al loro posto', pp[0].testo === '' && pp[1].testo.trim() === 'ciao' && pp[2].testo.trim() === 'mondo', pp);
}

async function vero() {
  const file = path.join(__dirname, '..', 'scratch', 'CI10119_original.pdf');
  if (!fs.existsSync(file)) { console.log('  – file vero di MSC non presente: saltato'); return; }
  const { extractPdfText } = require('../lib/pdfExtract');
  const { text, numPages } = await extractPdfText(fs.readFileSync(file), { maxPages: 400, minChars: 0 });
  const { data: ws } = await supabase.from('workers').select('id, full_name, fiscal_code, is_active').eq('company_id', '309e9018-1bcc-4876-9430-99cb89e043dd');
  const r = dividi(paginaPerPagina(text, numPages), ws.map(w => ({ id: w.id, nome: w.full_name, cf: w.fiscal_code, attivo: w.is_active })));
  const buste = r.segmenti.filter(x => x.tipo === 'busta');
  const ultimo = r.segmenti[r.segmenti.length - 1];
  check('file vero di MSC: 17 buste, pagine 31-51 all\'azienda, agosto 2026', buste.length === 17 && ultimo.tipo === 'riepilogo' && ultimo.da === 31 && ultimo.a === 51 && r.periodo?.mese === 8, r.segmenti.map(x => `${x.da}-${x.a}:${x.tipo}`));
}

async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function db() {
  console.log('\n\x1b[1mF-399 — carica e manda, contro il DB\x1b[0m');
  const T = `TEST-F399-${Date.now()}`;
  const co = await ins('companies', { name: T });
  const altra = await ins('companies', { name: `${T}-altra` });
  const paths = [];
  try {
    const stamp = String(Date.now()).slice(-6);
    const mk = (nome, cf, attivo = true) => ins('workers', { company_id: co.id, full_name: nome, fiscal_code: cf, is_active: attivo, badge_code: `F399${cf.slice(0, 4)}${stamp}` });
    const A = await mk('Mario Rossi', CF.A), Bw = await mk('Luigi Bianchi', CF.B), C = await mk('Paolo Verdi', CF.C), D = await mk('Gianni Neri', CF.D);
    const estraneo = await ins('workers', { company_id: altra.id, full_name: 'Estraneo', fiscal_code: 'XXXYYY80A01D969Z', is_active: true, badge_code: `F399X${stamp}` });
    // Mario aveva già la busta di settembre, firmata
    await ins('payslips', { company_id: co.id, worker_id: A.id, period_year: 2026, period_month: 9, filename: 'vecchia.pdf', file_path: `payslips/${co.id}/${A.id}/2026-09.pdf`, status: 'acknowledged', acknowledged_at: new Date().toISOString() });

    const pdf = await pdfDa(PAGINE);
    const r = await B.leggi(co.id, null, { buffer: pdf, originalname: 'buste_settembre.pdf' });
    const { data: row } = await supabase.from('buste_caricamenti').select('file_path').eq('id', r.id).single();
    paths.push(row.file_path);
    check('leggi: 7 pagine, settembre 2026 letto dal file', r.pagine === 7 && r.periodo.anno === 2026 && r.periodo.mese === 9 && r.periodoLetto, { pagine: r.pagine, periodo: r.periodo });
    check('leggi: le buste divise come nel PDF vero (A 1-2, B 3-4, da guardare 5, azienda 6-7)', r.segmenti.map(x => `${x.da}-${x.a}:${x.tipo}`).join(' ') === '1-2:busta 3-4:busta 5-5:sconosciuta 6-7:riepilogo', r.segmenti);
    check('leggi: Mario ha già la busta di settembre, firmata', r.esistenti.length === 1 && r.esistenti[0].workerId === A.id && r.esistenti[0].firmata, r.esistenti);
    check('leggi: chi lavora qui ma non è nel file (Paolo, Gianni)', r.senzaBusta.map(x => x.nome).sort().join(',') === 'Gianni Neri,Paolo Verdi', r.senzaBusta);
    const prima = await supabase.from('payslips').select('id').eq('company_id', co.id);
    check('leggi: non manda niente', prima.data.length === 1);
    const ott = await B.esistentiPer(co.id, r.id, { anno: 2026, mese: 10 });
    check('esistenti: per ottobre nessuno ha già la busta', ott.length === 0, ott);

    const fuori = await rifiuta(() => B.conferma(co.id, null, r.id, { anno: 2026, mese: 9, assegna: { 2: estraneo.id } }));
    check('conferma: un operaio di un\'altra azienda è rifiutato', fuori?.code === 'OPERAIO_NON_VALIDO', fuori?.code);
    const altraCo = await rifiuta(() => B.conferma(altra.id, null, r.id, { anno: 2026, mese: 9 }));
    check('conferma: un\'altra azienda non vede il caricamento', altraCo?.status === 404);

    const c = await B.conferma(co.id, null, r.id, { anno: 2026, mese: 9, assegna: { 2: C.id } });
    const { data: ps } = await supabase.from('payslips').select('worker_id, status, file_path, acknowledged_at, period_month').eq('company_id', co.id).eq('period_year', 2026).eq('period_month', 9);
    paths.push(...ps.map(p => p.file_path));
    check('conferma: 3 buste mandate (Mario, Luigi, e Paolo scelto per la pagina 5)', c.mandate === 3 && ps.length === 3 && ps.every(p => p.status === 'shared') && new Set(ps.map(p => p.worker_id)).size === 3 && ps.some(p => p.worker_id === C.id), ps);
    check('conferma: Mario la deve rifirmare (la busta è cambiata)', ps.find(p => p.worker_id === A.id)?.acknowledged_at === null);
    const pagine = async (wid) => { const f = await supabase.storage.from('site-documents').download(ps.find(p => p.worker_id === wid).file_path); return (await PDFDocument.load(Buffer.from(await f.data.arrayBuffer()))).getPageCount(); };
    check('conferma: pagine giuste (Mario 2, Luigi 2, Paolo 1)', await pagine(A.id) === 2 && await pagine(Bw.id) === 2 && await pagine(C.id) === 1);
    const { data: docs } = await supabase.from('company_documents').select('name, file_path').eq('company_id', co.id);
    paths.push(...(docs || []).map(d => d.file_path));
    check('conferma: prospetti e riepiloghi in Documenti › Impresa', docs?.length === 1 && /Settembre 2026 — prospetti e riepiloghi/.test(docs[0].name) && c.riepilogo, docs);
    check('conferma: ResultCard verificata, «ognuno la trova nel suo badge»', c.resultCard.fatto.verified && /3 buste mandate/.test(c.resultCard.fatto.after), c.resultCard);
    // L'elenco della cartella, non download(): lo storage risponde dalla cache (max-age 3600)
    const { data: rimasti } = await supabase.storage.from('site-documents').list(`payslips/${co.id}/_caricamenti`);
    check('conferma: il file caricato è cancellato', !(rimasti || []).some(f => row.file_path.endsWith(f.name)), rimasti);
    const due = await rifiuta(() => B.conferma(co.id, null, r.id, { anno: 2026, mese: 9 }));
    check('conferma due volte: rifiutata', due?.code === 'GIA_MANDATE', due?.code);
    check('Gianni (non nel file) non riceve niente', !ps.some(p => p.worker_id === D.id));

    const scans = await rifiuta(async () => B.leggi(co.id, null, { buffer: await pdfDa(['', '']), originalname: 'scan.pdf' }));
    check('una scansione senza testo: chiede il PDF originale', scans?.code === 'SCANSIONE', scans?.code);
    const rotto = await rifiuta(() => B.leggi(co.id, null, { buffer: Buffer.from('non sono un pdf'), originalname: 'x.pdf' }));
    check('un file rotto: rifiutato', rotto?.code === 'PDF_ROTTO', rotto?.code);
  } finally {
    if (paths.length) await supabase.storage.from('site-documents').remove(paths.filter(Boolean)).catch(() => {});
    for (const t of ['payslips', 'buste_caricamenti', 'company_documents', 'admin_audit_log']) await supabase.from(t).delete().in('company_id', [co.id, altra.id]);
    await supabase.from('workers').delete().in('company_id', [co.id, altra.id]);
    await supabase.from('companies').delete().in('id', [co.id, altra.id]);
  }
}

(async () => {
  puri();
  await vero();
  await db();
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
