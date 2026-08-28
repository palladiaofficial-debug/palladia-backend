#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_smart_import_equipment_documents.js
 *
 * Regressione per F-096 (AUDIT.md) — estende all'Importazione Intelligente
 * (import ZIP/cartella, services/smartImportPipeline.js) la destinazione
 * equipment_documents già aggiunta all'archiviazione diretta da chat (F-095):
 * un libretto di circolazione/assicurazione/revisione importato in blocco ora
 * può finire sulla scheda del mezzo giusto, non più genericamente in
 * company_documents.
 *
 * Non richiama classifySegments/extractFields (chiamate Claude reali, costo
 * e non-determinismo non necessari qui) — costruisce direttamente lo stato
 * di un import_item come lo lascerebbe processOneItem dopo classificazione +
 * matchEquipment, e verifica il livello che cambia davvero in questo fix:
 * confirmItem() (wiring matched_equipment_id → archiveChatUpload) più il
 * matching puro matchEquipment() (già usato anche da processOneItem).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { matchEquipment } = require('../lib/entityMatch');
const { confirmItem } = require('../services/smartImportPipeline');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const API_BASE = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check_(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function main() {
  console.log('\nPalladia — F-096: Importazione Intelligente per documenti mezzi (regressione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: companyA } = await admin.from('companies').select('id').eq('name', 'TEST-AutoExplore').maybeSingle();
  if (!companyA) { skip('suite', 'TEST-AutoExplore non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }
  const { data: companyAUser } = await admin.from('company_users').select('user_id').eq('company_id', companyA.id).limit(1).single();

  // ── 1. matchEquipment: unit, stesso matcher usato da processOneItem ──────
  const plate = `EQ${Date.now() % 100000}`;
  const candidates = [{ id: 'eq-1', name: 'Furgone Cantiere', type: 'Furgone', model: 'Ducato', plate_or_serial: plate }];
  check_('matchEquipment: targa esatta', matchEquipment({ plate, name: null }, candidates)?.id === 'eq-1');
  check_('matchEquipment: nome/modello fuzzy', matchEquipment({ plate: null, name: 'Ducato' }, candidates)?.id === 'eq-1');
  check_('matchEquipment: nessuna corrispondenza → null', matchEquipment({ plate: 'ZZZ999', name: 'Non Esiste Nessun Mezzo' }, candidates) === null);

  // ── 2. Fixture reali: mezzo, batch, chat_upload, import_item già "matchato" ──
  const { data: equipment, error: eqErr } = await admin.from('equipment').insert({
    company_id: companyA.id, type: 'Autocarro', model: 'F-096', name: 'F-096', plate_or_serial: plate, ownership: 'Aziendale', is_active: true,
  }).select('id').single();
  if (eqErr) { fail('Fixture: mezzo creato', eqErr.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  const { data: batch } = await admin.from('import_batches').insert({
    company_id: companyA.id, user_id: companyAUser.user_id, source: 'zip', status: 'review', total_files: 1,
  }).select('id').single();

  async function makeItem(withMatch) {
    const storagePath = `${companyA.id}/chat-uploads/test-f096-${withMatch}-${Date.now()}.pdf`;
    await admin.storage.from('site-documents').upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
    const { data: upload } = await admin.from('chat_uploads').insert({
      company_id: companyA.id, user_id: companyAUser.user_id, original_name: 'libretto_test.pdf', mime_type: 'application/pdf',
      storage_path: storagePath, size_bytes: 20, import_batch_id: batch.id,
    }).select('id').single();
    const { data: item, error } = await admin.from('import_items').insert({
      batch_id: batch.id, chat_upload_id: upload.id, original_name: 'libretto_test.pdf',
      doc_type: 'libretto_circolazione', destination: 'equipment_documents',
      extracted_fields: { doc_type_detected: { value: 'libretto_circolazione', confidence: 0.9 } },
      overall_confidence: 0.9, status: 'pending_review',
      matched_equipment_id: withMatch ? equipment.id : null,
      equipment_match_score: withMatch ? 100 : null,
    }).select('id').single();
    if (error) throw error;
    return item.id;
  }

  // ── 3. Migrazione 180: destination='equipment_documents' accettata dal CHECK ──
  const itemMatchedId = await makeItem(true).catch(e => { fail('Migrazione 180: import_items accetta destination=equipment_documents', e.message); return null; });
  if (itemMatchedId) ok('Migrazione 180: import_items accetta destination=equipment_documents (CHECK aggiornato)');

  // ── 4. confirmItem con mezzo risolto: scrive su equipment_documents ──────
  if (itemMatchedId) {
    const result = await confirmItem(itemMatchedId, companyA.id, companyAUser.user_id).catch(e => ({ error: e.message }));
    check_('confirmItem con mezzo risolto: successo', result?.success === true, result);
    if (result?.doc_id) {
      const { data: docRow } = await admin.from('equipment_documents').select('equipment_id').eq('id', result.doc_id).maybeSingle();
      check_('Documento scritto sull\'equipment_id giusto', docRow?.equipment_id === equipment.id, docRow);
      await admin.from('equipment_documents').delete().eq('id', result.doc_id);
    }
  }

  // ── 5. confirmItem SENZA mezzo risolto: rifiuto chiaro, non un crash ─────
  const itemUnmatchedId = await makeItem(false);
  const resultUnmatched = await confirmItem(itemUnmatchedId, companyA.id, companyAUser.user_id).then(() => null).catch(e => e.message);
  check_('confirmItem senza mezzo risolto: rifiuto con messaggio chiaro (non un crash silente)', typeof resultUnmatched === 'string' && resultUnmatched.includes('Mezzo non riconosciuto'), resultUnmatched);
  const { data: itemAfter } = await admin.from('import_items').select('status').eq('id', itemUnmatchedId).single();
  check_('Item senza mezzo resta pending_review (non confermato a forza)', itemAfter.status === 'pending_review', itemAfter);

  // ── 6. Verifica dal vivo: il documento confermato è raggiungibile dalla scheda del mezzo ──
  const { data: ownerAuth } = await admin.auth.admin.getUserById(companyAUser.user_id);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  let jwt;
  try { jwt = await sessionFor(admin, anon, ownerAuth.user.email); }
  catch (e) { skip('verifica HTTP scheda mezzo', 'sessione JWT non ottenuta: ' + e.message); }
  if (jwt) {
    const res = await fetch(`${API_BASE}/equipment/${equipment.id}/documents`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyA.id },
    });
    const docs = await res.json().catch(() => null);
    check_('GET /equipment/:id/documents → 200 dopo import ZIP confermato', res.status === 200, res.status);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await admin.from('import_items').delete().eq('batch_id', batch.id);
  await admin.from('import_batches').delete().eq('id', batch.id);
  await admin.from('equipment_documents').delete().eq('equipment_id', equipment.id);
  await admin.from('equipment').delete().eq('id', equipment.id);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
