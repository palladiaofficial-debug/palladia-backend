#!/usr/bin/env node
/**
 * scripts/selftest_documenti_semplici.js — F-316 (AUDIT.md), Documenti senza cartelle.
 *
 * Il titolare deve vedere chi è in regola e cosa gli manca, ogni documento in
 * un posto solo. Questo test rifà i casi trovati sui dati reali:
 *   - lavoratore senza visita medica: "manca" (prima non compariva da nessuna parte)
 *   - un rinnovo sostituisce il documento vecchio (non resta "scaduto")
 *   - la data del campo del lavoratore vale se più lontana del documento
 *   - le buste paga non sono tra i documenti (restano in Buste paga)
 *   - mezzo su strada senza assicurazione: "manca"; gru: nessun requisito;
 *     revisione senza data nota: non è "manca"
 *   - caricamento: la scadenza confermata porta avanti il campo del
 *     proprietario, mai indietro; un'altra azienda non si tocca; solo PDF/foto
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { riepilogo, elenco, scheda } = require('../lib/documentiStato');
const { carica } = require('../lib/documentiCarica');
const { romeDate, addDays } = require('../lib/daFare');

let passed = 0, failed = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const T = `TEST-F316-${Date.now()}`;
const today = romeDate();
const d = n => addDays(today, n);
const PDF = { buffer: Buffer.from('%PDF-1.4\n%test F-316\n'), mimetype: 'application/pdf', originalname: 'visita.pdf', size: 24 };

async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
async function rejects(name, p, code) {
  try { await p; fail(name, 'nessun errore'); } catch (e) { check(name, e.code === code, e.code || e.message); }
}

async function main() {
  console.log('\n\x1b[1mF-316 — Documenti senza cartelle: cosa serve, cosa manca, un solo caricamento\x1b[0m');
  const company = await ins('companies', { name: T });
  const other = await ins('companies', { name: `${T}-altra` });
  const cid = company.id;
  const paths = [];
  try {
    const mk = (n, extra) => ins('workers', { company_id: cid, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F316${n}${Date.now()}`.slice(0, 16), badge_code: `F316${n}${Date.now()}`, ...extra });
    const senzaVisita = await mk('Aldo', { safety_training_expiry: d(400) });
    const rinnovato = await mk('Bice', { safety_training_expiry: d(400), health_fitness_expiry: d(-20) });
    const campoPiuLontano = await mk('Carlo', { safety_training_expiry: d(400), health_fitness_expiry: d(500) });
    await ins('worker_documents', { company_id: cid, worker_id: rinnovato.id, doc_type: 'idoneita_medica', name: 'Idoneità 2025', file_path: `test/${T}/b1.pdf`, expiry_date: d(-20) });
    await ins('worker_documents', { company_id: cid, worker_id: rinnovato.id, doc_type: 'idoneita_medica', name: 'Idoneità 2026', file_path: `test/${T}/b2.pdf`, expiry_date: d(340) });
    await ins('worker_documents', { company_id: cid, worker_id: campoPiuLontano.id, doc_type: 'idoneita_medica', name: 'Idoneità vecchia', file_path: `test/${T}/c.pdf`, expiry_date: d(10) });
    await ins('worker_documents', { company_id: cid, worker_id: rinnovato.id, doc_type: 'antincendio', name: 'Antincendio', file_path: `test/${T}/b3.pdf`, expiry_date: d(-3) });
    await ins('payslips', { company_id: cid, worker_id: rinnovato.id, period_year: 2026, period_month: 9, filename: 'cedolino.pdf', file_path: `payslips/${cid}/${rinnovato.id}/2026-09.pdf`, status: 'draft' });
    const furgone = await ins('equipment', { company_id: cid, type: 'Autocarro', model: `${T} Porter`, ownership: 'Aziendale', is_active: true });
    const gru = await ins('equipment', { company_id: cid, type: 'Gru a torre', model: `${T} Potain`, ownership: 'Aziendale', is_active: true });
    const wOther = await ins('workers', { company_id: other.id, full_name: `${T} Estraneo`, is_active: true, fiscal_code: `F316X${Date.now()}`.slice(0, 16), badge_code: `F316X${Date.now()}`, health_fitness_expiry: d(-1) });

    // ── Stato ──
    const sA = await scheda(cid, 'lavoratori', senzaVisita.id);
    const visitaA = sA.requirements.find(r => r.key === 'idoneita');
    check('senza visita medica: requisito "manca"', visitaA?.state === 'manca' && sA.state === 'manca', sA.requirements);

    const sB = await scheda(cid, 'lavoratori', rinnovato.id);
    const visitaB = sB.requirements.find(r => r.key === 'idoneita');
    check('rinnovo: vale la visita più recente (in regola)', visitaB?.state === 'in_regola' && visitaB.expiry === d(340), visitaB);
    check('rinnovo: il documento da aprire è quello nuovo', visitaB?.doc?.name === 'Idoneità 2026', visitaB?.doc);
    check('le due visite non ricompaiono tra gli altri documenti', !sB.documents.some(x => x.label === 'Visita medica'), sB.documents);
    check('antincendio scaduto tra gli altri documenti, con download', sB.documents.some(x => x.label === 'Corso antincendio' && x.state === 'scaduto' && x.download), sB.documents);
    check('la busta paga NON è tra i documenti', !sB.documents.some(x => /busta|cedolino/i.test(`${x.label} ${x.name}`)), sB.documents);
    check('un documento altro scaduto rende il lavoratore da sistemare', sB.state === 'scaduto' && sB.worst?.label === 'Corso antincendio', sB.worst);

    const sC = await scheda(cid, 'lavoratori', campoPiuLontano.id);
    check('campo più lontano del documento: vale il campo', sC.requirements.find(r => r.key === 'idoneita')?.expiry === d(500), sC.requirements);

    const list = await elenco(cid, 'lavoratori');
    check('elenco: chi ha problemi viene prima di chi è in regola', list.at(-1)?.id === campoPiuLontano.id && list.at(-1).state === 'in_regola', list.map(x => [x.name, x.state]));
    check('elenco di un\'altra azienda: il suo lavoratore non c\'è', !list.some(x => x.id === wOther.id));

    const sF = await scheda(cid, 'mezzi', furgone.id);
    check('furgone senza assicurazione: "manca"', sF.requirements.find(r => r.key === 'assicurazione')?.state === 'manca', sF.requirements);
    check('revisione senza data nota: non è un requisito mancante', !sF.requirements.some(r => r.key === 'revisione'), sF.requirements);
    const sG = await scheda(cid, 'mezzi', gru.id);
    check('gru: nessun requisito da veicolo', sG.requirements.length === 0 && sG.state === 'in_regola', sG);

    const sum = await riepilogo(cid);
    const lav = sum.find(s => s.kind === 'lavoratori');
    check('riepilogo: 3 lavoratori, 2 da sistemare', lav?.total === 3 && lav.problems === 2, lav);
    check('riepilogo: subappaltatori nascosti se il modulo è spento', !sum.some(s => s.kind === 'subappaltatori'), sum.map(s => s.kind));
    check('scheda di un lavoratore di un\'altra azienda: non trovata', (await scheda(cid, 'lavoratori', wOther.id)) === null);

    // ── Caricamento ──
    const up = await carica({ companyId: cid, kind: 'lavoratori', id: senzaVisita.id, reqKey: 'idoneita', expiry: d(365), file: PDF });
    paths.push(['site-documents', `${cid}/workers/${senzaVisita.id}`]);
    const { data: aldo } = await supabase.from('workers').select('health_fitness_expiry').eq('id', senzaVisita.id).single();
    check('caricata la visita: il campo del lavoratore prende la nuova data', aldo.health_fitness_expiry === d(365), aldo);
    const { data: wd } = await supabase.from('worker_documents').select('doc_type, expiry_date, file_path').eq('id', up.id).single();
    check('...ed è una riga worker_documents di tipo idoneita_medica col file', wd?.doc_type === 'idoneita_medica' && wd.expiry_date === d(365) && !!wd.file_path, wd);
    const sA2 = await scheda(cid, 'lavoratori', senzaVisita.id);
    check('...e la scheda ora dice in regola', sA2.state === 'in_regola', sA2.requirements);

    await carica({ companyId: cid, kind: 'lavoratori', id: campoPiuLontano.id, reqKey: 'idoneita', expiry: d(100), file: PDF });
    const { data: carlo } = await supabase.from('workers').select('health_fitness_expiry').eq('id', campoPiuLontano.id).single();
    check('data più vicina di quella che c\'era: il campo NON torna indietro', carlo.health_fitness_expiry === d(500), carlo);

    await carica({ companyId: cid, kind: 'impresa', reqKey: 'durc', expiry: d(120), file: { ...PDF, originalname: 'durc.pdf' } });
    const { data: co } = await supabase.from('companies').select('durc_expiry').eq('id', cid).single();
    check('DURC dell\'impresa: il campo dell\'azienda prende la data', co.durc_expiry === d(120), co);
    const sI = await scheda(cid, 'impresa', 'impresa');
    check('...e la scheda dell\'impresa lo mostra in regola', sI.requirements.find(r => r.key === 'durc')?.state === 'in_regola', sI.requirements);

    await carica({ companyId: cid, kind: 'mezzi', id: furgone.id, reqKey: 'assicurazione', expiry: d(200), file: { ...PDF, originalname: 'polizza.pdf' } });
    const { data: eq } = await supabase.from('equipment').select('insurance_expiry').eq('id', furgone.id).single();
    check('assicurazione del furgone: il campo del mezzo prende la data', eq.insurance_expiry === d(200), eq);

    await rejects('lavoratore di un\'altra azienda: non trovato', carica({ companyId: cid, kind: 'lavoratori', id: wOther.id, reqKey: 'idoneita', expiry: d(365), file: PDF }), 'NOT_FOUND');
    const { data: estraneo } = await supabase.from('workers').select('health_fitness_expiry').eq('id', wOther.id).single();
    check('...e la sua data non è cambiata', estraneo.health_fitness_expiry === d(-1), estraneo);
    await rejects('file non PDF/foto rifiutato', carica({ companyId: cid, kind: 'lavoratori', id: senzaVisita.id, file: { ...PDF, mimetype: 'application/zip' } }), 'INVALID_FILE_TYPE');
    await rejects('data inesistente rifiutata', carica({ companyId: cid, kind: 'lavoratori', id: senzaVisita.id, expiry: '2027-02-30', file: PDF }), 'INVALID_DATE');
    await rejects('tipo sconosciuto rifiutato', carica({ companyId: cid, kind: 'buste', id: senzaVisita.id, file: PDF }), 'INVALID_KIND');
  } finally {
    for (const [bucket, prefix] of paths) {
      const { data: files } = await supabase.storage.from(bucket).list(prefix);
      if (files?.length) await supabase.storage.from(bucket).remove(files.map(f => `${prefix}/${f.name}`)).catch(() => {});
    }
    for (const t of ['worker_documents', 'payslips', 'company_documents', 'equipment_documents', 'admin_audit_log']) {
      await supabase.from(t).delete().eq('company_id', cid);
    }
    await supabase.from('documents').delete().eq('company_id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
