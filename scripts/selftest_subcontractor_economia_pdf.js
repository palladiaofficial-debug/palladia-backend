#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_subcontractor_economia_pdf.js
 *
 * Regressione per F-189 (AUDIT.md, 2026-09-14): richiesta esplicita del
 * titolare dopo aver visto la schermata Economia subappaltatore —
 * "esportabilità? condivisione?" — mancava un PDF "estratto conto" da
 * poter stampare/condividere, stile Palladia.
 *
 * Verifica dal vivo, HTTP reale, con lo stesso JWT che userebbe l'app:
 * 1) GET .../economia/pdf risponde 200, application/pdf.
 * 2) il PDF è un PDF vero, non un frammento — lo si riapre con lo stesso
 *    estrattore testo usato altrove nel repo (lib/pdfExtract.js).
 * 3) il testo estratto contiene i numeri VERI (non un placeholder):
 *    nome subappaltatore, nome cantiere, appalto/acconti/saldo esatti.
 * 4) isolamento multi-tenant: il JWT di un'altra azienda riceve 404, non
 *    un PDF con dati di un'altra impresa.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extractPdfText } = require('../lib/pdfExtract');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const BASE          = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — PDF "estratto conto" subappaltatore (F-189)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('subcontractor economia PDF', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  async function makeCompanyWithOwner(name) {
    const { data: company } = await admin.from('companies').insert([{ name }]).select('id').single();
    const email = `test-f189-${crypto.randomUUID()}@example.com`;
    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
    if (userErr) throw new Error('createUser: ' + userErr.message);
    await admin.from('company_users').insert([{ company_id: company.id, user_id: userRes.user.id, role: 'owner' }]);
    return { company, userId: userRes.user.id, email };
  }
  async function jwtFor(email) {
    const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
    const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
    if (verErr) throw verErr;
    return verified.session.access_token;
  }

  const A = await makeCompanyWithOwner('TEST-F189-PdfA');
  const B = await makeCompanyWithOwner('TEST-F189-PdfB');
  const jwtA = await jwtFor(A.email);
  const jwtB = await jwtFor(B.email);

  const { data: sub } = await admin.from('subcontractors').insert([{ company_id: A.company.id, company_name: 'TEST-F189 Ponteggi Verifica Srl', is_active: true }]).select('id').single();
  const { data: site } = await admin.from('sites').insert([{ company_id: A.company.id, name: 'TEST-F189 Cantiere Estratto', address: 'Via Test', status: 'attivo' }]).select('id').single();
  await admin.from('site_subcontractors').insert([{ company_id: A.company.id, site_id: site.id, subcontractor_id: sub.id, budget_totale: 27500, sal_percentuale: 40 }]);
  await admin.from('site_costs').insert([{ company_id: A.company.id, site_id: site.id, subcontractor_id: sub.id, descrizione: 'Acconto', importo: 6000, tipo: 'acconto' }]);

  const r = await fetch(`${BASE}/subcontractors/${sub.id}/economia/pdf`, { headers: { Authorization: 'Bearer ' + jwtA, 'X-Company-Id': A.company.id } });
  check('GET .../economia/pdf → 200', r.status === 200, r.status);
  check('Content-Type application/pdf', (r.headers.get('content-type') || '').includes('application/pdf'), r.headers.get('content-type'));

  const buf = Buffer.from(await r.arrayBuffer());
  check('il body è un PDF vero (magic bytes %PDF)', buf.slice(0, 4).toString('ascii') === '%PDF', buf.slice(0, 8).toString('ascii'));

  let text = '';
  try {
    const extracted = await extractPdfText(buf);
    text = (extracted?.text || extracted || '').toString();
  } catch (e) {
    fail('il PDF si riapre e il testo si estrae senza errori', e.message);
  }
  if (text) {
    check('contiene il nome del subappaltatore', text.includes('TEST-F189 Ponteggi Verifica Srl'), text.slice(0, 300));
    check('contiene il nome del cantiere', text.includes('TEST-F189 Cantiere Estratto'), text.slice(0, 500));
    check('contiene l\'appalto totale esatto (27.500 €)', text.includes('27.500'), text);
    check('contiene gli acconti esatti (6.000 €)', text.includes('6.000'), text);
    check('contiene il saldo da erogare esatto (21.500 €)', text.includes('21.500'), text);
  }

  const rB = await fetch(`${BASE}/subcontractors/${sub.id}/economia/pdf`, { headers: { Authorization: 'Bearer ' + jwtB, 'X-Company-Id': B.company.id } });
  check('company B non riceve il PDF del subappaltatore di company A (404, non un PDF con dati altrui)', rB.status === 404, rB.status);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
