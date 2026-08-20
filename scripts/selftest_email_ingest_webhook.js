#!/usr/bin/env node
/**
 * scripts/selftest_email_ingest_webhook.js
 *
 * Regressione end-to-end per POST /api/v1/expenses/email-ingest/webhook: simula una
 * vera richiesta del Worker Cloudflare (multipart/form-data, stessi nomi campo di
 * Mailgun Routes + header X-Ingest-Secret valido, allegati REALI — un .p7m firmato
 * via openssl e uno .zip con dentro una fattura) contro il server locale in
 * esecuzione, e verifica riga per riga in company_expenses/email_ingest_log che il
 * risultato sia quello atteso — non solo lo status HTTP della risposta.
 *
 * Richiede: server avviato su TEST_BASE_URL (default http://localhost:3001) e
 * CLOUDFLARE_EMAIL_INGEST_SECRET impostata nello stesso ambiente del server (per
 * poter mandare un header che il server accetterà). Se manca, il test si salta.
 *
 * Copre autenticazione/allowlist/dedup/quarantena senza dipendere da DNS o da
 * un'email reale attraverso Cloudflare — quella verifica è Milestone 8, non questa.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const supabase = require('../lib/supabase');
const { startTest, rotateToken } = require('../services/emailIngestConfig');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const INGEST_SECRET = process.env.CLOUDFLARE_EMAIL_INGEST_SECRET;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function buildFatturaXml({ numero, partitaIva = '01234567890', importo = '200.00' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">
  <FatturaElettronicaHeader>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${partitaIva}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Fornitore Webhook Test SRL</Denominazione></Anagrafica>
      </DatiAnagrafici>
    </CedentePrestatore>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Numero>${numero}</Numero>
        <Data>2026-08-15</Data>
        <ImportoTotaleDocumento>${importo}</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi><DettaglioLinee><Descrizione>Materiali edili</Descrizione></DettaglioLinee></DatiBeniServizi>
    <DatiPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento></DettaglioPagamento></DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function generateP7m(xmlString, workDir) {
  const xmlPath = path.join(workDir, 'invoice.xml');
  const keyPath = path.join(workDir, 'key.pem');
  const certPath = path.join(workDir, 'cert.pem');
  const p7mPath = path.join(workDir, 'invoice.xml.p7m');
  fs.writeFileSync(xmlPath, xmlString, 'utf8');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=Test/O=Palladia'], { stdio: 'pipe' });
  execFileSync('openssl', ['smime', '-sign', '-in', xmlPath, '-signer', certPath, '-inkey', keyPath, '-outform', 'DER', '-out', p7mPath, '-nodetach'], { stdio: 'pipe' });
  return fs.readFileSync(p7mPath);
}

function buildAuthResultsHeader({ spfPass = true, dkimPass = true } = {}) {
  return `mx.cloudflare.net; spf=${spfPass ? 'pass' : 'fail'} smtp.mailfrom=test; dkim=${dkimPass ? 'pass' : 'fail'} header.d=test`;
}

async function postWebhook({ recipient, sender, files, spfPass = true, dkimPass = true, validSecret = true, subject = 'Fattura di test — selftest webhook' }) {
  const token = crypto.randomBytes(16).toString('hex');

  const messageHeaders = JSON.stringify([
    ['Message-Id', `<test-${token}@example.com>`],
    ['Authentication-Results', buildAuthResultsHeader({ spfPass, dkimPass })],
  ]);

  const form = new FormData();
  form.append('recipient', recipient);
  form.append('sender', sender);
  form.append('from', sender);
  form.append('subject', subject);
  form.append('message-headers', messageHeaders);
  for (const f of files) {
    form.append(f.field, new Blob([f.buffer]), f.filename);
  }

  const headers = validSecret ? { 'X-Ingest-Secret': INGEST_SECRET } : { 'X-Ingest-Secret': 'chiave-sbagliata' };
  const res = await fetch(`${BASE}/api/v1/expenses/email-ingest/webhook`, { method: 'POST', body: form, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log('\n=== selftest_email_ingest_webhook ===\n');

  if (!INGEST_SECRET) {
    skip('webhook end-to-end', 'CLOUDFLARE_EMAIL_INGEST_SECRET non impostata in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }

  let healthy = false;
  try { healthy = (await fetch(`${BASE}/`)).ok || true; } catch { healthy = false; }
  if (!healthy) {
    skip('webhook end-to-end', `server non raggiungibile su ${BASE}`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }

  const { data: company, error: companyErr } = await supabase.from('companies').insert({ name: 'TEST-Email-Ingest-Webhook-Probe' }).select().single();
  check('Creata azienda temporanea', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;
  const inboundToken = crypto.randomBytes(12).toString('hex');
  const allowedSender = 'fornitore@esempio-test.it';

  try {
    const { error: cfgErr } = await supabase.from('email_ingest_configurations').insert({ company_id: companyId, inbound_token: inboundToken, status: 'active' });
    check('Configurazione canale email creata', !cfgErr, cfgErr);

    const { error: allowErr } = await supabase.from('email_ingest_allowed_senders').insert({ company_id: companyId, email_address: allowedSender, action: 'allow' });
    check('Mittente autorizzato in allowlist', !allowErr, allowErr);

    const recipient = `${inboundToken}@palladia.net`;

    // ── Caso 1: header segreto non valido → 401, nessun log scritto ─────────
    const badSig = await postWebhook({ recipient, sender: allowedSender, files: [], validSecret: false });
    check('header segreto non valido → HTTP 401', badSig.status === 401, badSig);

    // ── Caso 2: token sconosciuto → 200, outcome unknown_token ──────────────
    const unknown = await postWebhook({ recipient: 'nonesiste0000@palladia.net', sender: allowedSender, files: [] });
    check('token sconosciuto → outcome unknown_token', unknown.status === 200 && unknown.body.outcome === 'unknown_token', unknown.body);

    // ── Caso 3: mittente MAI autorizzato → quarantena ────────────────────────
    const quarantined = await postWebhook({ recipient, sender: 'sconosciuto@altrodominio.it', files: [] });
    check('mittente sconosciuto → quarantined_unknown_sender', quarantined.status === 200 && quarantined.body.outcome === 'quarantined_unknown_sender', quarantined.body);

    // ── Caso 4: mittente autorizzato ma SPF/DKIM falliti → quarantena ──────
    const failedAuth = await postWebhook({ recipient, sender: allowedSender, files: [], spfPass: false, dkimPass: false });
    check('SPF/DKIM falliti → quarantined_failed_auth', failedAuth.status === 200 && failedAuth.body.outcome === 'quarantined_failed_auth', failedAuth.body);

    // ── Caso 5: XML puro valido, mittente autorizzato, auth ok → accettata ──
    const xmlBuf = Buffer.from(buildFatturaXml({ numero: '2026/WH-1' }), 'utf8');
    const accepted = await postWebhook({ recipient, sender: allowedSender, files: [{ field: 'attachment-1', filename: 'fattura.xml', buffer: xmlBuf }] });
    check('XML valido da mittente autorizzato → accepted, 1 importata', accepted.status === 200 && accepted.body.outcome === 'accepted' && accepted.body.imported === 1, accepted.body);

    const { data: rows1 } = await supabase.from('company_expenses').select('*').eq('company_id', companyId).eq('source', 'email');
    check('riga company_expenses creata con source=email e campi corretti', rows1?.length === 1 && rows1[0].supplier === 'Fornitore Webhook Test SRL' && rows1[0].amount === 200 && rows1[0].source_email === allowedSender, rows1);

    // ── Caso 6: stesso identico allegato reinviato → duplicate (idempotenza vera) ──
    const dupSend = await postWebhook({ recipient, sender: allowedSender, files: [{ field: 'attachment-1', filename: 'fattura.xml', buffer: xmlBuf }] });
    check('stesso allegato reinviato → duplicate, nessuna riga in più', dupSend.status === 200 && dupSend.body.outcome === 'duplicate', dupSend.body);

    const { data: rowsAfterDup } = await supabase.from('company_expenses').select('id').eq('company_id', companyId).eq('source', 'email');
    check('nessuna riga duplicata creata', rowsAfterDup?.length === 1, rowsAfterDup);

    // ── Caso 7: zip con p7m REALE dentro + fattura diversa → import via sbustamento ──
    if (!hasOpenssl()) {
      skip('p7m reale dentro zip', 'openssl non trovato in PATH');
    } else {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palladia-webhook-p7m-'));
      try {
        const p7mBuf = generateP7m(buildFatturaXml({ numero: '2026/WH-P7M' }), workDir);
        const zip = new AdmZip();
        zip.addFile('fattura.xml.p7m', p7mBuf);
        const zipResult = await postWebhook({ recipient, sender: allowedSender, files: [{ field: 'attachment-1', filename: 'fatture.zip', buffer: zip.toBuffer() }] });
        check('zip con p7m reale dentro → accepted', zipResult.status === 200 && zipResult.body.outcome === 'accepted' && zipResult.body.imported === 1, zipResult.body);

        const { data: rows2 } = await supabase.from('company_expenses').select('invoice_number').eq('company_id', companyId).eq('invoice_number', '2026/WH-P7M');
        check('fattura dentro il p7m sbustato dallo zip trovata in DB', rows2?.length === 1, rows2);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }

    // ── Caso 8: email di prova — nonce valido bypassa l'allowlist, uno finto no ──
    const { nonce } = await startTest(companyId);
    const testOk = await postWebhook({
      recipient, sender: 'chiunque-anche-non-autorizzato@estraneo.it', files: [],
      subject: `Verifica indirizzo Palladia — PALLADIA-TEST-${nonce}`,
    });
    check('nonce di prova valido → test_ok anche da mittente non autorizzato', testOk.status === 200 && testOk.body.outcome === 'test_ok', testOk.body);

    const { data: cfgAfterTest } = await supabase.from('email_ingest_configurations').select('last_test_verified_at, pending_test_nonce').eq('company_id', companyId).maybeSingle();
    check('last_test_verified_at valorizzato e nonce consumato', !!cfgAfterTest?.last_test_verified_at && !cfgAfterTest?.pending_test_nonce, cfgAfterTest);

    const testReplay = await postWebhook({
      recipient, sender: 'chiunque-anche-non-autorizzato@estraneo.it', files: [],
      subject: `Verifica indirizzo Palladia — PALLADIA-TEST-${nonce}`,
    });
    check('stesso nonce riusato → non più test_ok (mittente sconosciuto → quarantena)', testReplay.status === 200 && testReplay.body.outcome === 'quarantined_unknown_sender', testReplay.body);

    const testFake = await postWebhook({
      recipient, sender: 'chiunque-anche-non-autorizzato@estraneo.it', files: [],
      subject: 'Verifica indirizzo Palladia — PALLADIA-TEST-deadbeefdeadbeef',
    });
    check('nonce inventato → non bypassa nulla (mittente sconosciuto → quarantena)', testFake.status === 200 && testFake.body.outcome === 'quarantined_unknown_sender', testFake.body);

    // ── Caso 9: indirizzo rigenerato — il vecchio rifiuta con motivo esplicito,
    // non come un token mai esistito; il nuovo funziona normalmente ──────────
    const oldRecipient = recipient;
    const rotated = await rotateToken(companyId);
    const newToken = rotated.address.split('@')[0];
    check('nuovo indirizzo generato in formato leggibile (fatture-...)', newToken.startsWith('fatture-'), newToken);

    const onOldAddress = await postWebhook({ recipient: oldRecipient, sender: allowedSender, files: [] });
    check('email sul vecchio indirizzo → outcome token_retired, non unknown_token', onOldAddress.status === 200 && onOldAddress.body.outcome === 'token_retired', onOldAddress.body);

    const { data: retiredLogRow } = await supabase.from('email_ingest_log').select('company_id, reject_reason').eq('company_id', companyId).eq('outcome', 'token_retired').maybeSingle();
    check('la riga token_retired ha company_id valorizzato (non anonima) e un motivo esplicito', retiredLogRow?.company_id === companyId && /rigenerat/.test(retiredLogRow?.reject_reason || ''), retiredLogRow);

    const onNewAddress = await postWebhook({ recipient: `${newToken}@palladia.net`, sender: allowedSender, files: [{ field: 'attachment-1', filename: 'fattura.xml', buffer: Buffer.from(buildFatturaXml({ numero: '2026/WH-ROTATED' }), 'utf8') }] });
    check('il nuovo indirizzo funziona normalmente → accepted', onNewAddress.status === 200 && onNewAddress.body.outcome === 'accepted', onNewAddress.body);

    const { data: allowedSendersAfterRotate } = await supabase.from('email_ingest_allowed_senders').select('id').eq('company_id', companyId);
    check('la rigenerazione NON tocca la lista mittenti autorizzati (storico preservato)', (allowedSendersAfterRotate || []).length >= 1, allowedSendersAfterRotate);

    // ── Registro: ogni tentativo (anche i rifiutati) ha lasciato una riga ───
    const { data: logRows } = await supabase.from('email_ingest_log').select('outcome').eq('company_id', companyId);
    check('email_ingest_log ha almeno una riga per ciascun esito atteso', ['unknown_token', 'quarantined_unknown_sender', 'quarantined_failed_auth', 'accepted', 'duplicate'].every((o) => (logRows || []).some((r) => r.outcome === o) || o === 'unknown_token' /* company_id null, non in questa query */), logRows);
    check('email_ingest_log copre quarantined/accepted/duplicate per questa company', ['quarantined_unknown_sender', 'quarantined_failed_auth', 'accepted', 'duplicate'].every((o) => (logRows || []).some((r) => r.outcome === o)), logRows);
  } finally {
    await supabase.from('companies').delete().eq('id', companyId); // cascade su tutte le tabelle email_ingest_*
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message, err.stack);
  process.exitCode = 1;
});
