#!/usr/bin/env node
/**
 * scripts/selftest_studio_durc_alert_dedup.js
 *
 * Regressione per F-087 (AUDIT.md, BLOCCO 4): services/studioDurcAlertCron.js
 * inviava una email identica allo stesso studio, per lo stesso cliente, OGNI
 * GIORNO in cui il DURC restava entro la finestra di 30 giorni — la query non
 * aveva un limite inferiore, quindi un DURC scaduto da mesi e mai rinnovato
 * generava un'email quotidiana all'infinito. Nessun meccanismo di dedup
 * (a differenza di expiryHelper.upsertNotification usato dagli altri cron).
 *
 * Fix: tabella studio_durc_alert_log (migrazione 178) + shouldAlertStudioDurc()/
 * pruneStudioDurcAlerts() — stessa regola isNew/escalated/critical-sempre.
 *
 * Deliberatamente NON invoca il vero invio Resend (stessa scelta documentata
 * in selftest_billing_renewal_notice.js per F-058): il bug e il fix riguardano
 * la DECISIONE di inviare (dedup a livello studio+company), non la meccanica
 * di consegna Resend — già verificata in produzione su altri cron. Lo spy
 * intercetta la chiamata esattamente al confine di rete, tutto il resto
 * (lettura DURC reale, calcolo severità, lettura/scrittura studio_durc_alert_log)
 * gira contro Supabase reale con fixture temporanee.
 */
'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — dedup alert DURC studio (F-087)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('studio DURC alert dedup', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  // Spy sul confine di rete PRIMA di richiedere il modulo sotto test.
  const emailPath = require.resolve('../services/email');
  const sentCalls = [];
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendStudioDurcAlert: async (args) => { sentCalls.push(args); return { id: 'stub' }; } },
  };
  delete require.cache[require.resolve('../services/studioDurcAlertCron')];
  const { runStudioDurcAlertCheck, shouldAlertStudioDurc } = require('../services/studioDurcAlertCron');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const suffix = Date.now();
  let studioUserId = null, studioId = null, companyId = null;

  try {
    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email: `studio-durc-test-${suffix}@palladia-test.local`, email_confirm: true, password: `Test-${suffix}-Aa1!`,
    });
    check('Creato utente studio temporaneo', !userErr && !!userData?.user?.id, userErr);
    studioUserId = userData?.user?.id;

    const { data: studio, error: studioErr } = await admin.from('studio_partners')
      .insert({ user_id: studioUserId, studio_name: `TEST-Studio-Dedup-${suffix}` })
      .select('id').single();
    check('Creato studio_partners temporaneo', !studioErr && !!studio?.id, studioErr);
    studioId = studio?.id;

    const warningDate = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0]; // entro 30gg → warning
    const { data: company, error: companyErr } = await admin.from('companies')
      .insert({ name: `TEST-DurcDedup-${suffix}`, durc_expiry_date: warningDate })
      .select('id').single();
    check('Creata company cliente temporanea con DURC in scadenza', !companyErr && !!company?.id, companyErr);
    companyId = company?.id;

    const { error: linkErr } = await admin.from('studio_clients')
      .insert({ studio_id: studioId, company_id: companyId, status: 'active' });
    check('Collegato cliente allo studio', !linkErr, linkErr);

    // ── Run 1: prima volta → deve alertare ────────────────────────────────
    await runStudioDurcAlertCheck();
    check('Run 1 (prima volta, severity=warning): invio effettuato', sentCalls.length === 1, sentCalls.length);

    // ── Run 2: stesso giorno, stessa severity → NON deve rialertare (F-087) ──
    await runStudioDurcAlertCheck();
    check('Run 2 (stessa severity, nessun cambiamento): NESSUN nuovo invio — dedup attivo', sentCalls.length === 1, sentCalls.length);

    // ── Escalation a critical (DURC scaduto) → deve alertare di nuovo ─────
    await admin.from('companies').update({ durc_expiry_date: '2020-01-01' }).eq('id', companyId);
    await runStudioDurcAlertCheck();
    check('Run 3 (escalation a critical): nuovo invio (severità peggiorata)', sentCalls.length === 2, sentCalls.length);

    // ── Critical resta critical → per design ogni giorno finché non risolto ──
    await runStudioDurcAlertCheck();
    check('Run 4 (ancora critical, invariato): re-invio quotidiano voluto (come workerExpiryCron)', sentCalls.length === 3, sentCalls.length);

    // ── Risoluzione: DURC rinnovato oltre 30gg → prune, nessun invio ──────
    const renewedDate = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];
    await admin.from('companies').update({ durc_expiry_date: renewedDate }).eq('id', companyId);
    await runStudioDurcAlertCheck();
    check('Run 5 (DURC rinnovato, fuori finestra): nessun nuovo invio', sentCalls.length === 3, sentCalls.length);

    const { data: logRow } = await admin.from('studio_durc_alert_log')
      .select('id').eq('studio_id', studioId).eq('company_id', companyId).maybeSingle();
    check('Tracking prunato dopo risoluzione (nessuna riga residua)', !logRow, logRow);

    // ── Verifica diretta della funzione di decisione (unità, contro DB reale) ──
    const decisionNew = await shouldAlertStudioDurc(studioId, companyId, 'info');
    check('shouldAlertStudioDurc: nuova coppia studio+company → true', decisionNew === true, decisionNew);
    const decisionSame = await shouldAlertStudioDurc(studioId, companyId, 'info');
    check('shouldAlertStudioDurc: stessa severity → false', decisionSame === false, decisionSame);

  } finally {
    if (companyId) await admin.from('studio_durc_alert_log').delete().eq('company_id', companyId);
    if (companyId) await admin.from('studio_clients').delete().eq('company_id', companyId);
    if (companyId) await admin.from('companies').delete().eq('id', companyId);
    if (studioId) await admin.from('studio_partners').delete().eq('id', studioId);
    if (studioUserId) await admin.auth.admin.deleteUser(studioUserId).catch(() => {});
    delete require.cache[emailPath];
    delete require.cache[require.resolve('../services/studioDurcAlertCron')];
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
