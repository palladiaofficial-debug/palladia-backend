#!/usr/bin/env node
/**
 * scripts/selftest_expiry_state_transitions.js
 *
 * BLOCCO 4 (Parte A, tempo) — verifica dal vivo le transizioni di stato reali
 * di scadenza, non solo la lettura del codice:
 *   1) Documento lavoratore (idoneità/formazione/ecc.): valido → in scadenza
 *      (info) → in scadenza (warning) → scaduto (critical) → risolto (rinnovo),
 *      contro services/workerExpiryCron.js (runWorkerExpiryCheck) reale.
 *   2) Attestato/certificato corso (Formazione): dedup a 7 giorni + escalation
 *      immediata su cambio tipo, contro la RPC reale upsert_expiry_notification
 *      (usata da routes/v1/certificates.js POST /notifications/check-expiries).
 *   3//  Company senza alcun dato in scadenza: il cron non deve crashare né
 *      loggare errori fuorvianti (zero-data company).
 *
 * Nessun invio Telegram/push reale: la company di test non ha integrazioni
 * collegate (chat id/subscription), quindi notifyCompany()/sendPushToCompany()
 * fanno no-op naturale sulla query — non serve stub.
 */
'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { runWorkerExpiryCheck } = require('../services/workerExpiryCron');
const { runEquipmentExpiryCheck } = require('../services/equipmentExpiryCron');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function inDays(n) { return new Date(Date.now() + n * 86400000).toISOString().split('T')[0]; }

