#!/usr/bin/env node
/**
 * scripts/selftest_email_envelope_parser.js
 *
 * Test di regressione per lib/fatturaPaEnvelopeParser.js — canale fatture via email.
 * Genera fixture REALI (non finte): un .p7m ottenuto firmando un XML FatturaPA con
 * un certificato self-signed via openssl (stessa busta crittografica CAdES-BES
 * enveloping usata dal Sistema di Interscambio), e uno .zip con dentro una seconda
 * fattura (nota di credito TD04), un PDF di cortesia e una notifica di scarto SdI —
 * per verificare che il parser distingua correttamente i 4 casi mescolati nello
 * stesso archivio, come capiterebbe con un inoltro email reale.
 *
 * Nessun server/DB richiesto: extractInvoiceCandidates è una funzione pura.
 * Richiede `openssl` in PATH per generare il .p7m — se assente, quella parte del
 * test si salta esplicitamente (non si finge un p7m con un formato diverso, che
 * nasconderebbe regressioni vere sullo sbustamento CAdES).
 */
'use strict';
const { execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { extractInvoiceCandidates } = require('../lib/fatturaPaEnvelopeParser');

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function buildFatturaXml({ numero = '1', tipoDocumento = 'TD01', partitaIva = '01234567890', importo = '300.00' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">
  <FatturaElettronicaHeader>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${partitaIva}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Fornitore Test SRL</Denominazione></Anagrafica>
      </DatiAnagrafici>
    </CedentePrestatore>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${tipoDocumento}</TipoDocumento>
        <Numero>${numero}</Numero>
        <Data>2026-08-01</Data>
        <ImportoTotaleDocumento>${importo}</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee><Descrizione>Materiali edili vari</Descrizione></DettaglioLinee>
    </DatiBeniServizi>
    <DatiPagamento>
      <DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento></DettaglioPagamento>
    </DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

function buildScartoXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<NotificaScarto xmlns="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/messaggi/v1.0">
  <IdentificativoSdI>12345</IdentificativoSdI>
  <Descrizione>Fattura scartata per errore formale</Descrizione>
</NotificaScarto>`;
}

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function generateP7m(xmlString, workDir) {
  const xmlPath  = path.join(workDir, 'invoice.xml');
  const keyPath  = path.join(workDir, 'key.pem');
  const certPath = path.join(workDir, 'cert.pem');
  const p7mPath  = path.join(workDir, 'invoice.xml.p7m');

  fs.writeFileSync(xmlPath, xmlString, 'utf8');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=Test Fornitore/O=Palladia Test',
  ], { stdio: 'pipe' });
  // -nodetach: firma "enveloping" (il contenuto originale è dentro la busta) — è
  // esattamente il formato dei .p7m emessi dal Sistema di Interscambio.
  execFileSync('openssl', [
    'smime', '-sign', '-in', xmlPath, '-signer', certPath, '-inkey', keyPath,
    '-outform', 'DER', '-out', p7mPath, '-nodetach',
  ], { stdio: 'pipe' });

  return fs.readFileSync(p7mPath);
}

async function main() {
  console.log('\n=== selftest_email_envelope_parser ===\n');

  // ── Caso 1: XML puro valido ────────────────────────────────────────────────
  const plainXml = buildFatturaXml({ numero: '2026/1' });
  const plainResult = extractInvoiceCandidates('fattura.xml', Buffer.from(plainXml, 'utf8'));
  check('XML puro: un solo candidato', plainResult.length === 1, plainResult);
  check('XML puro: nessuno skip', !plainResult[0]?.skip, plainResult[0]);
  check('XML puro: numero documento corretto', plainResult[0]?.parsed?.docNumber === '2026/1', plainResult[0]?.parsed);
  check('XML puro: non è nota di credito', plainResult[0]?.parsed?.isCreditNote === false, plainResult[0]?.parsed);
  check('XML puro: content_hash presente', typeof plainResult[0]?.contentHash === 'string' && plainResult[0].contentHash.length === 64, plainResult[0]);

  // ── Caso 2: notifica di scarto SdI, mai una fattura ────────────────────────
  const scartoResult = extractInvoiceCandidates('IT01234567890_scarto.xml', Buffer.from(buildScartoXml(), 'utf8'));
  check('Notifica di scarto: riconosciuta come sdi_metadata, non importata', scartoResult[0]?.skip === true && scartoResult[0]?.reason === 'sdi_metadata', scartoResult);

  // ── Caso 3: file non riconosciuto ──────────────────────────────────────────
  const garbageResult = extractInvoiceCandidates('mistero.dat', Buffer.from([0x01, 0x02, 0x03, 0x04]));
  check('File non riconosciuto: skip con reason unrecognized', garbageResult[0]?.skip === true && garbageResult[0]?.reason === 'unrecognized', garbageResult);

  // ── Caso 4: .p7m reale (CAdES enveloping via openssl) ──────────────────────
  if (!hasOpenssl()) {
    skip('p7m reale', 'openssl non trovato in PATH — sbustamento CAdES non verificato in questo ambiente');
  } else {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palladia-p7m-'));
    try {
      const p7mBuffer = generateP7m(buildFatturaXml({ numero: '2026/P7M-1' }), workDir);
      const p7mResult = extractInvoiceCandidates('fattura.xml.p7m', p7mBuffer);
      check('p7m: un solo candidato', p7mResult.length === 1, p7mResult);
      check('p7m: nessuno skip', !p7mResult[0]?.skip, p7mResult[0]);
      check('p7m: numero documento estratto correttamente dopo sbustamento', p7mResult[0]?.parsed?.docNumber === '2026/P7M-1', p7mResult[0]?.parsed);
      check('p7m: partita IVA fornitore estratta correttamente', p7mResult[0]?.parsed?.supplierVat === '01234567890', p7mResult[0]?.parsed);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  // ── Caso 5: .zip con 4 elementi mescolati (fattura TD04, PDF cortesia, scarto, cartella) ──
  const zip = new AdmZip();
  zip.addFile('nota_credito.xml', Buffer.from(buildFatturaXml({ numero: '2026/NC-1', tipoDocumento: 'TD04' }), 'utf8'));
  zip.addFile('cortesia.pdf', Buffer.from('%PDF-1.4\n%test\n1 0 obj<<>>endobj\n%%EOF', 'utf8'));
  zip.addFile('IT01234567890_scarto2.xml', Buffer.from(buildScartoXml(), 'utf8'));
  const zipResult = extractInvoiceCandidates('fatture.zip', zip.toBuffer());

  check('zip: 3 elementi estratti (fattura + pdf + scarto)', zipResult.length === 3, zipResult.map((r) => r.sourceFilename || r.filename));
  const zipInvoice = zipResult.find((r) => r.xml);
  const zipPdf     = zipResult.find((r) => r.courtesyPdf);
  const zipSkipped = zipResult.find((r) => r.skip);
  check('zip: la fattura dentro lo zip è una nota di credito riconosciuta', zipInvoice?.parsed?.isCreditNote === true, zipInvoice?.parsed);
  check('zip: il PDF è marcato come copia di cortesia, non importato come XML', zipPdf?.courtesyPdf === true, zipPdf);
  check('zip: la notifica di scarto dentro lo zip resta esclusa', zipSkipped?.reason === 'sdi_metadata', zipSkipped);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exitCode = 1;
});
