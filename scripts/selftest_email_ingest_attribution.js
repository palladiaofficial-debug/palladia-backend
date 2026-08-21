#!/usr/bin/env node
/**
 * scripts/selftest_email_ingest_attribution.js
 *
 * Regressione per l'assegnazione automatica al cantiere (resolveSiteAssignment /
 * resolveSiteFromSupplierHistory in services/sdiInvoices.js) attraverso il canale
 * email — stesso meccanismo verificato dal vivo con email reali il 2026-08-21
 * (vedi AUDIT.md), qui reso deterministico e ripetibile via chiamata diretta al
 * webhook locale, senza dipendere da Cloudflare/Gmail.
 *
 * Copre i 4 casi richiesti: un solo cantiere attivo, più cantieri con fornitore
 * già visto (storico concorde → assegnazione automatica), più cantieri con
 * fornitore nuovo (ambiguo, mai indovinato), nessun cantiere attivo (site_id
 * resta null senza errori).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const INGEST_SECRET = process.env.CLOUDFLARE_EMAIL_INGEST_SECRET;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function buildFatturaXml({ numero, partitaIva, supplier = 'Fornitore Attribuzione Test SRL' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">
  <FatturaElettronicaHeader>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${partitaIva}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>${supplier}</Denominazione></Anagrafica>
      </DatiAnagrafici>
    </CedentePrestatore>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Numero>${numero}</Numero>
        <Data>2026-08-20</Data>
        <ImportoTotaleDocumento>150.00</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi><DettaglioLinee><Descrizione>Materiali edili</Descrizione></DettaglioLinee></DatiBeniServizi>
    <DatiPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento></DettaglioPagamento></DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

async function postWebhook({ recipient, sender, files, subject = 'Fattura di test — attribuzione' }) {
  const messageHeaders = JSON.stringify([
    ['Message-Id', `<test-${crypto.randomBytes(8).toString('hex')}@example.com>`],
    ['Authentication-Results', 'mx.cloudflare.net; spf=pass smtp.mailfrom=test; dkim=pass header.d=test'],
  ]);
  const form = new FormData();
  form.append('recipient', recipient);
  form.append('sender', sender);
  form.append('from', sender);
  form.append('subject', subject);
  form.append('message-headers', messageHeaders);
  for (const f of files) form.append(f.field, new Blob([f.buffer]), f.filename);
  const res = await fetch(`${BASE}/api/v1/expenses/email-ingest/webhook`, { method: 'POST', body: form, headers: { 'X-Ingest-Secret': INGEST_SECRET } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function setupCompany(name, { sites, allowedSender }) {
  const { data: company, error } = await supabase.from('companies').insert({ name }).select().single();
  if (error) throw error;
  const companyId = company.id;
  const inboundToken = crypto.randomBytes(12).toString('hex');
  await supabase.from('email_ingest_configurations').insert({ company_id: companyId, inbound_token: inboundToken, status: 'active' });
  await supabase.from('email_ingest_allowed_senders').insert({ company_id: companyId, email_address: allowedSender, action: 'allow' });
  if (sites?.length) {
    const { error: sitesErr } = await supabase.from('sites').insert(sites.map((s) => ({ company_id: companyId, name: s.name, status: s.status, address: 'Via di prova 1' })));
    if (sitesErr) throw sitesErr;
  }
  return { companyId, recipient: `${inboundToken}@palladia.net` };
}

async function main() {
  console.log('\n=== selftest_email_ingest_attribution ===\n');

  if (!INGEST_SECRET) {
    skip('attribuzione cantiere via email', 'CLOUDFLARE_EMAIL_INGEST_SECRET non impostata in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }
  let healthy = false;
  try { healthy = (await fetch(`${BASE}/`)).ok || true; } catch { healthy = false; }
  if (!healthy) {
    skip('attribuzione cantiere via email', `server non raggiungibile su ${BASE}`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }

  const SENDER = 'fornitore@attribuzione-test.it';
  const companyIds = [];

  try {
    // ── Caso 1: un solo cantiere attivo → auto-assegnazione ────────────────
    const single = await setupCompany('TEST-Attrib-SingleSite', {
      sender: SENDER, allowedSender: SENDER,
      sites: [{ name: 'Cantiere Unico', status: 'attivo' }],
    });
    companyIds.push(single.companyId);
    const singleRes = await postWebhook({ recipient: single.recipient, sender: SENDER, files: [{ field: 'attachment-1', filename: 'fattura.xml', buffer: Buffer.from(buildFatturaXml({ numero: 'ATTRIB-1', partitaIva: '31031031031' }), 'utf8') }] });
    check('un solo cantiere attivo → accepted', singleRes.status === 200 && singleRes.body.outcome === 'accepted', singleRes.body);
    const { data: singleRow } = await supabase.from('company_expenses').select('site_id').eq('company_id', single.companyId).eq('invoice_number', 'ATTRIB-1').maybeSingle();
    const { data: singleSite } = await supabase.from('sites').select('id').eq('company_id', single.companyId).single();
    check('site_id assegnato automaticamente all\'unico cantiere attivo', singleRow?.site_id === singleSite?.id, { singleRow, singleSite });

    // ── Caso 2: più cantieri, fornitore già visto (storico concorde) → auto-assegnazione ──
    const history = await setupCompany('TEST-Attrib-History', {
      sender: SENDER, allowedSender: SENDER,
      sites: [{ name: 'Cantiere A', status: 'attivo' }, { name: 'Cantiere B', status: 'attivo' }],
    });
    companyIds.push(history.companyId);
    const { data: historySites } = await supabase.from('sites').select('id, name').eq('company_id', history.companyId);
    const cantiereA = historySites.find((s) => s.name === 'Cantiere A');
    const HISTORY_VAT = '32032032032';
    await supabase.from('company_expenses').insert([
      { company_id: history.companyId, amount: 100, description: 'Seed 1', category: 'altro', payment_method: 'bonifico', supplier: 'Fornitore Storico SRL', supplier_vat: HISTORY_VAT, expense_date: '2026-07-01', is_deductible: true, source: 'manual', site_id: cantiereA.id },
      { company_id: history.companyId, amount: 120, description: 'Seed 2', category: 'altro', payment_method: 'bonifico', supplier: 'Fornitore Storico SRL', supplier_vat: HISTORY_VAT, expense_date: '2026-07-15', is_deductible: true, source: 'manual', site_id: cantiereA.id },
    ]);
    const historyRes = await postWebhook({ recipient: history.recipient, sender: SENDER, files: [{ field: 'attachment-1', filename: 'fattura.xml', buffer: Buffer.from(buildFatturaXml({ numero: 'ATTRIB-2', partitaIva: HISTORY_VAT, supplier: 'Fornitore Storico SRL' }), 'utf8') }] });
    check('più cantieri, fornitore con storico concorde → accepted', historyRes.status === 200 && historyRes.body.outcome === 'accepted', historyRes.body);
    const { data: historyRow } = await supabase.from('company_expenses').select('site_id, notes').eq('company_id', history.companyId).eq('invoice_number', 'ATTRIB-2').maybeSingle();
    check('assegnata automaticamente allo stesso cantiere dello storico (non chiesto conferma)', historyRow?.site_id === cantiereA.id, historyRow);
    check('nota esplicita che spiega l\'assegnazione via storico', /storico|sempre/.test(historyRow?.notes || ''), historyRow);

    // ── Caso 3: più cantieri, fornitore MAI VISTO → resta ambiguo, mai indovinato ──
    const ambiguous = await setupCompany('TEST-Attrib-Ambiguous', {
      sender: SENDER, allowedSender: SENDER,
      sites: [{ name: 'Cantiere C', status: 'attivo' }, { name: 'Cantiere D', status: 'attivo' }],
    });
    companyIds.push(ambiguous.companyId);
    const ambiguousRes = await postWebhook({ recipient: ambiguous.recipient, sender: SENDER, files: [{ field: 'attachment-1', filename: 'fattura.xml', buffer: Buffer.from(buildFatturaXml({ numero: 'ATTRIB-3', partitaIva: '33033033033', supplier: 'Fornitore Mai Visto SRL' }), 'utf8') }] });
    check('più cantieri, fornitore nuovo → comunque accepted (spesa creata, solo senza cantiere certo)', ambiguousRes.status === 200 && ambiguousRes.body.outcome === 'accepted', ambiguousRes.body);
    const { data: ambiguousRow } = await supabase.from('company_expenses').select('site_id').eq('company_id', ambiguous.companyId).eq('invoice_number', 'ATTRIB-3').maybeSingle();
    check('site_id resta null — MAI indovinato tra 2+ cantieri senza storico', ambiguousRow?.site_id === null, ambiguousRow);

    // ── Caso 4: nessun cantiere attivo → site_id null, nessun errore ────────
    const noSite = await setupCompany('TEST-Attrib-NoSite', { sender: SENDER, allowedSender: SENDER, sites: [] });
    companyIds.push(noSite.companyId);
    const noSiteRes = await postWebhook({ recipient: noSite.recipient, sender: SENDER, files: [{ field: 'attachment-1', filename: 'fattura.xml', buffer: Buffer.from(buildFatturaXml({ numero: 'ATTRIB-4', partitaIva: '34034034034', supplier: 'Fornitore Nessun Cantiere SRL' }), 'utf8') }] });
    check('nessun cantiere attivo → comunque accepted, nessun crash', noSiteRes.status === 200 && noSiteRes.body.outcome === 'accepted', noSiteRes.body);
    const { data: noSiteRow } = await supabase.from('company_expenses').select('site_id').eq('company_id', noSite.companyId).eq('invoice_number', 'ATTRIB-4').maybeSingle();
    check('site_id null quando l\'azienda non ha nessun cantiere attivo', noSiteRow?.site_id === null, noSiteRow);
  } finally {
    for (const id of companyIds) await supabase.from('companies').delete().eq('id', id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message, err.stack);
  process.exitCode = 1;
});
