#!/usr/bin/env node
/**
 * scripts/selftest_badge_help_request.js
 *
 * Regressione per F-171 (AUDIT.md, 2026-09-11): un lavoratore (Canameti
 * Ibrahim) non riusciva a timbrare per un GPS bloccato a ±2000m di
 * precisione (probabile "posizione approssimativa" invece di "precisa" sul
 * permesso Android, o modalità localizzazione a risparmio batteria) — il
 * messaggio esistente ("Spostati all'aperto") è sbagliato per questo caso
 * (non è un problema di segnale/copertura) e non c'era alcun modo per il
 * lavoratore di segnalarlo senza dover mettere mano alle impostazioni del
 * telefono. Aggiunto POST /api/v1/badge/:code/help-request — un tap dalla
 * pagina badge avvisa subito l'amministratore (notifica in-app +
 * Telegram), che registra lui la timbratura da Correzione manuale.
 *
 * Verifica: 404/403/400 sui casi invalidi; 200 sul caso valido con una riga
 * reale in admin_audit_log e una notifica in-app (tabella `notifications`)
 * — mai una scrittura in presence_logs (il tentativo non è una timbratura).
 *
 * Env: TEST_BASE_URL (default produzione), SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function newBadgeCode() { return crypto.randomBytes(9).toString('hex').toUpperCase(); }

async function helpRequest(code, body) {
  const res = await fetch(`${BASE}/api/v1/badge/${code}/help-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log('\nPalladia regression — POST /badge/:code/help-request (F-171)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('badge help-request', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F171-HelpRequest' }]).select('id').single();
  const companyId = company.id;
  const { data: site } = await admin.from('sites').insert([{
    company_id: companyId, name: 'TEST-Cantiere-F171', address: 'Via Test', status: 'attivo',
  }]).select('id').single();
  const { data: otherCompany } = await admin.from('companies').insert([{ name: 'TEST-F171-OtherCompany' }]).select('id').single();
  const { data: otherSite } = await admin.from('sites').insert([{
    company_id: otherCompany.id, name: 'TEST-Cantiere-F171-Other', address: 'Via Altra', status: 'attivo',
  }]).select('id').single();

  const badge = newBadgeCode();
  const { data: worker } = await admin.from('workers').insert([{
    company_id: companyId, full_name: 'TEST-F171-Worker', fiscal_code: 'TSTF1710A01H501Z',
    qualification: 'Muratore', is_active: true, badge_code: badge,
  }]).select('id').single();

  try {
    const invalidCode = await helpRequest('NOTACODE');
    check('codice badge non valido → 400', invalidCode.status === 400, invalidCode);

    const noSite = await helpRequest(badge, {});
    check('senza site_id → 400', noSite.status === 400, noSite);

    const badgeNotFound = await helpRequest(newBadgeCode(), { site_id: site.id });
    check('badge inesistente → 404', badgeNotFound.status === 404, badgeNotFound);

    const wrongCompanySite = await helpRequest(badge, { site_id: otherSite.id });
    check('cantiere di un\'altra company → 403 COMPANY_MISMATCH', wrongCompanySite.status === 403 && wrongCompanySite.data.error === 'COMPANY_MISMATCH', wrongCompanySite);

    const before = Date.now();
    const valid = await helpRequest(badge, { site_id: site.id, reason: 'GPS_ACCURACY_TOO_LOW' });
    check('richiesta valida → 200 ok:true', valid.status === 200 && valid.data.ok === true, valid);

    // Reason non valido/mancante → normalizzato a OTHER, mai un errore
    const otherReason = await helpRequest(badge, { site_id: site.id, reason: 'qualcosa-di-strano' });
    check('reason non riconosciuto → comunque 200 (normalizzato a OTHER)', otherReason.status === 200, otherReason);

    await new Promise(r => setTimeout(r, 800)); // insert fire-and-forget

    const { data: auditRows } = await admin.from('admin_audit_log')
      .select('action, payload, target_id, created_at')
      .eq('company_id', companyId).eq('action', 'punch.help_requested').eq('target_id', worker.id)
      .order('created_at', { ascending: true });
    check('almeno una riga in admin_audit_log con action punch.help_requested', (auditRows || []).length >= 1, auditRows);
    // La prima riga corrisponde alla richiesta con reason=GPS_ACCURACY_TOO_LOW
    // inviata sopra — la seconda (reason non riconosciuto) arriva dopo.
    check('il payload registra cantiere e motivo', auditRows?.[0]?.payload?.site_id === site.id && auditRows?.[0]?.payload?.reason === 'GPS_ACCURACY_TOO_LOW', auditRows?.[0]);

    const { data: notifRows } = await admin.from('notifications')
      .select('type, severity, title, body, created_at')
      .eq('company_id', companyId).eq('type', 'punch_help_request')
      .gte('created_at', new Date(before - 5000).toISOString());
    check('almeno una notifica in-app creata', (notifRows || []).length >= 1, notifRows);
    check('la notifica cita il nome del lavoratore', (notifRows?.[0]?.title || '').includes('TEST-F171-Worker'), notifRows?.[0]);

    const { data: presenceRows } = await admin.from('presence_logs').select('id').eq('worker_id', worker.id);
    check('nessuna scrittura in presence_logs — non è una timbratura', (presenceRows || []).length === 0, presenceRows);

  } finally {
    await admin.from('admin_audit_log').delete().eq('company_id', companyId);
    await admin.from('notifications').delete().eq('company_id', companyId);
    await admin.from('presence_logs').delete().eq('company_id', companyId);
    await admin.from('workers').delete().eq('company_id', companyId);
    await admin.from('sites').delete().in('company_id', [companyId, otherCompany.id]);
    await admin.from('companies').delete().in('id', [companyId, otherCompany.id]);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
