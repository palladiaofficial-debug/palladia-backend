#!/usr/bin/env node
/**
 * scripts/selftest_da_pagare_email.js — F-339 + F-338 (AUDIT.md del frontend).
 *
 * Fatture via email: il titolare (o un tecnico) inoltra a mano una fattura
 * all'indirizzo dedicato. Prima di F-339 l'inoltro finiva sempre in quarantena
 * perché chi inoltra è il mittente e nessuno era nell'elenco autorizzati.
 *  - titolare e tecnico: accettati senza elenco da compilare;
 *  - estraneo e capocantiere: in quarantena come prima;
 *  - con il modulo Da pagare acceso la spesa entra nella lista (da_pagare) con
 *    la scadenza dell'XML, e Palladia risponde a chi ha inoltrato;
 *  - un inoltro senza fattura riceve la risposta "non ho trovato una fattura".
 * Contro il DB vero, servizio email finto (nessuna email spedita).
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');

// Email finta: registra le risposte invece di spedirle
const inviate = [];
const emailPath = path.join(__dirname, '../services/email.js');
const vera = require(emailPath);
require.cache[emailPath].exports = { ...vera, sendDaPagareReply: async (opts) => { inviate.push(opts); return { id: 'finta' }; } };

const supabase = require('../lib/supabase');
const { handleInboundWebhook } = require('../services/emailIngestWebhook');

let passed = 0, failed = 0, skipped = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F339-${Date.now()}`;
const stamp = String(Date.now()).slice(-7);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

function fatturaXml({ numero, importo, scadenza }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">
  <FatturaElettronicaHeader>
    <CedentePrestatore><DatiAnagrafici>
      <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>0${stamp}0001</IdCodice></IdFiscaleIVA>
      <Anagrafica><Denominazione>Edilmateriali Rossi ${T} Srl</Denominazione></Anagrafica>
    </DatiAnagrafici></CedentePrestatore>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali><DatiGeneraliDocumento>
      <TipoDocumento>TD01</TipoDocumento><Numero>${numero}</Numero><Data>2026-09-30</Data>
      <ImportoTotaleDocumento>${importo}</ImportoTotaleDocumento>
    </DatiGeneraliDocumento></DatiGenerali>
    <DatiBeniServizi><DettaglioLinee><Descrizione>Cemento e ferro</Descrizione></DettaglioLinee></DatiBeniServizi>
    <DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento>
      <ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>${scadenza}</DataScadenzaPagamento><ImportoPagamento>${importo}</ImportoPagamento>
    </DettaglioPagamento></DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

async function main() {
  console.log('\n\x1b[1mF-339 / F-338 — fatture inoltrate per email\x1b[0m');
  if (!process.env.CLOUDFLARE_EMAIL_INGEST_SECRET) { console.log('  – CLOUDFLARE_EMAIL_INGEST_SECRET mancante: salto'); process.exit(0); }
  const headers = { 'x-ingest-secret': process.env.CLOUDFLARE_EMAIL_INGEST_SECRET };
  const company = await ins('companies', { name: T });
  const utenti = [];
  try {
    const mk = async (ruolo) => {
      const email = `f339-${ruolo}-${stamp}@example.com`;
      const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomBytes(12).toString('hex') });
      if (error) throw new Error(`createUser ${ruolo}: ${error.message}`);
      utenti.push(data.user.id);
      await ins('company_users', { company_id: company.id, user_id: data.user.id, role: ruolo });
      return email;
    };
    const owner = await mk('owner'), tech = await mk('tech'), capo = await mk('viewer');
    const token = `fatture-f339-${crypto.randomBytes(5).toString('hex')}`;
    await ins('email_ingest_configurations', { company_id: company.id, inbound_token: token, status: 'active' });
    const manda = (sender, files, subject = 'I: Fattura') => handleInboundWebhook(
      { recipient: `${token}@palladia.net`, sender, subject, 'message-headers': JSON.stringify([['Message-Id', `<${crypto.randomUUID()}@test>`]]) },
      files, headers);
    const xml = (numero, importo, scadenza) => [{ originalname: `IT0${stamp}_${numero}.xml`, buffer: Buffer.from(fatturaXml({ numero, importo, scadenza })) }];
    const spese = async () => (await supabase.from('company_expenses').select('*').eq('company_id', company.id).order('created_at')).data || [];

    // ── Modulo Da pagare spento: F-339 vale lo stesso ──
    const r1 = await manda(`Mario Titolare <${owner}>`, xml('412', '1840.00', '2026-10-20'));
    check('F-339: il titolare che inoltra una fattura NON finisce in quarantena', r1.body?.outcome === 'accepted', r1.body);
    let s = await spese();
    check('…la fattura è importata con la scadenza dell\'XML', s.length === 1 && s[0].data_scadenza === '2026-10-20' && Number(s[0].amount) === 1840, s.map(x => ({ a: x.amount, d: x.data_scadenza })));
    check('…modulo spento: la spesa non entra in Da pagare e nessuna risposta', s[0]?.da_pagare === false && inviate.length === 0, { da_pagare: s[0]?.da_pagare, inviate: inviate.length });

    const r2 = await manda(`estraneo-${stamp}@example.com`, xml('500', '99.00', '2026-10-25'));
    check('un estraneo resta in quarantena', r2.body?.outcome === 'quarantined_unknown_sender', r2.body);
    const r3 = await manda(capo, xml('501', '50.00', '2026-10-25'));
    check('un utente in sola lettura resta in quarantena (Da pagare è per titolare e tecnici)', r3.body?.outcome === 'quarantined_unknown_sender', r3.body);

    // ── Modulo acceso ──
    await ins('company_feature_flags', { company_id: company.id, feature: 'da_pagare', enabled: true });
    const r4 = await manda(tech, xml('88', '980.00', '2026-10-24'));
    check('il tecnico che inoltra: accettata', r4.body?.outcome === 'accepted', r4.body);
    s = await spese();
    const nuova = s.find(x => x.invoice_number === '88');
    check('…modulo acceso: la spesa entra in Da pagare con la scadenza dell\'XML', nuova?.da_pagare === true && nuova?.data_scadenza === '2026-10-24' && !nuova?.pagato_il, nuova);
    const risp = inviate.find(x => x.to === tech);
    check('…Palladia risponde a chi ha inoltrato, con fornitore, importo e scadenza', !!risp && risp.righe?.length === 1 && risp.righe[0].importo === 980 && risp.righe[0].scadenza === '2026-10-24' && /Edilmateriali Rossi/.test(risp.righe[0].fornitore) && risp.righe[0].certa === true, risp);

    const r5 = await manda(owner, [], 'I: ci vediamo domani');
    const vuota = inviate.find(x => x.to === owner && x.nessuna);
    check('inoltro senza fattura: risposta "non ho trovato una fattura"', !!vuota, { r5: r5.body, inviate });
    check('nessuna risposta all\'estraneo né al capocantiere', !inviate.some(x => x.to.startsWith('estraneo') || x.to === capo), inviate.map(x => x.to));
  } finally {
    await supabase.from('company_expenses').delete().eq('company_id', company.id);
    await supabase.from('email_ingest_log').delete().eq('company_id', company.id);
    await supabase.from('email_ingest_configurations').delete().eq('company_id', company.id);
    await supabase.from('company_feature_flags').delete().eq('company_id', company.id);
    await supabase.from('company_users').delete().eq('company_id', company.id);
    for (const id of utenti) await supabase.auth.admin.deleteUser(id).catch(() => {});
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
