#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_chat_archive_subcontractor_documents.js — F-247 (AUDIT.md)
 *
 * archive_document (Ladia) non aveva una destinazione per i documenti dei
 * subappaltatori: il DURC di un'impresa esterna poteva finire solo tra i
 * documenti DELL'AZIENDA (company_documents, categoria durc), dove Da fare lo
 * scambiava per il DURC aziendale rinnovato. Qui: il documento finisce nella
 * cartella del subappaltatore, la scadenza sulla sua scheda si aggiorna (solo
 * se più recente), il nome ambiguo o sconosciuto è un errore esplicito, un
 * subappaltatore di un'altra azienda non si raggiunge, e con il modulo spento
 * l'archiviazione è rifiutata.
 */
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { archiveChatUpload } = require('../services/chatDocumentAnalysis');
const { buildDaFare, romeDate, addDays } = require('../lib/daFare');

let passed = 0, failed = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const T = `TEST-F247-${Date.now()}`;
const today = romeDate();
const d = n => addDays(today, n);

async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
async function makeUpload(companyId, label) {
  const storagePath = `${companyId}/chat-uploads/test-f247-${label}-${Date.now()}.pdf`;
  const { error } = await supabase.storage.from('site-documents').upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  if (error) throw new Error('storage: ' + error.message);
  const row = await ins('chat_uploads', { company_id: companyId, user_id: crypto.randomUUID(), original_name: `${label}.pdf`, mime_type: 'application/pdf', storage_path: storagePath, size_bytes: 13 });
  return row.id;
}

async function main() {
  console.log('\n\x1b[1mF-247 — DURC di un subappaltatore archiviato da Ladia nella sua cartella, non tra quelli dell\'azienda\x1b[0m');
  const company = await ins('companies', { name: T, durc_expiry: d(-3) });
  const other = await ins('companies', { name: `${T}-altra` });
  const cid = company.id;
  const paths = [];
  try {
    await ins('company_feature_flags', { company_id: cid, feature: 'subappaltatori', enabled: true });
    const ayat = await ins('subcontractors', { company_id: cid, company_name: `${T} AYAT SRLS`, durc_expiry: d(-50), soa_expiry: d(400) });
    await ins('subcontractors', { company_id: cid, company_name: `${T} Edil Rossi Uno` });
    await ins('subcontractors', { company_id: cid, company_name: `${T} Edil Rossi Due` });
    const foreign = await ins('subcontractors', { company_id: other.id, company_name: `${T} Estranea SRL` });

    // 1. DURC per nome → cartella del subappaltatore + scheda aggiornata
    const r1 = await archiveChatUpload({
      uploadId: await makeUpload(cid, 'durc-ayat'), companyId: cid, userId: null,
      destination: 'subcontractor_documents', name: 'DURC AYAT SRLS', subcontractorName: 'AYAT',
      category: 'durc', expiryDate: d(60),
    });
    check('DURC per nome: archiviato', r1.success === true, r1);
    const { data: doc } = await supabase.from('subcontractor_documents').select('subcontractor_id, category, valid_until, file_path').eq('id', r1.doc_id).maybeSingle();
    if (doc) paths.push(doc.file_path);
    check('...nella cartella di AYAT, categoria durc, con scadenza', doc?.subcontractor_id === ayat.id && doc?.category === 'durc' && doc?.valid_until === d(60), doc);
    check('...percorso file come il caricamento manuale', String(doc?.file_path).startsWith(`${cid}/subcontractors/${ayat.id}/`), doc?.file_path);
    const { data: ayatAfter } = await supabase.from('subcontractors').select('durc_expiry, soa_expiry').eq('id', ayat.id).single();
    check('scheda di AYAT: scadenza DURC aggiornata', ayatAfter.durc_expiry === d(60), ayatAfter);
    const { data: companyDocs } = await supabase.from('company_documents').select('id').eq('company_id', cid);
    check('NIENTE nei documenti dell\'azienda', (companyDocs || []).length === 0, companyDocs);
    const { data: co } = await supabase.from('companies').select('durc_expiry').eq('id', cid).single();
    check('DURC aziendale intatto', co.durc_expiry === d(-3), co);

    const df = await buildDaFare(cid, null, { todayStr: today });
    check('Da fare: DURC aziendale ancora in lista (non coperto dal DURC di AYAT)', df.items.some(i => i.id === 'company:durc'), df.items.map(i => i.id));
    check('Da fare: DURC di AYAT non più scaduto', !df.items.some(i => i.id === `sub:${ayat.id}:durc`), df.items.map(i => i.title));

    // 2. SOA con scadenza PIÙ VECCHIA di quella sulla scheda → scheda intatta
    const r2 = await archiveChatUpload({
      uploadId: await makeUpload(cid, 'soa-old'), companyId: cid, userId: null,
      destination: 'subcontractor_documents', name: 'SOA vecchia', subcontractorId: ayat.id,
      category: 'soa', expiryDate: d(100),
    });
    check('SOA per id: archiviata', r2.success === true, r2);
    const { data: ayatSoa } = await supabase.from('subcontractors').select('soa_expiry').eq('id', ayat.id).single();
    check('SOA più vecchia non abbassa la scadenza della scheda', ayatSoa.soa_expiry === d(400), ayatSoa);

    // 3. Nome ambiguo, sconosciuto, di un'altra azienda
    const r3 = await archiveChatUpload({ uploadId: await makeUpload(cid, 'amb'), companyId: cid, userId: null, destination: 'subcontractor_documents', name: 'DURC', subcontractorName: 'Edil Rossi', category: 'durc', expiryDate: d(60) });
    check('nome ambiguo → errore, nessuna scelta silenziosa', r3.error === 'NOME_AMBIGUO', r3);
    const r4 = await archiveChatUpload({ uploadId: await makeUpload(cid, 'none'), companyId: cid, userId: null, destination: 'subcontractor_documents', name: 'DURC', subcontractorName: 'Nessuna Impresa Così', category: 'durc' });
    check('nome sconosciuto → errore', !!r4.error && !r4.success, r4);
    const r5 = await archiveChatUpload({ uploadId: await makeUpload(cid, 'foreign'), companyId: cid, userId: null, destination: 'subcontractor_documents', name: 'DURC', subcontractorId: foreign.id, category: 'durc', expiryDate: d(60) });
    check('subappaltatore di un\'altra azienda → errore', !!r5.error && !r5.success, r5);
    const { data: fAfter } = await supabase.from('subcontractors').select('durc_expiry').eq('id', foreign.id).single();
    check('...e la sua scheda intatta', fAfter.durc_expiry === null, fAfter);

    // 4. Modulo spento → rifiutato
    await supabase.from('company_feature_flags').update({ enabled: false }).eq('company_id', cid).eq('feature', 'subappaltatori');
    const r6 = await archiveChatUpload({ uploadId: await makeUpload(cid, 'off'), companyId: cid, userId: null, destination: 'subcontractor_documents', name: 'DURC', subcontractorId: ayat.id, category: 'durc', expiryDate: d(90) });
    check('modulo subappaltatori spento → rifiutato', !!r6.error && !r6.success, r6);
  } finally {
    if (paths.length) await supabase.storage.from('site-documents').remove(paths).catch(() => {});
    for (const t of ['subcontractor_documents', 'company_documents', 'chat_uploads', 'company_feature_flags', 'subcontractors']) {
      await supabase.from(t).delete().eq('company_id', cid);
    }
    await supabase.from('subcontractors').delete().eq('company_id', other.id);
    await supabase.from('documents').delete().eq('company_id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
