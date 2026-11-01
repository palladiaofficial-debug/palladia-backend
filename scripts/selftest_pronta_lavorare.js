#!/usr/bin/env node
/**
 * scripts/selftest_pronta_lavorare.js — F-419 (AUDIT.md del frontend).
 *
 * «Pronta a lavorare», fase 1, su un'azienda di prova vera (DB):
 *  - un'impresa con DURC, visura, DVR e dichiarazione ma senza patente a crediti → NON può entrare;
 *  - con la patente → può entrare «fino al» primo requisito che scade;
 *  - con una SOA di classe III valida al posto della patente → esente, può entrare;
 *  - un lavoratore autonomo: niente DVR né dichiarazione, sì attrezzature e DPI;
 *  - un operaio senza visita ferma lui, non l'impresa; il POS che manca per UN cantiere
 *    ferma quel cantiere, non l'impresa;
 *  - un caricamento in lettura → «li sto controllando»;
 *  - patente con meno di 15 crediti → non va; classi SOA lette bene;
 *  - la frase della pagina Imprese e il messaggio «Chiedi» con anche gli operai.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const I = require('../lib/imprese');
const { giudica, pulisci } = require('../lib/impreseControllo');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const tra = (g) => { const x = new Date(); x.setDate(x.getDate() + g); return x.toISOString().slice(0, 10); };

function puri() {
  console.log('\n\x1b[1mF-419 — lettura e giudizio\x1b[0m');
  const p = pulisci({ tipo: 'patente', crediti: '12' });
  check('patente con 12 crediti → non va, «ne servono almeno 15»', giudica('patente', p).esito === 'non_va' && giudica('patente', p).motivo.codice === 'crediti_insufficienti', giudica('patente', p));
  check('patente con 30 crediti → va bene', giudica('patente', pulisci({ tipo: 'patente', crediti: 30 })).esito === 'va_bene');
  check('classi SOA lette: «iii bis» → III-BIS, «4» → IV, «XX» → nessuna', pulisci({ tipo: 'soa', classifica: 'iii bis' }).classifica === 'III-BIS' && pulisci({ tipo: 'soa', classifica: '4' }).classifica === 'IV' && pulisci({ tipo: 'soa', classifica: 'XX' }).classifica === null);
}

async function db() {
  console.log('\n\x1b[1mF-419 — il verdetto (DB)\x1b[0m');
  const T = `TEST-F419-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  try {
    await ins('company_feature_flags', { company_id: co.id, feature: 'subappaltatori', enabled: true });
    const doc = (subId, category, extra = {}) => ins('subcontractor_documents', { company_id: co.id, subcontractor_id: subId, name: category, category, file_path: `x/${subId}/${category}`, esito: 'va_bene', ai_validity_ok: true, ...extra });
    const base = async (sub, { patente = true } = {}) => {
      if (patente) await doc(sub.id, 'patente_crediti');
      await doc(sub.id, 'durc', { valid_until: tra(90) });
      await doc(sub.id, 'visura', {});
      await doc(sub.id, 'dvr'); await doc(sub.id, 'dichiarazione_art14');
    };
    const site1 = await ins('sites', { company_id: co.id, name: `${T} Via Balbi`, address: 'Via Balbi 31', status: 'attivo' });
    const site2 = await ins('sites', { company_id: co.id, name: `${T} Corso Sardegna`, address: 'Corso Sardegna 1', status: 'attivo' });

    // A: tutto tranne la patente
    const A = await ins('subcontractors', { company_id: co.id, company_name: 'Senza Patente Srl', is_active: true, durc_expiry: tra(90), visura_date: tra(-20) });
    await base(A, { patente: false });
    // B: tutto, due cantieri (POS solo per uno), due operai (uno senza visita)
    const B = await ins('subcontractors', { company_id: co.id, company_name: 'Edil Bianchi Srl', is_active: true, durc_expiry: tra(90), visura_date: tra(-20) });
    await base(B);
    for (const s of [site1, site2]) await ins('site_subcontractors', { company_id: co.id, site_id: s.id, subcontractor_id: B.id });
    await doc(B.id, 'pos', { site_id: site1.id });
    const op1 = await ins('sub_workers', { company_id: co.id, subcontractor_id: B.id, full_name: 'Mario Rossi', added_via: 'ufficio' });
    const op2 = await ins('sub_workers', { company_id: co.id, subcontractor_id: B.id, full_name: 'Paolo Neri', added_via: 'ufficio' });
    for (const t of ['idoneita', 'formazione']) await ins('sub_worker_documenti', { company_id: co.id, sub_worker_id: op1.id, tipo: t, scadenza: tra(300), file_path: `x/${op1.id}/${t}`, esito: 'va_bene' });
    await ins('sub_worker_documenti', { company_id: co.id, sub_worker_id: op2.id, tipo: 'formazione', scadenza: tra(300), file_path: `x/${op2.id}/f`, esito: 'va_bene' });
    // C: SOA classe III valida, niente patente
    const C = await ins('subcontractors', { company_id: co.id, company_name: 'Grandi Opere Spa', is_active: true, durc_expiry: tra(60), visura_date: tra(-20), soa_classifica: 'III', soa_expiry: tra(400) });
    await base(C, { patente: false });
    // D: autonomo con patente, DURC, visura, attrezzature, DPI (niente DVR né dichiarazione)
    const D = await ins('subcontractors', { company_id: co.id, company_name: 'Marco Neri', is_active: true, autonomo: true, durc_expiry: tra(20), visura_date: tra(-20) });
    await doc(D.id, 'patente_crediti'); await doc(D.id, 'durc', { valid_until: tra(20) }); await doc(D.id, 'visura'); await doc(D.id, 'attrezzature'); await doc(D.id, 'dpi');
    // E: come B senza operai e cantieri, con un caricamento in lettura
    const E = await ins('subcontractors', { company_id: co.id, company_name: 'Termoidraulica Rossi', is_active: true, durc_expiry: tra(90), visura_date: tra(-20) });
    await base(E);
    const car = await ins('imprese_caricamenti', { company_id: co.id, subcontractor_id: E.id });
    await ins('imprese_caricamento_doc', { company_id: co.id, caricamento_id: car.id, livello: 'documento', stato: 'in_lettura', ordine: 1, nome_file: 'x.pdf', file_path: `x/${car.id}/x.pdf`, mime_type: 'application/pdf' });

    const sA = await I.scheda(co.id, A.id), sB = await I.scheda(co.id, B.id), sC = await I.scheda(co.id, C.id), sD = await I.scheda(co.id, D.id), sE = await I.scheda(co.id, E.id);
    check('A senza patente → non può entrare, manca «Patente a crediti»', sA.verdetto.stato === 'no' && sA.verdetto.cose.some(c => c.dove === 'impresa' && c.label === 'Patente a crediti'), sA.verdetto);
    check('B con la patente → può entrare, fino al DURC', sB.verdetto.stato === 'si' && sB.verdetto.finoAl === tra(90), sB.verdetto);
    check('B: Paolo Neri senza visita ferma lui solo (1 su 2), l\'impresa resta dentro', sB.verdetto.operai.possono === 1 && sB.verdetto.operai.totale === 2 && sB.verdetto.cose.some(c => c.dove === 'operaio' && c.label === 'Paolo Neri' && c.cosa.join() === 'visita medica'), sB.verdetto);
    check('B: manca il POS solo per Corso Sardegna, Via Balbi a posto', sB.verdetto.cantieri.find(c => c.siteId === site1.id)?.ok === true && sB.verdetto.cantieri.find(c => c.siteId === site2.id)?.ok === false && sB.puoLavorare === true, sB.verdetto.cantieri);
    const pat = sC.requisiti.find(r => r.key === 'patente');
    check('C: SOA classe III valida → patente «esente (SOA classe III)», può entrare', sC.verdetto.stato === 'si' && pat?.stato === 'ok' && /esente \(SOA classe III\)/.test(pat.label), { verdetto: sC.verdetto, pat });
    check('D autonomo: non gli si chiedono DVR né dichiarazione; sì attrezzature e DPI', sD.autonomo && !sD.requisiti.some(r => ['dvr', 'dichiarazione'].includes(r.key)) && ['attrezzature', 'dpi'].every(k => sD.requisiti.some(r => r.key === k)), sD.requisiti.map(r => r.key));
    check('D autonomo con tutto: può entrare; il DURC scade tra 20 giorni → «presto»', sD.verdetto.stato === 'si' && sD.verdetto.presto?.key === 'durc', sD.verdetto);
    check('E con un caricamento in lettura → «li sto controllando»', sE.verdetto.stato === 'controllo', sE.verdetto);

    const pan = await I.panoramica(co.id);
    const f = (n) => pan.imprese.find(x => x.nome === n)?.frase;
    check('Imprese: «Non può entrare: manca una cosa» per A', f('Senza Patente Srl')?.testo === 'Non può entrare: manca una cosa' && f('Senza Patente Srl')?.tono === 'rosso', f('Senza Patente Srl'));
    check('Imprese: «Può entrare · il DURC scade tra 20 giorni» per l\'autonomo', /^Può entrare · DURC scade tra 2[01] giorni$/.test(f('Marco Neri')?.testo || ''), f('Marco Neri'));
    check('Imprese: «Può entrare · 1 operaio no» per B', f('Edil Bianchi Srl')?.testo === 'Può entrare · 1 operaio no', f('Edil Bianchi Srl'));
    check('Imprese: «Documenti arrivati: li sto controllando» per E', f('Termoidraulica Rossi')?.tono === 'blu' && /li sto controllando/.test(f('Termoidraulica Rossi').testo), f('Termoidraulica Rossi'));
    check('Imprese: «Può entrare fino al …» in verde per C', /^Può entrare fino al /.test(f('Grandi Opere Spa')?.testo || '') && f('Grandi Opere Spa').tono === 'verde', f('Grandi Opere Spa'));
    check('Imprese: conta 3 possono, 1 no, 1 in controllo', pan.conta.possono === 3 && pan.conta.no === 1 && pan.conta.controllo === 1, pan.conta);
    check('Imprese: prima quella che non può entrare', pan.imprese[0].nome === 'Senza Patente Srl', pan.imprese.map(x => x.nome));

    process.env.PIN_SIGNING_SECRET ||= 'test';
    const msg = await I.chiedi(co.id, null, B.id);
    check('Chiedi a B: il messaggio nomina la visita medica di Paolo Neri', /visita medica di Paolo Neri/.test(msg.testo), msg.testo);
    await I.autonomo(co.id, A.id, true);
    const sA2 = await I.scheda(co.id, A.id);
    check('A diventa autonomo: ora gli mancano patente, attrezzature e DPI, non più DVR', sA2.autonomo && ['Patente a crediti', 'Attrezzature a norma', 'Elenco dei DPI'].every(l => sA2.verdetto.cose.some(c => c.label === l)) && !sA2.verdetto.cose.some(c => /DVR/.test(c.label)), sA2.verdetto.cose);
  } finally {
    for (const t of ['imprese_caricamento_doc', 'imprese_caricamenti', 'sub_worker_documenti', 'sub_workers', 'subcontractor_documents', 'site_subcontractors', 'sub_link', 'company_feature_flags']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('subcontractors').delete().eq('company_id', co.id);
    await supabase.from('sites').delete().eq('company_id', co.id);
    const { error } = await supabase.from('companies').delete().eq('id', co.id);
    if (error) console.error('pulizia azienda di prova:', error.message);
  }
}

(async () => {
  puri();
  await db();
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
