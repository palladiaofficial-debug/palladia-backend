require('dotenv').config({ quiet: true });
// Uso: node scripts/setup_bucket_conti_sub.js (idempotente). Vedi migrations/253_conti_sub.sql.
const s = require('../lib/supabase');
// F-360: spazio privato per i fogli dei sub (Excel compreso), separato da site-documents
(async () => {
  const { data: esiste } = await s.storage.getBucket('conti-sub');
  if (!esiste) {
    const { error } = await s.storage.createBucket('conti-sub', {
      public: false,
      fileSizeLimit: 20 * 1024 * 1024,
      allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/csv',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    });
    console.log('crea:', error ? error.message : 'ok');
  }
  const { data } = await s.storage.getBucket('conti-sub');
  console.log('public:', data.public, 'allowed:', data.allowed_mime_types, 'limit:', data.file_size_limit);
  // con la chiave pubblica non si legge niente
  const anon = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: l, error: le } = await anon.storage.from('conti-sub').list('');
  console.log('anon list:', le ? le.message : (l || []).length);
})();
