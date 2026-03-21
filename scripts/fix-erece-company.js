'use strict';
/**
 * Script: fix-erece-company.js
 * Corregge la situazione di errecemusica@gmail.com:
 * 1. Elimina la company "C^2 Srl" (creata per errore durante l'onboarding)
 * 2. Aggiunge Erre Ce a MSCedilizia come 'tech' (usando l'invito già esistente)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TARGET_EMAIL = 'errecemusica@gmail.com';
const TARGET_COMPANY_NAME = 'MSCedilizia';

async function main() {
  console.log('=== Fix Erre Ce company membership ===\n');

  // 1. Trova l'utente per email
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) { console.error('Errore listUsers:', listErr.message); process.exit(1); }

  const targetUser = users.find(u => u.email === TARGET_EMAIL);
  if (!targetUser) { console.error(`Utente ${TARGET_EMAIL} non trovato`); process.exit(1); }
  const userId = targetUser.id;
  console.log(`Utente trovato: ${TARGET_EMAIL} (${userId})`);

  // 2. Trova company MSCedilizia
  const { data: targetCompany } = await supabase
    .from('companies')
    .select('id, name')
    .eq('name', TARGET_COMPANY_NAME)
    .single();

  if (!targetCompany) { console.error(`Company "${TARGET_COMPANY_NAME}" non trovata`); process.exit(1); }
  console.log(`Company target: "${targetCompany.name}" (${targetCompany.id})`);

  // 3. Trova tutte le company_users di Erre Ce
  const { data: memberships } = await supabase
    .from('company_users')
    .select('company_id, role')
    .eq('user_id', userId);

  console.log('\nMemberships attuali:');
  for (const m of memberships || []) {
    const { data: co } = await supabase.from('companies').select('name').eq('id', m.company_id).single();
    console.log(`  - "${co?.name}" (${m.company_id}) | ruolo: ${m.role}`);
  }

  // 4. Elimina membership + company "C^2 Srl" (solo se 1 membro)
  const accidentalMemberships = (memberships || []).filter(m => m.company_id !== targetCompany.id);

  for (const m of accidentalMemberships) {
    const { data: co } = await supabase.from('companies').select('id, name').eq('id', m.company_id).single();

    // Conta membri totali
    const { count } = await supabase
      .from('company_users')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', m.company_id);

    console.log(`\nCompany "${co?.name}" ha ${count} membro/i.`);

    if (count === 1) {
      console.log(`→ Elimino membership in "${co?.name}"...`);
      const { error: delMem } = await supabase
        .from('company_users')
        .delete()
        .eq('user_id', userId)
        .eq('company_id', m.company_id);

      if (delMem) { console.log('  ERRORE:', delMem.message); continue; }
      console.log('  ✓ Membership eliminata');

      console.log(`→ Elimino company "${co?.name}"...`);
      const { error: delCo } = await supabase
        .from('companies')
        .delete()
        .eq('id', m.company_id);

      if (delCo) {
        console.log(`  ERRORE eliminazione company: ${delCo.message}`);
        console.log('  (potrebbe avere FK attive — la membership è già eliminata, procedo comunque)');
      } else {
        console.log('  ✓ Company eliminata');
      }
    } else {
      console.log(`→ Skipping "${co?.name}" (ha ${count} membri — non vuota, non elimino)`);
      // Rimuovo solo la membership dell'utente
      const { error: delMem } = await supabase
        .from('company_users')
        .delete()
        .eq('user_id', userId)
        .eq('company_id', m.company_id);
      if (!delMem) console.log('  ✓ Membership dell\'utente rimossa dalla company');
    }
  }

  // 5. Aggiungi Erre Ce a MSCedilizia come 'tech' (se non già membro)
  const alreadyMember = (memberships || []).some(m => m.company_id === targetCompany.id);
  if (alreadyMember) {
    console.log(`\n✓ Erre Ce è già membro di "${TARGET_COMPANY_NAME}"`);
  } else {
    console.log(`\n→ Aggiungo Erre Ce a "${TARGET_COMPANY_NAME}" come tech...`);
    const { error: insertErr } = await supabase
      .from('company_users')
      .insert({ company_id: targetCompany.id, user_id: userId, role: 'tech' });

    if (insertErr) {
      console.log('  ERRORE inserimento:', insertErr.message);
    } else {
      console.log('  ✓ Aggiunto come tech');
    }
  }

  // 6. Segna l'invito come usato (se esiste)
  const { data: invite } = await supabase
    .from('company_invites')
    .select('id, email, used_at')
    .eq('company_id', targetCompany.id)
    .eq('email', TARGET_EMAIL)
    .is('used_at', null)
    .maybeSingle();

  if (invite) {
    console.log(`\n→ Segno invito ${invite.id} come usato...`);
    const { error: invErr } = await supabase
      .from('company_invites')
      .update({ used_at: new Date().toISOString(), used_by: userId })
      .eq('id', invite.id);

    if (invErr) console.log('  ERRORE update invito:', invErr.message);
    else console.log('  ✓ Invito segnato come usato');
  }

  // 7. Verifica finale
  console.log('\n=== Verifica finale ===');
  const { data: finalMemberships } = await supabase
    .from('company_users')
    .select('company_id, role')
    .eq('user_id', userId);

  for (const m of finalMemberships || []) {
    const { data: co } = await supabase.from('companies').select('name').eq('id', m.company_id).single();
    console.log(`  - "${co?.name}" | ruolo: ${m.role}`);
  }

  console.log('\n=== Fine ===');
  console.log('Ora Erre Ce può fare login e vedrà MSCedilizia come company attiva.');
  console.log('Se è già loggato deve fare logout + login per vedere il cambiamento.');
}

main().catch(console.error);
