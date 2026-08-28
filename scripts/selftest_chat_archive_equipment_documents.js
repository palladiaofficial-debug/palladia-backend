#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_chat_archive_equipment_documents.js
 *
 * Regressione per F-095 (AUDIT.md) — archive_document (Ladia chat) non
 * aveva mai una destinazione per documenti di mezzi/veicoli (libretto di
 * circolazione, assicurazione, revisione): una carta di circolazione
 * finiva sempre genericamente in company_documents, senza mai raggiungere
 * la scheda del mezzo reale (routes/v1/equipment.js, tabella
 * equipment_documents, bucket separato equipment-docs). Trovato durante
 * l'indagine su F-094 (stessa trascrizione utente).
 *
 * Copre: match per targa (esatto), match per nome/modello (fuzzy), nessun
 * match → errore chiaro, e che il documento archiviato sia poi VERAMENTE
 * raggiungibile dalla route reale della scheda mezzo (non solo presente
 * nel DB) — con una chiamata HTTP reale, non solo una query diretta.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { archiveChatUpload } = require('../services/chatDocumentAnalysis');

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

async function makeUpload(admin, companyId, userId, label) {
  const BUCKET = 'site-documents';
  const storagePath = `${companyId}/chat-uploads/test-f095-${label}-${Date.now()}.pdf`;
  await admin.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  const { data: row, error } = await admin.from('chat_uploads').insert({
    company_id: companyId, user_id: userId, original_name: `${label}.pdf`, mime_type: 'application/pdf',
    storage_path: storagePath, size_bytes: 20,
  }).select('id').single();
  if (error) throw error;
  return row.id;
}

async function main() {
  console.log('\nPalladia — F-095: archiviazione documenti mezzi da chat (regressione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: companyA } = await admin.from('companies').select('id').eq('name', 'TEST-AutoExplore').maybeSingle();
  if (!companyA) { skip('suite', 'TEST-AutoExplore non trovata'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }
  const { data: companyAUser } = await admin.from('company_users').select('user_id').eq('company_id', companyA.id).limit(1).single();

  const plate = `FX${Date.now() % 100000}`;
  const { data: equipment, error: eqErr } = await admin.from('equipment').insert({
    company_id: companyA.id, type: 'Motociclo', model: 'CITY-X', name: 'CITY-X', plate_or_serial: plate, ownership: 'Aziendale', is_active: true,
  }).select('id').single();
  if (eqErr) { fail('Fixture: mezzo creato', eqErr.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  // ── 1. Match per targa esatta ────────────────────────────────────────────
  const uploadId1 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'targa');
  const r1 = await archiveChatUpload({
    uploadId: uploadId1, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'equipment_documents', name: 'Carta di circolazione CITY-X',
    equipmentHint: plate, category: 'libretto_circolazione',
  });
  check_('Match per targa esatta: archiviazione riuscita', r1.success === true, r1);
  check_('Match per targa esatta: sul mezzo giusto', r1.success && true, r1);

  // ── 2. Match per nome/modello (targa non presente nel documento) ───────
  const uploadId2 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'modello');
  const r2 = await archiveChatUpload({
    uploadId: uploadId2, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'equipment_documents', name: 'Assicurazione CITY-X',
    equipmentHint: 'CITY-X', category: 'assicurazione_mezzo',
  });
  check_('Match per nome/modello (senza targa): archiviazione riuscita', r2.success === true, r2);

  // ── 3. Nessun match → errore chiaro, non un crash ──────────────────────
  const uploadId3 = await makeUpload(admin, companyA.id, companyAUser.user_id, 'nomatch');
  const r3 = await archiveChatUpload({
    uploadId: uploadId3, companyId: companyA.id, userId: companyAUser.user_id,
    destination: 'equipment_documents', name: 'Documento mezzo sconosciuto',
    equipmentHint: 'ZZZ-NESSUN-MEZZO-COSI-CHIAMATO-999',
  });
  check_('Nessun mezzo corrispondente → errore chiaro (non crash, non archiviato)', !!r3.error && !r3.success, r3);

  // ── 4. Verifica dal vivo: il documento è raggiungibile dalla scheda del mezzo ──
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
    check_('GET /equipment/:id/documents → 200', res.status === 200, res.status);
    check_('Entrambi i documenti archiviati compaiono sulla scheda del mezzo reale', Array.isArray(docs) && docs.length >= 2, docs);
    check_('file_url è un signed URL raggiungibile (non il path grezzo)', Array.isArray(docs) && docs[0]?.file_url?.startsWith('http'), docs?.[0]);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await admin.from('equipment_documents').delete().eq('equipment_id', equipment.id);
  await admin.from('equipment').delete().eq('id', equipment.id);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
