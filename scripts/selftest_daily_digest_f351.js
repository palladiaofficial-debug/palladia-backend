#!/usr/bin/env node
/**
 * scripts/selftest_daily_digest_f351.js — F-351 (AUDIT.md del frontend).
 *
 * L'email «Riepilogo conformità» delle 07:30 diceva al titolare che quasi
 * tutti gli operai erano senza visita medica e senza corso sicurezza: la query
 * sui documenti passava gli id di TUTTI i lavoratori attivi di tutte le
 * aziende in un .in() (Bad Request oltre ~1000 id), l'errore non veniva letto
 * e ognuno risultava "mancante". La sezione "in scadenza" segnalava anche il
 * documento vecchio già rinnovato.
 *
 * Qui: un'azienda di prova con tre operai, email finta (nessuna spedita).
 *  - in regola (campi + idoneità vecchia scaduta e rinnovata) → in nessuna sezione;
 *  - senza niente → in "mancanti" con visita e corso;
 *  - visita scaduta → in "in scadenza", non in "mancanti".
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');

// Email finta: registra i riepiloghi invece di spedirli
const inviate = [];
const emailPath = path.join(__dirname, '../services/email.js');
const vera = require(emailPath);
require.cache[emailPath].exports = { ...vera, sendDailyAlertDigest: async (opts) => { inviate.push(opts); return { id: 'finta' }; } };

const supabase = require('../lib/supabase');
const { runDailyDigest } = require('../services/dailyDigestCron');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F351-${Date.now()}`;
const stamp = String(Date.now()).slice(-7);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const iso = d => d.toISOString().slice(0, 10);
const giorni = n => iso(new Date(Date.now() + n * 86400000));

async function main() {
  console.log('\n\x1b[1mF-351 — riepilogo conformità via email\x1b[0m');
  const company = await ins('companies', { name: T });
  let userId = null;
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `f351-owner-${stamp}@example.com`, email_confirm: true, password: crypto.randomBytes(12).toString('hex'),
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    userId = data.user.id;
    await ins('company_users', { company_id: company.id, user_id: userId, role: 'owner' });

    const worker = (nome, extra = {}) => ins('workers', {
      company_id: company.id, full_name: `${nome} ${stamp}`, is_active: true,
      fiscal_code: `F351${nome.slice(0, 3)}${stamp}`.toUpperCase().slice(0, 16), badge_code: `F351-${nome}-${stamp}`, ...extra,
    });
    const inRegola = await worker('InRegola', { health_fitness_expiry: giorni(300), safety_training_expiry: giorni(1500) });
    const senza    = await worker('Senza');
    const scaduto  = await worker('Scaduto', { health_fitness_expiry: giorni(-10), safety_training_expiry: giorni(1500) });
    // Visita vecchia scaduta e il suo rinnovo (il caso di Aldo Mantelli)
    for (const exp of [giorni(-89), giorni(300)]) {
      await ins('worker_documents', {
        company_id: company.id, worker_id: inRegola.id, doc_type: 'idoneita_medica',
        name: `idoneita ${exp}.pdf`, file_path: `test/${T}/${exp}.pdf`, expiry_date: exp,
      });
    }

    await runDailyDigest({ companyIds: [company.id] });

    const mia = inviate.find(e => e.companyName === T);
    check('parte un riepilogo per l\'azienda di prova', !!mia, inviate.map(e => e.companyName));
    if (mia) {
      const mancanti = mia.sections.missingDocs.map(w => w.full_name);
      check('mancanti: solo chi non ha niente', mancanti.length === 1 && mancanti[0] === senza.full_name, mancanti);
      check('mancanti: visita e corso per chi non ha niente',
        JSON.stringify(mia.sections.missingDocs[0]?.missingTypes) === JSON.stringify(['Visita medica', 'Corso sicurezza']),
        mia.sections.missingDocs[0]);
      const scad = mia.sections.workerExpiry.map(d => `${d.worker?.full_name}|${d.typeLabel}`);
      check('chi è in regola non compare tra le scadenze (rinnovo visto)',
        !scad.some(s => s.startsWith(inRegola.full_name)), scad);
      check('visita scaduta: compare tra le scadenze',
        scad.includes(`${scaduto.full_name}|Visita medica`), scad);
      check('visita scaduta: giorni e gravità giusti',
        mia.sections.workerExpiry.some(d => d.worker?.full_name === scaduto.full_name && d.days === -10 && d.severity === 'critical'),
        mia.sections.workerExpiry);
      check('l\'oggetto non parla di 3 mancanti', mia.sections.missingDocs.length === 1);
    }
  } finally {
    await supabase.from('worker_documents').delete().eq('company_id', company.id);
    await supabase.from('documents').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('company_users').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
    if (userId) await supabase.auth.admin.deleteUser(userId);
  }
  console.log(`\n  ${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
