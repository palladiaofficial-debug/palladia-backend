#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_equipment_expiry_suggest.js
 *
 * Regressione per il gap trovato nello sweep F-105 (AUDIT.md): un documento
 * caricato su un mezzo (libretto/assicurazione/revisione) non aggiornava MAI
 * equipment.insurance_expiry/inspection_date — il campo che genera davvero
 * gli alert (services/equipmentExpiryCron.js, lo stesso dell'incidente
 * Cabstar che ha aperto questa indagine). A differenza di worker_documents
 * (F-105 originale), qui non c'è un percorso "manuale" preesistente da
 * replicare: nessuno dei due lo faceva, quindi il fix non scrive MAI in
 * automatico dall'OCR — propone solo (lib/equipmentExpirySuggest.js),
 * l'applicazione resta sempre un'azione esplicita dell'utente (PATCH
 * /equipment/:id già esistente, o conferma in chat per Ladia).
 */
require('dotenv').config();
const supabase = require('../lib/supabase');
const { createClient } = require('@supabase/supabase-js');
const { suggestEquipmentExpiryUpdates } = require('../lib/equipmentExpirySuggest');

const API_URL = `http://localhost:${process.env.PORT || 3001}`;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// ── 1. Unit: suggestEquipmentExpiryUpdates (pura, nessuna chiamata AI) ──────
function unitTests() {
  check(
    'nessun ai_extracted → nessun suggerimento',
    suggestEquipmentExpiryUpdates({ insurance_expiry: '2026-01-01', inspection_date: null }, null).length === 0,
  );
  check(
    'assicurazione diversa → propone SOLO quel campo',
    JSON.stringify(suggestEquipmentExpiryUpdates(
      { insurance_expiry: '2026-01-01', inspection_date: '2027-05-05' },
      { data_scadenza_assicurazione: '2027-06-12', data_prossima_revisione: '2027-05-05' },
    )) === JSON.stringify([{ field: 'insurance_expiry', label: 'Assicurazione', current: '2026-01-01', suggested: '2027-06-12' }]),
  );
  check(
    'entrambe le date diverse → propone entrambe',
    suggestEquipmentExpiryUpdates(
      { insurance_expiry: '2026-01-01', inspection_date: '2026-02-02' },
      { data_scadenza_assicurazione: '2027-06-12', data_prossima_revisione: '2027-07-07' },
    ).length === 2,
  );
  check(
    'campo attualmente vuoto (mai impostato) → propone comunque',
    suggestEquipmentExpiryUpdates(
      { insurance_expiry: null, inspection_date: '2027-05-05' },
      { data_scadenza_assicurazione: '2027-06-12', data_prossima_revisione: '2027-05-05' },
    ).length === 1,
  );
  check(
    'data OCR non valida (formato libero, non YYYY-MM-DD) → nessun suggerimento spurio',
    suggestEquipmentExpiryUpdates(
      { insurance_expiry: '2026-01-01', inspection_date: null },
      { data_scadenza_assicurazione: '12 giugno 2027', data_prossima_revisione: null },
    ).length === 0,
  );
  check(
    'data OCR identica a quella già registrata → nessun suggerimento (già allineato)',
    suggestEquipmentExpiryUpdates(
      { insurance_expiry: '2027-06-12', inspection_date: null },
      { data_scadenza_assicurazione: '2027-06-12', data_prossima_revisione: null },
    ).length === 0,
  );
  check(
    'data_ultima_revisione (non mappata) non genera mai un suggerimento',
    suggestEquipmentExpiryUpdates(
      { insurance_expiry: null, inspection_date: null },
      { data_ultima_revisione: '2025-01-01' },
    ).length === 0,
  );
}

async function makeSession(companyName) {
  const { data: company, error } = await supabase.from('companies').insert({ name: companyName }).select().single();
  if (error) throw error;
  const email = `test-eq-expiry-${company.id}@palladia-test.internal`;
  const { data: userRes, error: userErr } = await supabase.auth.admin.createUser({ email, password: 'Test1234!Probe', email_confirm: true });
  if (userErr) throw userErr;
  await supabase.from('company_users').insert({ company_id: company.id, user_id: userRes.user.id, role: 'owner' });

  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: signIn, error: signInErr } = await authClient.auth.signInWithPassword({ email, password: 'Test1234!Probe' });
  if (signInErr) throw signInErr;

  return { companyId: company.id, userId: userRes.user.id, jwt: signIn.session.access_token, cleanup: async () => {
    await supabase.from('companies').delete().eq('id', company.id);
    await supabase.auth.admin.deleteUser(userRes.user.id);
  } };
}

// ── 2. Integrazione dal vivo: l'endpoint reale non scrive MAI equipment.* da solo ──
async function integrationTest() {
  let healthy = false;
  try { healthy = (await fetch(`${API_URL}/`)).ok || true; } catch { healthy = false; }
  if (!healthy) {
    console.log(`  \x1b[33m–\x1b[0m integrazione dal vivo (skip: server non raggiungibile su ${API_URL})`);
    return;
  }

  const session = await makeSession('TEST-Equipment-Expiry-Suggest');
  try {
    const { data: eq, error: eqErr } = await supabase.from('equipment').insert({
      company_id: session.companyId, type: 'Furgone', model: 'Test Cabstar',
      plate_or_serial: 'TEST-F105', insurance_expiry: '2026-01-01', is_active: true,
    }).select().single();
    check('Mezzo di test creato con assicurazione scaduta nota (2026-01-01)', !eqErr && eq, eqErr);
    if (!eq) return;

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 test libretto circolazione')], { type: 'application/pdf' }), 'libretto.pdf');
    const res = await fetch(`${API_URL}/api/v1/equipment/${eq.id}/documents`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.jwt}`, 'x-company-id': session.companyId }, body: form,
    });
    const body = await res.json().catch(() => ({}));
    check('POST /equipment/:id/documents → 201', res.status === 201, { status: res.status, body });
    check('la risposta include il campo suggested_updates (anche se vuoto)', Array.isArray(body.suggested_updates), body);

    const { data: eqAfter } = await supabase.from('equipment').select('insurance_expiry, inspection_date').eq('id', eq.id).maybeSingle();
    check('FIX: equipment.insurance_expiry NON modificato in automatico dal solo upload — resta 2026-01-01', eqAfter?.insurance_expiry === '2026-01-01', eqAfter);
    check('inspection_date resta null — nessuna scrittura automatica su nessun campo', eqAfter?.inspection_date == null, eqAfter);

    // L'applicazione resta un'azione esplicita — verifica che la PATCH esistente
    // continui a funzionare per applicare davvero un suggerimento (simulato).
    const patchRes = await fetch(`${API_URL}/api/v1/equipment/${eq.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${session.jwt}`, 'x-company-id': session.companyId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ insuranceExpiry: '2027-06-12' }),
    });
    check('applicare un suggerimento resta una PATCH esplicita, già esistente e funzionante', patchRes.status === 200, { status: patchRes.status });
    const { data: eqAfterPatch } = await supabase.from('equipment').select('insurance_expiry').eq('id', eq.id).maybeSingle();
    check('dopo la conferma esplicita, il campo si aggiorna correttamente', eqAfterPatch?.insurance_expiry === '2027-06-12', eqAfterPatch);
  } finally {
    await session.cleanup();
  }
}

async function main() {
  console.log('\n=== selftest_equipment_expiry_suggest (sweep F-105) ===\n');
  unitTests();
  await integrationTest();
  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message, err.stack);
  process.exitCode = 1;
});
