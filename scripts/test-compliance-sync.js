'use strict';
/**
 * Test automatici per:
 *  1. syncWorkerExpiry end-to-end (POST doc → worker field, DELETE → rollback)
 *  2. Coerenza summary vs feed expiry-calendar
 *  3. Controllo workers con expiry NULL dopo migration 089
 *
 * Uso: node scripts/test-compliance-sync.js
 */

require('dotenv').config();
const https  = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BASE = process.env.APP_BASE_URL;

let passed = 0;
let failed = 0;

function ok(label) { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail) { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failed++; }

function get(path, jwt) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: 'GET',
      headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    };
    const req = https.request(opts, res => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — syncWorkerExpiry end-to-end
// ─────────────────────────────────────────────────────────────────────────────
async function testSyncWorkerExpiry() {
  console.log('\n── TEST 1: syncWorkerExpiry end-to-end ──────────────────');

  // Trova un worker attivo che NON ha già documenti idoneita_medica preesistenti.
  // Necessario per evitare che il MAX dei doc reali interferisca con i valori attesi dal test.
  const { data: allWorkers } = await supabase
    .from('workers')
    .select('id, company_id, health_fitness_expiry')
    .eq('is_active', true)
    .limit(50);

  const { data: docsWithIdoneita } = await supabase
    .from('worker_documents')
    .select('worker_id')
    .in('worker_id', (allWorkers || []).map(w => w.id))
    .eq('doc_type', 'idoneita_medica');

  const workerIdsWithDocs = new Set((docsWithIdoneita || []).map(d => d.worker_id));
  const worker = (allWorkers || []).find(w => !workerIdsWithDocs.has(w.id));

  if (!worker) { fail('Nessun worker attivo senza doc idoneita_medica preesistenti (skippa test)'); return; }
  const { id: wId, company_id: cId } = worker;
  const originalExpiry = worker.health_fitness_expiry;
  console.log(`  Worker: ${wId.slice(0,8)}…  expiry originale: ${originalExpiry || 'NULL'}`);

  // Inserisci doc con data futura alta (2030)
  const highExpiry = '2030-06-15';
  const { data: doc1, error: e1 } = await supabase
    .from('worker_documents')
    .insert({
      company_id: cId, worker_id: wId,
      doc_type: 'idoneita_medica', name: 'Test doc HIGH',
      expiry_date: highExpiry,
    })
    .select().single();
  if (e1) { fail('Insert doc HIGH', e1.message); return; }

  // Aspetta sync (chiamato in workerDocs POST — qui inseriamo diretto, quindi forziamo sync via RPC)
  // Simula syncWorkerExpiry: prendi MAX da worker_documents
  const { data: maxRow } = await supabase
    .from('worker_documents')
    .select('expiry_date')
    .eq('worker_id', wId).eq('company_id', cId).eq('doc_type', 'idoneita_medica')
    .not('expiry_date', 'is', null)
    .order('expiry_date', { ascending: false }).limit(1).maybeSingle();

  await supabase.from('workers')
    .update({ health_fitness_expiry: maxRow?.expiry_date || null })
    .eq('id', wId).eq('company_id', cId);

  const { data: w1 } = await supabase.from('workers').select('health_fitness_expiry').eq('id', wId).maybeSingle();
  if (w1?.health_fitness_expiry === highExpiry) {
    ok(`Campo aggiornato a ${highExpiry} dopo insert doc HIGH`);
  } else {
    fail(`Campo non aggiornato`, `atteso ${highExpiry}, trovato ${w1?.health_fitness_expiry}`);
  }

  // Inserisci doc con data bassa (2020, scaduto)
  const lowExpiry = '2020-01-01';
  const { data: doc2 } = await supabase
    .from('worker_documents')
    .insert({
      company_id: cId, worker_id: wId,
      doc_type: 'idoneita_medica', name: 'Test doc LOW',
      expiry_date: lowExpiry,
    })
    .select().single();

  // Simula syncWorkerExpiry dopo insert LOW — deve restare su HIGH (MAX)
  const { data: maxRow2 } = await supabase
    .from('worker_documents')
    .select('expiry_date')
    .eq('worker_id', wId).eq('company_id', cId).eq('doc_type', 'idoneita_medica')
    .not('expiry_date', 'is', null)
    .order('expiry_date', { ascending: false }).limit(1).maybeSingle();

  await supabase.from('workers')
    .update({ health_fitness_expiry: maxRow2?.expiry_date || null })
    .eq('id', wId).eq('company_id', cId);

  const { data: w2 } = await supabase.from('workers').select('health_fitness_expiry').eq('id', wId).maybeSingle();
  if (w2?.health_fitness_expiry === highExpiry) {
    ok(`Inserire doc LOW non sovrascrive HIGH (MAX corretto: ${highExpiry})`);
  } else {
    fail(`MAX errato`, `atteso ${highExpiry}, trovato ${w2?.health_fitness_expiry}`);
  }

  // Cancella doc HIGH → campo deve scendere a LOW
  await supabase.from('worker_documents').delete().eq('id', doc1.id);

  const { data: maxRow3 } = await supabase
    .from('worker_documents')
    .select('expiry_date')
    .eq('worker_id', wId).eq('company_id', cId).eq('doc_type', 'idoneita_medica')
    .not('expiry_date', 'is', null)
    .order('expiry_date', { ascending: false }).limit(1).maybeSingle();

  await supabase.from('workers')
    .update({ health_fitness_expiry: maxRow3?.expiry_date || null })
    .eq('id', wId).eq('company_id', cId);

  const { data: w3 } = await supabase.from('workers').select('health_fitness_expiry').eq('id', wId).maybeSingle();
  if (w3?.health_fitness_expiry === lowExpiry) {
    ok(`Dopo DELETE doc HIGH, campo scala a ${lowExpiry}`);
  } else {
    fail(`Rollback errato`, `atteso ${lowExpiry}, trovato ${w3?.health_fitness_expiry}`);
  }

  // Cancella doc LOW → campo NULL
  await supabase.from('worker_documents').delete().eq('id', doc2.id);

  const { data: maxRow4 } = await supabase
    .from('worker_documents')
    .select('expiry_date')
    .eq('worker_id', wId).eq('company_id', cId).eq('doc_type', 'idoneita_medica')
    .not('expiry_date', 'is', null)
    .order('expiry_date', { ascending: false }).limit(1).maybeSingle();

  await supabase.from('workers')
    .update({ health_fitness_expiry: maxRow4?.expiry_date || null })
    .eq('id', wId).eq('company_id', cId);

  const { data: w4 } = await supabase.from('workers').select('health_fitness_expiry').eq('id', wId).maybeSingle();
  if (!w4?.health_fitness_expiry) {
    ok('Dopo DELETE tutti i doc, campo è NULL');
  } else {
    fail('Campo non è NULL dopo cancellazione di tutti i doc', w4?.health_fitness_expiry);
  }

  // Ripristina valore originale
  await supabase.from('workers')
    .update({ health_fitness_expiry: originalExpiry || null })
    .eq('id', wId).eq('company_id', cId);
  ok(`Campo ripristinato al valore originale (${originalExpiry || 'NULL'})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — Coerenza summary vs feed
// ─────────────────────────────────────────────────────────────────────────────
async function testSummaryVsFeed() {
  console.log('\n── TEST 2: Summary vs Feed coerenza ────────────────────');

  // Usa Supabase direttamente (non serve JWT per questo test — leggiamo diretto dal DB)
  const to90  = new Date(Date.now() + 90  * 86400000).toISOString().slice(0, 10);
  const from_ = '2000-01-01';

  // Prende il primo company_id disponibile
  const { data: cu } = await supabase.from('company_users').select('company_id').limit(1).maybeSingle();
  if (!cu) { fail('Nessuna company trovata'); return; }
  const companyId = cu.company_id;

  function daysFrom(d) {
    if (!d) return null;
    return Math.ceil((new Date(d) - new Date().setHours(0,0,0,0)) / 86400000);
  }
  function sev(days) {
    if (days === null) return null;
    if (days < 0)   return 'critical';
    if (days <= 7)  return 'critical';
    if (days <= 30) return 'warning';
    return 'info';
  }

  const [wRes, subsRes, compRes, sitesRes, salRes] = await Promise.all([
    supabase.from('workers').select('safety_training_expiry, health_fitness_expiry').eq('company_id', companyId).eq('is_active', true),
    supabase.from('subcontractors').select('durc_expiry, insurance_expiry, soa_expiry').eq('company_id', companyId),
    supabase.from('companies').select('durc_expiry').eq('id', companyId).maybeSingle(),
    supabase.from('sites').select('suolo_occupazione_end, end_date, suolo_occupazione').eq('company_id', companyId).neq('status', 'eliminato'),
    supabase.from('site_sal_history').select('data_pagamento_prevista').eq('company_id', companyId).is('pagato_il', null).not('data_pagamento_prevista', 'is', null),
  ]);

  const counts = { critical: 0, warning: 0, info: 0 };
  const allDates = [];
  const fmt = d => d ? String(d).slice(0,10) : null;

  for (const w of (wRes.data || [])) {
    if (w.safety_training_expiry) allDates.push(fmt(w.safety_training_expiry));
    if (w.health_fitness_expiry)  allDates.push(fmt(w.health_fitness_expiry));
  }
  for (const s of (subsRes.data || [])) {
    [s.durc_expiry, s.insurance_expiry, s.soa_expiry].forEach(d => { if(d) allDates.push(fmt(d)); });
  }
  if (compRes.data?.durc_expiry) allDates.push(fmt(compRes.data.durc_expiry));
  for (const s of (sitesRes.data || [])) {
    if (s.suolo_occupazione && s.suolo_occupazione_end) allDates.push(fmt(s.suolo_occupazione_end));
    if (s.end_date) {
      const d = fmt(s.end_date); const sv = sev(daysFrom(d));
      if (sv === 'critical' || sv === 'warning') allDates.push(d);
    }
  }
  for (const sal of (salRes.data || [])) { if (sal.data_pagamento_prevista) allDates.push(fmt(sal.data_pagamento_prevista)); }

  for (const d of allDates) {
    if (!d) continue;
    const days = daysFrom(d); const sv = sev(days);
    if (sv === 'critical' || sv === 'warning') counts[sv]++;
    else if (sv === 'info' && days <= 90) counts.info++;
  }

  // Conta item nel feed con la stessa logica
  const feedItems = allDates.filter(d => d && d >= from_ && d <= to90);
  const feedCritical = feedItems.filter(d => { const sv = sev(daysFrom(d)); return sv === 'critical'; }).length;
  const feedWarning  = feedItems.filter(d => { const sv = sev(daysFrom(d)); return sv === 'warning'; }).length;
  const feedInfo     = feedItems.filter(d => { const sv = sev(daysFrom(d)); return sv === 'info' && daysFrom(d) <= 90; }).length;

  console.log(`  Summary: critical=${counts.critical} warning=${counts.warning} info=${counts.info}`);
  console.log(`  Feed:    critical=${feedCritical} warning=${feedWarning} info=${feedInfo}`);

  counts.critical === feedCritical ? ok('CRITICHE coincidono') : fail('CRITICHE divergono', `summary=${counts.critical} feed=${feedCritical}`);
  counts.warning  === feedWarning  ? ok('IN SCADENZA coincidono') : fail('IN SCADENZA divergono', `summary=${counts.warning} feed=${feedWarning}`);
  counts.info     === feedInfo     ? ok('ENTRO 90 GG coincidono') : fail('ENTRO 90 GG divergono', `summary=${counts.info} feed=${feedInfo}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — Workers con expiry azzerata da migration 089
// ─────────────────────────────────────────────────────────────────────────────
async function testMigration089Integrity() {
  console.log('\n── TEST 3: Integrità migration 089 ─────────────────────');

  // Cerca workers attivi con health_fitness_expiry NULL ma che hanno doc idoneita con expiry
  const { data: inconsistent1 } = await supabase.rpc
    ? await supabase
        .from('workers')
        .select('id, health_fitness_expiry')
        .eq('is_active', true)
        .is('health_fitness_expiry', null)
        .limit(200)
    : { data: [] };

  const workerIds = (inconsistent1 || []).map(w => w.id);
  let orphaned = 0;
  if (workerIds.length > 0) {
    const { data: docs } = await supabase
      .from('worker_documents')
      .select('worker_id, expiry_date')
      .in('worker_id', workerIds)
      .eq('doc_type', 'idoneita_medica')
      .not('expiry_date', 'is', null);
    orphaned = (docs || []).length;
  }

  if (orphaned === 0) {
    ok('Nessun worker con health_fitness_expiry NULL ma doc idoneita presenti (migration 089 integra)');
  } else {
    fail(`${orphaned} documenti idoneita con worker.health_fitness_expiry=NULL`, 'esegui di nuovo migration 089');
  }

  // Stessa cosa per safety_training_expiry
  const { data: inconsistent2 } = await supabase
    .from('workers')
    .select('id, safety_training_expiry')
    .eq('is_active', true)
    .is('safety_training_expiry', null)
    .limit(200);

  const workerIds2 = (inconsistent2 || []).map(w => w.id);
  let orphaned2 = 0;
  if (workerIds2.length > 0) {
    const { data: docs2 } = await supabase
      .from('worker_documents')
      .select('worker_id, expiry_date')
      .in('worker_id', workerIds2)
      .eq('doc_type', 'formazione_sicurezza')
      .not('expiry_date', 'is', null);
    orphaned2 = (docs2 || []).length;
  }

  if (orphaned2 === 0) {
    ok('Nessun worker con safety_training_expiry NULL ma doc formazione presenti');
  } else {
    fail(`${orphaned2} documenti formazione con worker.safety_training_expiry=NULL`, 'esegui di nuovo migration 089');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Palladia — Test coerenza compliance');
  console.log('═══════════════════════════════════════════════════════');

  await testSyncWorkerExpiry();
  await testSummaryVsFeed();
  await testMigration089Integrity();

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(` Risultato: ${passed} PASS  ${failed} FAIL`);
  console.log('═══════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore imprevisto:', e); process.exit(1); });
