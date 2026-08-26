'use strict';
/**
 * BLOCCO 2 — pattern F-037/F-083: bucket Supabase Storage referenziato nel
 * codice ma inesistente nell'ambiente reale, scoperto solo da un utente che
 * ci sbatte contro (500 silenzioso). Verifica dal vivo (Storage API, non
 * grep) che ogni bucket "attivo" referenziato da una costante BUCKET/
 * STORAGE_BUCKET nel codice esista davvero.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Stesso elenco di server.js (REQUIRED_STORAGE_BUCKETS) — bucket referenziati
// con una costante BUCKET/STORAGE_BUCKET in routes/v1 e services (non i
// legacy best-effort in routes/v1/company.js LEGACY_BUCKETS, che tollerano
// già esplicitamente un bucket mancante).
const REQUIRED_BUCKETS = ['site-documents', 'site-media', 'equipment-docs'];

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error('[storage-buckets] impossibile elencare i bucket:', error.message);
    process.exit(1);
  }

  const existing = new Set((data || []).map(b => b.name));
  const missing = REQUIRED_BUCKETS.filter(b => !existing.has(b));

  if (missing.length) {
    console.error(`[storage-buckets] FALLITO — bucket referenziati dal codice ma assenti in produzione: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`[storage-buckets] OK — tutti i ${REQUIRED_BUCKETS.length} bucket attivi esistono: ${REQUIRED_BUCKETS.join(', ')}`);
}

main();
