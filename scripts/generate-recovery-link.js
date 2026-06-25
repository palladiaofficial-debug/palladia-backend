'use strict';
// Genera un link di recupero password senza mandare email.
// Uso: node scripts/generate-recovery-link.js chiantia@mscedilizia.it
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const email = process.argv[2];
if (!email) { console.error('Uso: node scripts/generate-recovery-link.js <email>'); process.exit(1); }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

(async () => {
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email: email.trim().toLowerCase(),
    options: { redirectTo: 'https://palladia.net/settings' },
  });
  if (error) { console.error('Errore:', error.message); process.exit(1); }
  console.log('\n✅ Link di recupero (valido ~60 min):\n');
  console.log(data.properties?.action_link || data.action_link);
  console.log('\nManda questo link al tuo collega via Telegram o WhatsApp.\n');
})();
