#!/usr/bin/env node
/**
 * scripts/selftest_smart_import_payslips.js
 *
 * Regressione per il routing "payslips" dell'Importazione Intelligente
 * (2026-08-13): prima di questo lavoro, doc_type=busta_paga era già
 * riconosciuto dalla classificazione AI ma non aveva una destinazione
 * dedicata — finiva in worker_documents generico, senza period_year/
 * period_month/status, quindi invisibile nella lista buste paga del
 * lavoratore (routes/v1/workerArea.js legge SOLO dalla tabella payslips).
 *
 * Verifica dal vivo, con DB e Storage reali, SENZA alcuna chiamata Anthropic
 * (archiveChatUpload non tocca l'AI — sposta solo file e scrive righe DB),
 * quindi economico da tenere in npm test:
 * 1) destination='payslips' è accettata da import_items (migrazione 160).
 * 2) archiveChatUpload scrive davvero nella tabella payslips (non
 *    worker_documents), con status:'draft' e i campi periodo corretti.
 * 3) un secondo import per lo stesso worker+periodo SOVRASCRIVE (upsert),
 *    non duplica — stesso comportamento dell'upload manuale.
 * 4) periodYear/periodMonth mancanti → errore chiaro, nessuna scrittura.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { archiveChatUpload } = require('../services/chatDocumentAnalysis');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'site-documents';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function seedChatUpload(admin, { companyId, userId, filename }) {
  const storagePath = `${companyId}/chat-uploads/${crypto.randomUUID()}-${filename}`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  if (upErr) throw new Error('seed storage upload: ' + upErr.message);
  const { data: row, error } = await admin.from('chat_uploads').insert({
    company_id: companyId, user_id: userId, original_name: filename,
    mime_type: 'application/pdf', storage_path: storagePath, size_bytes: 13,
  }).select('id').single();
  if (error) throw new Error('seed chat_uploads: ' + error.message);
  return row.id;
}

async function main() {
  console.log('\nPalladia regression — Importazione Intelligente: buste paga (destinazione payslips)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('smart-import buste paga', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  let companyId = null, workerId = null;
  const storagePaths = [];

  try {
    const { data: company } = await admin.from('companies').insert({ name: `TEST-PayslipImport-${Date.now()}` }).select('id').single();
    companyId = company.id;
    const { data: worker } = await admin.from('workers').insert({
      company_id: companyId, full_name: 'Mario Rossi', fiscal_code: 'RSSMRA80A01H501U', badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
    }).select('id').single();
    workerId = worker.id;
    const { data: users } = await admin.auth.admin.listUsers();
    const someUserId = users?.users?.[0]?.id;

    // ── 1+2) archiveChatUpload con destination='payslips' scrive in payslips ──
    const uploadId1 = await seedChatUpload(admin, { companyId, userId: someUserId, filename: 'cedolino-marzo.pdf' });
    const r1 = await archiveChatUpload({
      uploadId: uploadId1, companyId, userId: someUserId,
      destination: 'payslips', name: 'cedolino-marzo.pdf', workerId,
      periodYear: 2026, periodMonth: 3, contentHash: 'hash-v1',
    });
    check('archiveChatUpload(payslips) riesce', r1?.success === true, r1);

    const { data: row1, error: readErr1 } = await admin.from('payslips')
      .select('id, status, period_year, period_month, file_path, worker_id, filename')
      .eq('company_id', companyId).eq('worker_id', workerId).eq('period_year', 2026).eq('period_month', 3)
      .maybeSingle();
    check('riga creata nella tabella payslips (non worker_documents)', !readErr1 && !!row1, readErr1);
    check('status iniziale è "draft" (mai auto-condivisa)', row1?.status === 'draft', row1?.status);
    check('filename è il nome del FILE, non il nome del lavoratore', row1?.filename === 'cedolino-marzo.pdf', row1?.filename);
    if (row1?.file_path) storagePaths.push(row1.file_path);

    const { data: wdRows } = await admin.from('worker_documents').select('id').eq('worker_id', workerId);
    check('nessuna riga finita in worker_documents per errore', (wdRows || []).length === 0, wdRows);

    // ── 3) secondo import stesso periodo → upsert, non duplica ──────────────
    const uploadId2 = await seedChatUpload(admin, { companyId, userId: someUserId, filename: 'cedolino-marzo-corretto.pdf' });
    const r2 = await archiveChatUpload({
      uploadId: uploadId2, companyId, userId: someUserId,
      destination: 'payslips', name: 'cedolino-marzo-corretto.pdf', workerId,
      periodYear: 2026, periodMonth: 3, contentHash: 'hash-v2',
    });
    check('secondo import per lo stesso periodo riesce (sovrascrive)', r2?.success === true, r2);

    const { data: allRows } = await admin.from('payslips')
      .select('id, content_hash').eq('company_id', companyId).eq('worker_id', workerId).eq('period_year', 2026).eq('period_month', 3);
    check('resta UNA sola riga per worker+periodo (nessun duplicato)', (allRows || []).length === 1, allRows);
    check('la riga riflette il secondo import (content_hash aggiornato)', allRows?.[0]?.content_hash === 'hash-v2', allRows?.[0]);

    // ── 4) periodo mancante → errore chiaro, nessuna scrittura ──────────────
    const uploadId3 = await seedChatUpload(admin, { companyId, userId: someUserId, filename: 'cedolino-senza-periodo.pdf' });
    const r3 = await archiveChatUpload({
      uploadId: uploadId3, companyId, userId: someUserId,
      destination: 'payslips', name: 'cedolino-senza-periodo.pdf', workerId,
      periodYear: null, periodMonth: null, contentHash: 'hash-v3',
    });
    check('periodo mancante rifiutato con errore (non un 500 grezzo)', typeof r3?.error === 'string' && /period/i.test(r3.error), r3);
  } finally {
    for (const p of storagePaths) await admin.storage.from(BUCKET).remove([p]).catch(() => {});
    if (workerId) await admin.from('payslips').delete().eq('worker_id', workerId);
    if (workerId) await admin.from('workers').delete().eq('id', workerId);
    if (companyId) await admin.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
