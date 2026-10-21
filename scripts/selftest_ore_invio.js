#!/usr/bin/env node
/**
 * scripts/selftest_ore_invio.js — F-393 (AUDIT.md del frontend).
 *
 * Il foglio del mese al commercialista con un tocco (decisione del titolare del
 * 21/10: «Un tocco tuo», PDF ed Excel). Contro il DB vero (azienda TEST-),
 * con l'email sostituita da una finta che registra cosa partirebbe:
 *  - senza commercialista non parte niente; email non valida rifiutata;
 *  - «Manda»: un'email al commercialista, risposta al titolare, PDF ed Excel
 *    del mese con gli stessi numeri del foglio; l'invio resta scritto;
 *  - Da fare: dal 1° al 20 del mese ricorda il mese scorso (urgente dal 4),
 *    solo a titolare e amministratori, solo se ci sono timbrature, e smette
 *    appena il foglio è partito;
 *  - un mese senza ore non si manda.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { statoInvio, salvaConsulente, mandaFoglio, vociFoglio } = require('../lib/oreInvio');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
async function rejects(name, p, code) {
  try { await p; check(name, false, 'nessun errore'); } catch (e) { check(name, e.code === code, e.code || e.message); }
}
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

const T = `TEST-F393-${Date.now()}`;
const MESE = '2026-09'; // un mese chiuso, giorni feriali fissi (niente ora legale né weekend a sorpresa)

async function main() {
  console.log('\n\x1b[1mF-393 — il foglio del mese al commercialista con un tocco\x1b[0m');
  const company = await ins('companies', { name: T });
  const cid = company.id;
  try {
    const site = await ins('sites', { company_id: cid, name: `${T} Cantiere`, address: 'Via Test 393, Genova', status: 'attivo' });
    const w = await ins('workers', { company_id: cid, full_name: `${T} Mario`, is_active: true, fiscal_code: `F393${Date.now()}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase() });
    // Tre giornate di settembre (lun 7, mar 8, mer 9): 7:55–17:05 ora di Roma
    for (const g of ['07', '08', '09']) {
      await ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: 'ENTRY', timestamp_server: `2026-09-${g}T05:55:00Z`, method: 'worker_self_punch' });
      await ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: 'EXIT', timestamp_server: `2026-09-${g}T15:05:00Z`, method: 'worker_self_punch' });
    }

    const s0 = await statoInvio(cid, MESE);
    check('senza commercialista: stato vuoto', s0.consulente === null && s0.invii.length === 0, s0);
    const inviate = [];
    const finta = async (msg) => { inviate.push(msg); return { data: { id: 'email-finta' } }; };
    await rejects('senza commercialista non parte niente', mandaFoglio({ companyId: cid, month: MESE, invia: finta }), 'NO_CONSULENTE');
    check('...e nessuna email', inviate.length === 0, inviate.length);

    await rejects('email non valida rifiutata', salvaConsulente(cid, { nome: 'Studio', email: 'non-una-email' }), 'INVALID_EMAIL');
    const c = await salvaConsulente(cid, { nome: 'Studio Rossi', email: ' Paghe@StudioRossi.IT ' });
    check('commercialista salvato (email in minuscolo, senza spazi)', c.email === 'paghe@studiorossi.it' && c.nome === 'Studio Rossi', c);

    // Da fare il 2 ottobre: ricorda settembre, non ancora urgente
    const v2 = await vociFoglio(cid, 'owner', '2026-10-02');
    check('Da fare il 2/10: «Manda il foglio di settembre al commercialista»', v2.length === 1 && v2[0].id === `foglio:${MESE}` && /settembre/.test(v2[0].title) && !v2[0].urgent && v2[0].link === `/persone?tab=ore&mese=${MESE}`, v2);
    check('...col nome del commercialista', /Studio Rossi/.test(v2[0]?.subtitle || ''), v2[0]?.subtitle);
    check('Da fare il 4/10: urgente', (await vociFoglio(cid, 'owner', '2026-10-04'))[0]?.urgent === true);
    check('Da fare il 21/10: non lo ricorda più', (await vociFoglio(cid, 'owner', '2026-10-21')).length === 0);
    check('Da fare per un tecnico: niente', (await vociFoglio(cid, 'tecnico', '2026-10-02')).length === 0);
    check('Da fare il 2/9 (agosto senza timbrature): niente', (await vociFoglio(cid, 'owner', '2026-09-02')).length === 0);

    const row = await mandaFoglio({ companyId: cid, userId: null, userEmail: 'titolare@test.it', month: MESE, invia: finta });
    const m = inviate[0];
    check('«Manda»: una email al commercialista', inviate.length === 1 && m.to === 'paghe@studiorossi.it', m && { to: m.to });
    check('...risposta diretta al titolare', m?.replyTo === 'titolare@test.it', m?.replyTo);
    check('...oggetto col mese e l\'azienda', /settembre 2026/i.test(m?.subject || '') && m.subject.includes(T), m?.subject);
    const [pdf, xlsx] = m?.attachments || [];
    check('...PDF allegato (vero PDF)', pdf?.filename === `presenze-${MESE}.pdf` && Buffer.isBuffer(pdf.content) && pdf.content.slice(0, 4).toString() === '%PDF', pdf && { f: pdf.filename, head: pdf.content.slice(0, 4).toString() });
    check('...Excel allegato (vero xlsx)', xlsx?.filename === `presenze-${MESE}.xlsx` && xlsx.content.slice(0, 2).toString() === 'PK', xlsx && xlsx.filename);
    check('...nel testo 1 lavoratore', /<strong>1<\/strong> lavoratori/.test(m?.bodyHtml || ''), (m?.bodyHtml || '').slice(0, 300));
    check('l\'invio resta scritto', row?.sent_to === 'paghe@studiorossi.it' && row.lavoratori === 1, row);
    const s1 = await statoInvio(cid, MESE);
    check('stato del mese: «mandato» con data e destinatario', s1.invii.length === 1 && !!s1.invii[0].sent_at, s1);
    check('Da fare il 2/10 dopo l\'invio: non lo ricorda più', (await vociFoglio(cid, 'owner', '2026-10-02')).length === 0);

    await rejects('un mese senza ore non si manda', mandaFoglio({ companyId: cid, month: '2026-07', invia: finta }), 'MESE_VUOTO');
    await rejects('mese scritto male rifiutato', mandaFoglio({ companyId: cid, month: '2026-13', invia: finta }), 'INVALID_MONTH');
  } finally {
    await supabase.from('ore_invii').delete().eq('company_id', cid);
    await supabase.from('admin_audit_log').delete().eq('company_id', cid);
    // presence_logs è append-only (registro presenze): le righe di prova restano legate all'azienda TEST-
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
