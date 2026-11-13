#!/usr/bin/env node
/**
 * scripts/selftest_f494_buste_solo_ufficio.js
 *
 * Regressione per F-494 (AUDIT.md del frontend, 13/11/2026): le buste paga le
 * vedevano tutti gli account dell'impresa, anche «tech» (capocantiere) e
 * «viewer». Verificato dal vivo: un tech apriva l'elenco con i nomi, il PDF e
 * leggeva la tabella direttamente col suo JWT. Decisione del titolare: le
 * buste le vede l'ufficio, cioè titolare (owner) e amministratori (admin).
 *
 * Dal vivo, con sessioni vere (magiclink+verifyOtp) e lo stesso header
 * X-Company-Id dell'app:
 *  - tech e viewer: 403 su ogni strada delle buste (elenchi, PDF, condividi,
 *    ritira, «buste per me», prospetti del commercialista), nessuna riga
 *    «payslips» nell'archivio documenti, 0 righe leggendo payslips e
 *    documents direttamente (RLS), nessun link firmato dallo storage;
 *  - owner e admin: continuano a vederle e ad aprirle.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY o
 * SUPABASE_KEY (la chiave pubblica). Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '') + '/api/v1';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}

async function main() {
  console.log('\nPalladia regression — F-494: buste paga solo a titolare e amministratori\n');
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    console.log('  – skip: fixture Supabase non configurate in questo ambiente');
    return;
  }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company, error: cErr } = await admin.from('companies').insert([{ name: 'TEST-F494-BusteSoloUfficio' }]).select('id').single();
  if (cErr) throw new Error('company: ' + cErr.message);
  const utenti = {};
  const userIds = [];
  try {
    for (const role of ['owner', 'admin', 'tech', 'viewer']) {
      const email = `test-f494-${role}-${crypto.randomUUID()}@example.com`;
      const { data: u, error } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
      if (error) throw new Error('createUser: ' + error.message);
      userIds.push(u.user.id);
      await admin.from('company_users').insert([{ company_id: company.id, user_id: u.user.id, role }]);
      const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      const { data: ses, error: vErr } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
      if (vErr) throw new Error('verifyOtp: ' + vErr.message);
      utenti[role] = ses.session.access_token;
    }

    const { data: worker } = await admin.from('workers').insert([{
      company_id: company.id, full_name: 'Mario Riservato', fiscal_code: `F494${Date.now()}`.slice(0, 16),
      qualification: 'Muratore', is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
    }]).select('id').single();
    const filePath = `payslips/${company.id}/${worker.id}/2026-10.pdf`;
    await admin.storage.from('site-documents').upload(filePath, Buffer.from('%PDF-1.4 F-494'), { contentType: 'application/pdf', upsert: true });
    const { data: busta, error: bErr } = await admin.from('payslips').insert([{
      company_id: company.id, worker_id: worker.id, period_year: 2026, period_month: 10,
      filename: 'Busta paga Ottobre 2026.pdf', file_path: filePath, file_size: 14, status: 'shared', shared_at: new Date().toISOString(),
    }]).select('id').single();
    if (bErr) throw new Error('payslip: ' + bErr.message);

    const call = async (role, method, path) => {
      const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${utenti[role]}`, 'X-Company-Id': company.id } });
      let body = null; try { body = await r.json(); } catch { /* vuoto */ }
      return { status: r.status, body };
    };
    const strade = [
      ['GET', '/payslips/shared'], ['GET', '/payslips/draft'], ['GET', `/workers/${worker.id}/payslips`],
      ['GET', `/payslips/${busta.id}/download`], ['PATCH', `/payslips/${busta.id}/unshare`], ['PATCH', `/payslips/${busta.id}/share`],
      ['GET', '/studio/payslips-for-me'], ['GET', `/studio/payslips-for-me/${busta.id}/download`], ['GET', '/buste/riepiloghi'],
    ];

    for (const role of ['tech', 'viewer']) {
      for (const [m, p] of strade) {
        const r = await call(role, m, p);
        check(`${role}: ${m} ${p.replace(company.id, ':co').replace(busta.id, ':id').replace(worker.id, ':w')} → 403`, r.status === 403, r);
      }
      const arch = await call(role, 'GET', '/archive/documents?source_tables=payslips');
      const righe = Array.isArray(arch.body?.results) ? arch.body.results : [];
      check(`${role}: archivio documenti senza buste paga`, !righe.some(d => d.source_table === 'payslips'), arch);

      const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${utenti[role]}` } }, auth: { persistSession: false } });
      const { data: p1 } = await db.from('payslips').select('id').eq('company_id', company.id);
      check(`${role}: tabella payslips letta col suo JWT → 0 righe`, (p1 || []).length === 0, p1);
      const { data: d1 } = await db.from('documents').select('id').eq('company_id', company.id).eq('source_table', 'payslips');
      check(`${role}: tabella documents (righe buste) letta col suo JWT → 0 righe`, (d1 || []).length === 0, d1);
      const { data: s1 } = await db.storage.from('site-documents').createSignedUrl(filePath, 60);
      check(`${role}: nessun link firmato al PDF dallo storage`, !s1?.signedUrl, s1);
    }

    // Lo stato della busta non deve essere cambiato dai tentativi sopra
    const { data: dopo } = await admin.from('payslips').select('status').eq('id', busta.id).single();
    check('i tentativi di tech/viewer non hanno toccato la busta (resta condivisa)', dopo?.status === 'shared', dopo);

    for (const role of ['owner', 'admin']) {
      const l = await call(role, 'GET', '/payslips/shared');
      check(`${role}: vede la busta nell'elenco`, l.status === 200 && Array.isArray(l.body) && l.body.some(x => x.id === busta.id), l);
      const d = await call(role, 'GET', `/payslips/${busta.id}/download`);
      check(`${role}: apre il PDF`, d.status === 200 && !!d.body?.url, d);
      const r = await call(role, 'GET', '/buste/riepiloghi');
      check(`${role}: vede i prospetti del commercialista`, r.status === 200 && Array.isArray(r.body), r);
      const ar = await call(role, 'GET', '/archive/documents?source_tables=payslips');
      check(`${role}: nell'archivio documenti la busta c'è (controprova del filtro)`, Array.isArray(ar.body?.results) && ar.body.results.some(d => d.source_table === 'payslips'), ar);
    }

    // Ladia (get_payslips, codice locale): stessa regola, anche senza req (bot) col ruolo dal DB
    const { executeTool } = require('../routes/v1/chat');
    for (const role of ['tech', 'viewer']) {
      const r = await executeTool('get_payslips', {}, company.id, userIds[['owner', 'admin', 'tech', 'viewer'].indexOf(role)], { userRole: role });
      check(`Ladia a un ${role}: rifiuta, nessuna busta`, !!r.error && !r.cedolini, r);
    }
    const rBot = await executeTool('get_payslips', {}, company.id, userIds[2], null);
    check('Ladia senza req (ruolo letto dal DB, tech): rifiuta', !!rBot.error && !rBot.cedolini, rBot);
    const rOwner = await executeTool('get_payslips', {}, company.id, userIds[0], { userRole: 'owner' });
    check('Ladia al titolare: elenca la busta', Array.isArray(rOwner.cedolini) && rOwner.cedolini.some(c => c.id === busta.id), rOwner);
  } finally {
    await admin.from('payslips').delete().eq('company_id', company.id);
    await admin.from('workers').delete().eq('company_id', company.id);
    await admin.from('company_users').delete().eq('company_id', company.id);
    await admin.from('companies').delete().eq('id', company.id);
    for (const id of userIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error("ERRORE:", e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
