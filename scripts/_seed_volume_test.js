#!/usr/bin/env node
/**
 * scripts/_seed_volume_test.js
 * BLOCCO 5 (Parte B — volumi): porta TEST-AutoExplore a ~200 lavoratori e
 * ~5000 documenti per misurare tempi di risposta reali su liste/query a
 * volume. Idempotente: controlla il conteggio attuale e inserisce solo la
 * differenza. Dati puramente sintetici in una company di test isolata.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const COMPANY_ID = '92d69bf4-b9c1-4974-a839-b0a7d95f82e8'; // TEST-AutoExplore
const TARGET_WORKERS = 200;
const TARGET_DOCS = 5000;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const { count: workerCount } = await sb.from('workers').select('*', { count: 'exact', head: true }).eq('company_id', COMPANY_ID);
  const needWorkers = Math.max(0, TARGET_WORKERS - workerCount);
  console.log(`Workers attuali: ${workerCount}, da aggiungere: ${needWorkers}`);

  const newWorkerIds = [];
  if (needWorkers > 0) {
    const rows = [];
    for (let i = 0; i < needWorkers; i++) {
      const n = workerCount + i + 1;
      rows.push({
        company_id: COMPANY_ID,
        first_name: `Volume${n}`,
        last_name: `Test`,
        full_name: `Volume${n} Test`,
        fiscal_code: `VOLTEST${String(n).padStart(6, '0')}`,
        badge_code: `VOLBADGE${String(n).padStart(6, '0')}`,
        is_active: true,
        qualification: 'operaio',
        hire_date: '2026-01-01',
      });
    }
    for (const batch of chunk(rows, 500)) {
      const { data, error } = await sb.from('workers').insert(batch).select('id');
      if (error) throw error;
      newWorkerIds.push(...data.map(d => d.id));
      process.stdout.write('.');
    }
    console.log(`\n${needWorkers} workers inseriti.`);
  }

  const { count: docCount } = await sb.from('documents').select('*', { count: 'exact', head: true }).eq('company_id', COMPANY_ID);
  const needDocs = Math.max(0, TARGET_DOCS - docCount);
  console.log(`Documenti attuali: ${docCount}, da aggiungere: ${needDocs}`);

  if (needDocs > 0) {
    const { data: workers } = await sb.from('workers').select('id').eq('company_id', COMPANY_ID).limit(300);
    const rows = [];
    for (let i = 0; i < needDocs; i++) {
      const n = docCount + i + 1;
      const worker = workers[i % workers.length];
      rows.push({
        company_id: COMPANY_ID,
        owner_type: 'worker',
        worker_id: worker.id,
        name: `volume-doc-${n}`,
        category: 'idoneita',
        bucket: 'site-documents',
        file_path: `${COMPANY_ID}/volume-seed/${n}.pdf`,
        file_size: 10000,
        mime_type: 'application/pdf',
        expiry_date: '2027-01-01',
        source_table: 'worker_documents',
        legacy_id: crypto.randomUUID(),
      });
    }
    let done = 0;
    for (const batch of chunk(rows, 500)) {
      const { error } = await sb.from('documents').insert(batch);
      if (error) throw error;
      done += batch.length;
      process.stdout.write(`\r${done}/${needDocs}`);
    }
    console.log(`\n${needDocs} documenti inseriti.`);
  }

  console.log('\nFatto.');
}

main().catch(e => { console.error('ERRORE:', e.message); process.exit(1); });