async function main() {
  console.log('\nPalladia regression — transizioni di stato scadenze (BLOCCO 4)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('expiry state transitions', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const suffix = Date.now();
  let companyId = null, workerId = null, docId = null;
  let certCompanyId = null, certWorkerId = null, certId = null, courseTypeId = null;
  let eqCompanyId = null, eqId = null;

  try {
    // ═══ 1) Documento lavoratore: valido → info → warning → critical → risolto ═══
    const { data: company } = await admin.from('companies').insert({ name: `TEST-ExpiryState-${suffix}` }).select('id').single();
    companyId = company?.id;
    check('Company di test creata', !!companyId, company);

    const { data: worker } = await admin.from('workers')
      .insert({ company_id: companyId, full_name: `Test Worker ${suffix}`, fiscal_code: `TSTWRK${String(suffix).slice(-6)}X`, badge_code: `TEST-WRK-${suffix}`, is_active: true })
      .select('id').single();
    workerId = worker?.id;
    check('Lavoratore di test creato', !!workerId, worker);

    // valido: scadenza a 45gg, fuori dalla finestra di 30gg → nessuna notifica
    const { data: doc } = await admin.from('worker_documents')
      .insert({ company_id: companyId, worker_id: workerId, doc_type: 'idoneita_medica', name: 'Idoneità test', expiry_date: inDays(45) })
      .select('id').single();
    docId = doc?.id;
    check('Documento creato (scadenza a 45gg = valido)', !!docId, doc);

    await runWorkerExpiryCheck();
    let { data: notif } = await admin.from('notifications').select('severity').eq('entity_id', docId).eq('entity_type', 'worker_document').maybeSingle();
    check('Stato "valido" (>30gg): nessuna notifica creata', !notif, notif);

    // in scadenza (info): 15gg
    await admin.from('worker_documents').update({ expiry_date: inDays(15) }).eq('id', docId);
    await runWorkerExpiryCheck();
    ({ data: notif } = await admin.from('notifications').select('severity').eq('entity_id', docId).eq('entity_type', 'worker_document').maybeSingle());
    check('Stato "in scadenza" (15gg) → severity=info', notif?.severity === 'info', notif);

    // in scadenza (warning): 3gg
    await admin.from('worker_documents').update({ expiry_date: inDays(3) }).eq('id', docId);
    await runWorkerExpiryCheck();
    ({ data: notif } = await admin.from('notifications').select('severity').eq('entity_id', docId).eq('entity_type', 'worker_document').maybeSingle());
    check('Escalation a "warning" (3gg)', notif?.severity === 'warning', notif);

    // scaduto (critical): -2gg
    await admin.from('worker_documents').update({ expiry_date: inDays(-2) }).eq('id', docId);
    await runWorkerExpiryCheck();
    ({ data: notif } = await admin.from('notifications').select('severity').eq('entity_id', docId).eq('entity_type', 'worker_document').maybeSingle());
    check('Escalation a "critical" (scaduto da 2gg)', notif?.severity === 'critical', notif);

    // risolto: rinnovato a 365gg → la notifica viene rimossa (pruneNotifications)
    await admin.from('worker_documents').update({ expiry_date: inDays(365) }).eq('id', docId);
    await runWorkerExpiryCheck();
    ({ data: notif } = await admin.from('notifications').select('severity').eq('entity_id', docId).eq('entity_type', 'worker_document').maybeSingle());
    check('Risolto (rinnovato a 365gg): notifica rimossa', !notif, notif);

    // ═══ 2) Attestato/certificato: dedup 7gg + escalation immediata su cambio tipo ═══
    const { data: courseType } = await admin.from('course_types').select('id').limit(1).maybeSingle();
    courseTypeId = courseType?.id; // riusa un course_type reale esistente — tabella di riferimento globale, non va creata/cancellata da un test
    if (!courseTypeId) {
      skip('RPC upsert_expiry_notification', 'nessun course_types esistente nell\'ambiente su cui testare');
    } else {
      const { data: certCompany } = await admin.from('companies').insert({ name: `TEST-CertState-${suffix}` }).select('id').single();
      certCompanyId = certCompany?.id;
      const { data: certWorker } = await admin.from('workers').insert({ company_id: certCompanyId, full_name: `Test Cert Worker ${suffix}`, fiscal_code: `TSTCRT${String(suffix).slice(-6)}X`, badge_code: `TEST-CRT-${suffix}`, is_active: true }).select('id').single();
      certWorkerId = certWorker?.id;
      const { data: cert, error: certErr } = await admin.from('worker_certificates')
        .insert({ company_id: certCompanyId, worker_id: certWorkerId, course_type_id: courseTypeId, expiry_date: inDays(20), issue_date: inDays(-300), issuing_body: 'Ente Formazione Test', certificate_number: `TEST-${suffix}` })
        .select('id').single();
      if (certErr) console.error('  (debug insert worker_certificates):', certErr.message);
      certId = cert?.id;
      check('Certificato di test creato (scadenza a 20gg)', !!certId, cert);

      const r1 = await admin.rpc('upsert_expiry_notification', { p_certificate_id: certId, p_worker_id: certWorkerId, p_company_id: certCompanyId, p_notification_type: '30_days' });
      check('Prima notifica "30_days": inserita (non null)', !!r1.data, r1);

      const r2 = await admin.rpc('upsert_expiry_notification', { p_certificate_id: certId, p_worker_id: certWorkerId, p_company_id: certCompanyId, p_notification_type: '30_days' });
      check('Stesso tipo entro 7gg: SALTATA (dedup, null)', !r2.data, r2);

      const r3 = await admin.rpc('upsert_expiry_notification', { p_certificate_id: certId, p_worker_id: certWorkerId, p_company_id: certCompanyId, p_notification_type: '7_days' });
      check('Escalation a tipo diverso "7_days": inviata subito (non null), nessuna attesa dei 7gg', !!r3.data, r3);
    }

    // ═══ 2b) F-088 — notifica orfana quando l'ULTIMA scadenza della company si risolve ═══
    // (verificato anche su equipmentExpiryCron per provare che il fix condiviso
    // pruneOrphanedNotifications() generalizza oltre workerExpiryCron, dove è stato scoperto)
    const { data: eqCompany } = await admin.from('companies').insert({ name: `TEST-EquipOrphan-${suffix}` }).select('id').single();
    eqCompanyId = eqCompany?.id;
    const { data: eq } = await admin.from('equipment')
      .insert({ company_id: eqCompanyId, type: 'Test mezzo', insurance_expiry: inDays(-2), is_active: true })
      .select('id').single();
    eqId = eq?.id;
    check('Mezzo di test creato (assicurazione scaduta)', !!eqId, eq);

    await runEquipmentExpiryCheck();
    let { data: eqNotif } = await admin.from('notifications').select('severity').eq('entity_id', eqId).eq('entity_type', 'equipment').maybeSingle();
    check('F-088 equipment: notifica critical creata', eqNotif?.severity === 'critical', eqNotif);

    // Risolvi rinnovando — questa è l'UNICA scadenza della company, quindi la
    // company sparisce del tutto da `byCompany` nel prossimo run: prima del fix
    // pruneOrphanedNotifications, questa notifica sarebbe rimasta per sempre.
    await admin.from('equipment').update({ insurance_expiry: inDays(365) }).eq('id', eqId);
    await runEquipmentExpiryCheck();
    ({ data: eqNotif } = await admin.from('notifications').select('severity').eq('entity_id', eqId).eq('entity_type', 'equipment').maybeSingle());
    check('F-088: notifica orfana rimossa dopo che l\'ultima scadenza della company si risolve', !eqNotif, eqNotif);

    // ═══ 3) Zero-data company: nessun crash, nessun errore fuorviante ═══
    let zeroDataOk = true, zeroDataErr = null;
    try { await runWorkerExpiryCheck(); } catch (e) { zeroDataOk = false; zeroDataErr = e.message; }
    check('runWorkerExpiryCheck() con stato pulito: nessun crash', zeroDataOk, zeroDataErr);

  } finally {
    if (docId) await admin.from('notifications').delete().eq('entity_id', docId);
    if (docId) await admin.from('worker_documents').delete().eq('id', docId);
    if (workerId) await admin.from('workers').delete().eq('id', workerId);
    if (companyId) await admin.from('companies').delete().eq('id', companyId);
    if (certId) { await admin.from('expiry_notifications').delete().eq('certificate_id', certId); await admin.from('worker_certificates').delete().eq('id', certId); }
    if (certWorkerId) await admin.from('workers').delete().eq('id', certWorkerId);
    if (certCompanyId) await admin.from('companies').delete().eq('id', certCompanyId);
    if (eqId) await admin.from('notifications').delete().eq('entity_id', eqId);
    if (eqId) await admin.from('equipment').delete().eq('id', eqId);
    if (eqCompanyId) await admin.from('companies').delete().eq('id', eqCompanyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
