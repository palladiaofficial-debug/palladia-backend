#!/usr/bin/env node
// F-179 (AUDIT.md): bucket worker-photos privato + regole storage.objects
// scoperte per azienda + backfill dei photo_url esistenti (URL pubblico
// completo -> path grezzo nel bucket, così l'API può firmare un URL
// temporaneo ad ogni risposta invece di esporne uno permanente).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');

const BUCKET = 'worker-photos';

// `storage.objects` è di proprietà di supabase_storage_admin. La RPC exec_sql
// (SECURITY DEFINER come postgres) non può alterarne le regole — "postgres"
// su questo progetto non può assumere quel ruolo (verificato dal vivo: sia
// SET ROLE diretto sia una funzione SECURITY DEFINER con OWNER spostato a
// supabase_storage_admin falliscono con "must be able to SET ROLE"). Questa
// è una restrizione della piattaforma Supabase gestita, non risolvibile da
// qui — richiede l'SQL Editor della Dashboard (che si connette con un
// contesto diverso e più privilegiato). Stampo l'SQL pronto da incollare
// invece di fingere di applicarlo.
function printManualSqlStep() {
  const sqlPath = path.join(__dirname, '../migrations/206_worker_photos_private.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log('\n\x1b[33m==================== AZIONE MANUALE RICHIESTA ====================\x1b[0m');
  console.log('Le regole di accesso a storage.objects per "worker-photos" NON possono');
  console.log('essere cambiate da questo script (limite della piattaforma Supabase —');
  console.log('serve un contesto con permessi che solo la Dashboard ha). Incolla questo');
  console.log('SQL in Supabase → SQL Editor ed eseguilo una volta sola:\n');
  console.log(sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n'));
  console.log('\x1b[33m====================================================================\x1b[0m\n');
}

async function makeBucketPrivate() {
  console.log(`Impostazione bucket "${BUCKET}" a privato...`);
  const { error } = await supabase.storage.updateBucket(BUCKET, { public: false });
  if (error) throw new Error('updateBucket fallito: ' + error.message);
  console.log('  OK — bucket ora privato.');
}

// Estrae il path relativo al bucket da un URL pubblico Supabase Storage
// completo, es. ".../object/public/worker-photos/<cid>/<wid>.jpg?v=123"
// -> "<cid>/<wid>.jpg". Se il valore è già un path (nessun http), lo lascia
// invariato — idempotente, sicuro da rieseguire.
function extractPath(value) {
  if (!value || typeof value !== 'string') return value;
  if (!/^https?:\/\//i.test(value)) return value; // già un path
  const marker = `/object/public/${BUCKET}/`;
  const idx = value.indexOf(marker);
  if (idx === -1) return null; // formato inatteso, non tocco (verrà segnalato)
  return value.slice(idx + marker.length).split('?')[0];
}

async function backfillPhotoUrls() {
  console.log('Backfill workers.photo_url (URL pubblico -> path grezzo)...');
  const { data: workers, error } = await supabase.from('workers').select('id, photo_url').not('photo_url', 'is', null);
  if (error) throw new Error('lettura workers fallita: ' + error.message);

  let updated = 0, skipped = 0, unexpected = 0;
  for (const w of workers) {
    const newPath = extractPath(w.photo_url);
    if (newPath === w.photo_url) { skipped++; continue; } // già un path
    if (newPath === null) {
      console.warn(`  ATTENZIONE worker ${w.id}: formato photo_url inatteso, non toccato:`, w.photo_url);
      unexpected++;
      continue;
    }
    const { error: updErr } = await supabase.from('workers').update({ photo_url: newPath }).eq('id', w.id);
    if (updErr) { console.error(`  errore aggiornando worker ${w.id}:`, updErr.message); continue; }
    updated++;
  }
  console.log(`  OK — ${updated} aggiornati, ${skipped} già a posto, ${unexpected} formato inatteso.`);
}

async function main() {
  await makeBucketPrivate();
  await backfillPhotoUrls();
  printManualSqlStep();
  console.log('F-179: bucket privato e dati esistenti migrati automaticamente.');
  console.log('Manca solo il passo SQL sopra (un\'unica volta, dalla Dashboard) per chiudere anche il buco di scrittura cross-azienda.');
}

main().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
