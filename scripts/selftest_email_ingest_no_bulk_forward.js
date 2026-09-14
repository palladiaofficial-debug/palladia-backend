#!/usr/bin/env node
/**
 * scripts/selftest_email_ingest_no_bulk_forward.js
 *
 * Regressione per F-106 (AUDIT.md, 2026-09-01 → RISOLTO 2026-09-14): il
 * wizard "Fatture via Email" istruiva l'utente a impostare un inoltro
 * AUTOMATICO su tutti i messaggi in arrivo della propria casella, senza mai
 * avvisare che questo devia l'intera corrispondenza — un cliente l'ha
 * impostato sulla casella principale della sua azienda e ha smesso di
 * ricevere ogni email per giorni. Nuove attivazioni/deleghe erano state
 * sospese (FROZEN_FEATURES) come contenimento.
 *
 * Fix reale (non solo il contenimento): lib/emailIngestProviders.js non
 * istruisce più nessuna regola/filtro automatico — solo un inoltro MANUALE
 * messaggio per messaggio (lo stesso gesto già usato per girare una fattura
 * via WhatsApp), che per costruzione non può mai catturare il resto della
 * posta. Il flag è stato tolto da FROZEN_FEATURES e riattivato di default.
 *
 * Questo test protegge sul CONTENUTO, non solo sul comportamento — il modo
 * in cui l'incidente originale è successo era testuale (un'istruzione scritta
 * male), quindi la regressione che conta di più è "nessuna istruzione futura
 * torna a dire 'tutti i messaggi'/'ogni email in arrivo'", non solo "il flag
 * è ON". Nessun server richiesto: import diretto dei moduli.
 */
'use strict';
require('dotenv').config();
const { isFeatureEnabled, FROZEN_FEATURES } = require('../lib/featureFlags');
const { EMAIL_PROVIDERS } = require('../lib/emailIngestProviders');

const MASTER_COMPANY_ID = (process.env.MASTER_COMPANY_IDS || '').split(',')[0]?.trim() || null;
const REAL_COMPANY_ID   = 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }

// Frasi che indicano una regola/filtro APPLICATO A TUTTA LA POSTA — esattamente
// il pattern che ha causato l'incidente. Case-insensitive, cerca in ogni step
// e in ogni confirmNote di ogni provider.
const DANGEROUS_PATTERNS = [
  /tutt[ei]\s+i\s+messaggi/i,
  /ogni\s+email\s+in\s+arrivo/i,
  /inoltro\s+automatic/i,
  /regola\s+(di\s+)?inoltro/i,
  /filtro/i,
  /condizione\s+ampia/i,
];

(async () => {
  console.log('\n=== selftest_email_ingest_no_bulk_forward (F-106, risolto) ===\n');

  // ── 1. Il flag non è più congelato, ed è ON di default ──────────────────
  if (!FROZEN_FEATURES.has('email_ingest_manual_forward_setup')) {
    ok('email_ingest_manual_forward_setup non è più in FROZEN_FEATURES');
  } else {
    fail('email_ingest_manual_forward_setup non è più in FROZEN_FEATURES', [...FROZEN_FEATURES]);
  }

  const realCompany = await isFeatureEnabled(REAL_COMPANY_ID, 'email_ingest_manual_forward_setup');
  if (realCompany === true) ok('email_ingest_manual_forward_setup attivo di default per una company reale senza override');
  else fail('email_ingest_manual_forward_setup attivo di default per una company reale senza override', realCompany);

  if (MASTER_COMPANY_ID) {
    const masterCompany = await isFeatureEnabled(MASTER_COMPANY_ID, 'email_ingest_manual_forward_setup');
    if (masterCompany === true) ok('email_ingest_manual_forward_setup attivo anche per la master company (non più un caso speciale frozen)');
    else fail('email_ingest_manual_forward_setup attivo anche per la master company', masterCompany);
  } else {
    console.log('  \x1b[33m–\x1b[0m test master company (skip: MASTER_COMPANY_IDS non impostata in questo ambiente)');
  }

  // ── 2. Il contenuto reale delle istruzioni non menziona MAI un inoltro
  //       che copre tutta la posta — questa è la vera regressione da evitare ──
  if (EMAIL_PROVIDERS.length >= 5) {
    ok(`lib/emailIngestProviders.js espone ${EMAIL_PROVIDERS.length} provider (Aruba/Legalmail/Namirial/Gmail/Outlook attesi)`);
  } else {
    fail('lib/emailIngestProviders.js espone almeno 5 provider', EMAIL_PROVIDERS.map(p => p.key));
  }

  let dangerousHits = [];
  for (const provider of EMAIL_PROVIDERS) {
    const allText = [
      ...(provider.steps || []).map(s => s.text),
      provider.confirmNote || '',
    ].join(' \n ');
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(allText)) dangerousHits.push({ provider: provider.key, pattern: pattern.source });
    }
  }
  if (dangerousHits.length === 0) {
    ok('NESSUN provider menziona una regola/filtro applicato a tutta la posta — solo inoltro manuale per singolo messaggio');
  } else {
    fail('NESSUN provider menziona una regola/filtro applicato a tutta la posta', dangerousHits);
  }

  // ── 3. Ogni provider istruisce esplicitamente "Inoltra" (azione manuale
  //       per singolo messaggio), non un pannello impostazioni ──────────────
  const missingForward = EMAIL_PROVIDERS.filter(p => !(p.steps || []).some(s => /inoltr/i.test(s.text)));
  if (missingForward.length === 0) {
    ok('ogni provider ha almeno un passo che dice esplicitamente di premere "Inoltra"');
  } else {
    fail('ogni provider ha almeno un passo che dice esplicitamente di premere "Inoltra"', missingForward.map(p => p.key));
  }

  // ── 4. Le route che creano una nuova configurazione/delega controllano
  //       ancora il flag (difesa in profondità — per poter disattivare una
  //       singola company via company_feature_flags se mai servisse) ────────
  const emailIngestSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'v1', 'emailIngest.js'), 'utf8');
  const connectBlock  = emailIngestSource.split("router.post('/expenses/email-ingest/connect'")[1]?.split("router.post('/expenses/email-ingest/rotate-token'")[0] || '';
  const delegateBlock = emailIngestSource.split("router.post('/expenses/email-ingest/delegate'")[1] || '';

  if (connectBlock.includes("isFeatureEnabled(req.companyId, 'email_ingest_manual_forward_setup')")) {
    ok('POST /expenses/email-ingest/connect controlla ancora il flag (difesa in profondità per un override per-company)');
  } else {
    fail('POST /expenses/email-ingest/connect controlla ancora il flag');
  }
  if (delegateBlock.includes("isFeatureEnabled(req.companyId, 'email_ingest_manual_forward_setup')")) {
    ok('POST /expenses/email-ingest/delegate controlla ancora il flag (difesa in profondità per un override per-company)');
  } else {
    fail('POST /expenses/email-ingest/delegate controlla ancora il flag');
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  // process.exitCode invece di process.exit(): vedi selftest_worker_certificates_
  // chat_sync.js / F-107 per il perché su Windows.
  process.exitCode = failed > 0 ? 1 : 0;
})().catch(e => {
  console.error('Errore imprevisto:', e.message);
  process.exitCode = 1;
});
