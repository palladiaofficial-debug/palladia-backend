'use strict';
/**
 * Script: fix-duplicate-company.js
 * Trova utenti con più di una company_users entry e risolve il conflitto:
 * - Mantiene la company con ruolo più alto (owner > admin > tech > viewer)
 *   a meno che l'utente sia stato invitato come tech in una company altrui
 *   e abbia anche una propria company vuota → elimina la company vuota.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log('=== Fix duplicate company memberships ===\n');

  // 1. Trova tutti gli utenti con più di una entry in company_users
  const { data: all, error } = await supabase
    .from('company_users')
    .select('user_id, company_id, role');

  if (error) { console.error('Errore lettura company_users:', error.message); process.exit(1); }

  // Raggruppa per user_id
  const byUser = {};
  for (const row of all) {
    if (!byUser[row.user_id]) byUser[row.user_id] = [];
    byUser[row.user_id].push(row);
  }

  const duplicates = Object.entries(byUser).filter(([, rows]) => rows.length > 1);
  console.log(`Utenti con più di una company: ${duplicates.length}`);

  if (duplicates.length === 0) {
    console.log('Nessun conflitto trovato. Tutto OK.');
    return;
  }

  for (const [userId, rows] of duplicates) {
    // Recupera email utente
    const { data: authData } = await supabase.auth.admin.getUserById(userId);
    const email = authData?.user?.email || userId;
    console.log(`\nUtente: ${email} (${userId})`);
    console.log('  Company memberships:');

    for (const r of rows) {
      // Carica info company
      const { data: co } = await supabase
        .from('companies')
        .select('id, name')
        .eq('id', r.company_id)
        .single();

      // Conta i membri di questa company
      const { count } = await supabase
        .from('company_users')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', r.company_id);

      console.log(`    - company: "${co?.name || '?'}" (${r.company_id}) | ruolo: ${r.role} | membri totali: ${count}`);
    }

    // Strategia: elimina le company dove l'utente è 'owner' e la company ha UN SOLO membro
    // (cioè la company vuota creata durante l'onboarding che non ha altri utenti)
    const toDelete = rows.filter(r => {
      return r.role === 'owner'; // sarà verificato anche il conteggio sotto
    });

    for (const candidate of toDelete) {
      const { count } = await supabase
        .from('company_users')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', candidate.company_id);

      if (count === 1) {
        // Company solitaria — quasi certamente creata per errore durante onboarding
        const { data: co } = await supabase
          .from('companies')
          .select('id, name')
          .eq('id', candidate.company_id)
          .single();

        console.log(`  → Eliminazione company vuota: "${co?.name}" (${candidate.company_id})`);

        // Rimuovi membership
        const { error: delMem } = await supabase
          .from('company_users')
          .delete()
          .eq('user_id', userId)
          .eq('company_id', candidate.company_id);

        if (delMem) {
          console.log(`    ERRORE rimozione membership: ${delMem.message}`);
          continue;
        }

        // Rimuovi company
        const { error: delCo } = await supabase
          .from('companies')
          .delete()
          .eq('id', candidate.company_id);

        if (delCo) {
          console.log(`    ERRORE rimozione company: ${delCo.message} (potrebbe avere FK attive)`);
        } else {
          console.log(`    ✓ Company eliminata`);
        }
      } else {
        console.log(`  → Skipping company ${candidate.company_id} (ha ${count} membri — non è vuota)`);
      }
    }
  }

  console.log('\n=== Fine ===');
}

main().catch(console.error);
