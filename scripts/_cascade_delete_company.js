#!/usr/bin/env node
// Cancella una company e tutte le righe figlie, scoprendo l'ordine di cancellazione
// per tentativi: prova a cancellare, se Postgres blocca per FK legge dal messaggio
// d'errore la tabella figlia bloccante e la svuota prima di ritentare.
// Uso: node _cascade_delete_company.js <company_id> [<company_id> ...]
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const FK_ERR = /violates foreign key constraint "([^"]+)" on table "([^"]+)"/;

// Colonne su cui provare a filtrare una tabella figlia, in ordine di probabilità,
// dato l'id di una company/site/worker/ecc. che la blocca.
const CANDIDATE_COLS = ['company_id', 'site_id', 'worker_id', 'user_id', 'created_by', 'coordinator_id', 'subcontractor_id'];

async function findScopedIds(table, col, val) {
  const { data, error } = await admin.from(table).select('id').eq(col, val);
  if (error) return null;
  return (data || []).map(r => r.id);
}

async function clearTable(table, byCol, byVal, depth) {
  if (depth > 12) throw new Error(`profondita massima raggiunta ripulendo ${table}`);
  const { error } = await admin.from(table).delete().eq(byCol, byVal);
  if (!error) { console.log(`  ${'  '.repeat(depth)}svuotato ${table} WHERE ${byCol}=${byVal}`); return; }
  const m = error.message.match(FK_ERR);
  if (!m) throw new Error(`${table}.${byCol}=${byVal}: ${error.message}`);
  const childTable = m[2];
  await resolveAndClear(childTable, table, byVal, depth + 1);
  await clearTable(table, byCol, byVal, depth); // retry dopo aver svuotato il figlio
}

// childTable blocca la cancellazione di righe in parentTable — dobbiamo capire
// con quale colonna childTable referenzia parentTable e ripulirlo di conseguenza.
async function resolveAndClear(childTable, parentTable, parentVal, depth) {
  for (const col of CANDIDATE_COLS) {
    const { error: probeErr } = await admin.from(childTable).select('id').eq(col, parentVal).limit(1);
    if (!probeErr) {
      await clearTable(childTable, col, parentVal, depth);
      return;
    }
  }
  throw new Error(`Non riesco a capire con quale colonna ${childTable} referenzia ${parentTable} (id=${parentVal}) — colonne provate: ${CANDIDATE_COLS.join(', ')}. Ispezionare manualmente.`);
}

async function deleteCompanyCascade(companyId) {
  console.log(`\n=== Cancellazione company ${companyId} ===`);
  await clearTable('companies', 'id', companyId, 0);
  console.log(`OK — company ${companyId} e tutte le righe figlie cancellate.`);
}

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.error('Uso: node _cascade_delete_company.js <company_id> [...]'); process.exit(1); }
  for (const id of ids) {
    try { await deleteCompanyCascade(id); }
    catch (e) { console.error(`ERRORE su ${id}:`, e.message); }
  }
}

main();
