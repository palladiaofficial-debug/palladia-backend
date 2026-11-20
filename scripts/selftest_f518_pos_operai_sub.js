#!/usr/bin/env node
/**
 * scripts/selftest_f518_pos_operai_sub.js — F-518 (AUDIT.md del frontend).
 *
 * Il POS di un subappaltatore deve vedere gli operai e i documenti caricati in Imprese
 * (sub_workers + sub_worker_documenti), non solo la vecchia tabella workers.
 *
 * 1. Sull'azienda di prova (crea e poi toglie): un cantiere, un'impresa, 3 operai:
 *    - Anna: corso, visita e «Corso preposto» buoni → formazione e idoneità valide, corso preposto;
 *    - Bruno: solo il corso (senza scadenza: vale) → idoneità mancante;
 *    - Carlo: visita «non va», corso da guardare → tutti e due mancanti;
 *    - un operaio tolto (deactivated_at) non c'è.
 * 2. MSC (sola lettura): AYAT per Corso Sardegna 88 → 5 operai, 3 completi.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const { buildPosPrefill } = require('../lib/posPrefill');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const E2E = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const MSC = '309e9018-1bcc-4876-9430-99cb89e043dd';
const AYAT = '7ecb1176-3838-4822-ba9b-006c14b773ef';
const SARDEGNA = '0c2d0326-330a-4ff6-ac87-4373656176d9';
const ins = async (t, row) => { const { data, error } = await supabase.from(t).insert(row).select('id').single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };

(async () => {
  console.log('\nF-518 — il POS vede gli operai caricati in Imprese (azienda di prova)');
  let site = null, sub = null;
  try {
    site = await ins('sites', { company_id: E2E, name: 'TEST-F518 Cantiere POS', address: 'Via Prova 1, Genova', status: 'attivo' });
    sub = await ins('subcontractors', { company_id: E2E, company_name: 'TEST-F518 Impresa', piva: '0' + String(Date.now()).slice(-10), is_active: true });
    const op = (full_name, extra = {}) => ins('sub_workers', { company_id: E2E, subcontractor_id: sub.id, full_name, added_via: 'link', ...extra });
    const anna = await op('Anna Rossi'), bruno = await op('Bruno Verdi'), carlo = await op('Carlo Neri');
    await op('Dario Tolto', { deactivated_at: new Date().toISOString() });
    const doc = (w, tipo, x = {}) => ins('sub_worker_documenti', { company_id: E2E, sub_worker_id: w.id, tipo, file_path: `x/${w.id}/${tipo}`, dall_impresa: true, esito: 'va_bene', ...x });
    await doc(anna, 'formazione', { scadenza: '2031-10-06' });
    await doc(anna, 'idoneita', { scadenza: '2027-09-28' });
    await doc(anna, 'altro', { titolo: 'Corso preposto', scadenza: '2029-01-01' });
    await doc(bruno, 'formazione', { scadenza: null });
    await doc(carlo, 'idoneita', { scadenza: '2027-09-28', esito: 'non_va' });
    await doc(carlo, 'formazione', { scadenza: '2031-01-01', esito: null });

    const p = await buildPosPrefill(E2E, site.id, sub.id);
    const by = Object.fromEntries(p.workers.map(w => [w.name, w]));
    check('3 operai dell\'impresa nel POS (quello tolto no)', p.workers.length === 3 && !by['Dario Tolto'], p.workers.map(w => w.name));
    check('Anna: formazione e idoneità valide, con le date', by['Anna Rossi']?.training.status === 'valido' && by['Anna Rossi'].training.date === '2031-10-06' && by['Anna Rossi'].fitness.status === 'valido' && by['Anna Rossi'].fitness.date === '2027-09-28', by['Anna Rossi']);
    check('Anna: il «Corso preposto» caricato in Imprese conta tra i corsi', (by['Anna Rossi']?.corsi || []).includes('Corso preposto'), by['Anna Rossi']?.corsi);
    check('Bruno: attestato senza scadenza → formazione valida; visita mancante', by['Bruno Verdi']?.training.status === 'valido' && by['Bruno Verdi'].fitness.status === 'mancante', by['Bruno Verdi']);
    check('Carlo: visita «non va» e corso da guardare → tutti e due mancanti', by['Carlo Neri']?.training.status === 'mancante' && by['Carlo Neri'].fitness.status === 'mancante', by['Carlo Neri']);
  } finally {
    if (sub) {
      const { data: ops } = await supabase.from('sub_workers').select('id').eq('subcontractor_id', sub.id);
      if (ops?.length) await supabase.from('sub_worker_documenti').delete().in('sub_worker_id', ops.map(o => o.id));
      await supabase.from('sub_workers').delete().eq('subcontractor_id', sub.id);
      await supabase.from('subcontractors').delete().eq('id', sub.id);
    }
    if (site) await supabase.from('sites').delete().eq('id', site.id);
  }

  console.log('\nF-518 — MSC (sola lettura): AYAT per Corso Sardegna 88');
  const p = await buildPosPrefill(MSC, SARDEGNA, AYAT);
  const ok = p.workers.filter(w => w.training.status === 'valido' && w.fitness.status === 'valido');
  check('AYAT: 5 operai nel POS, 3 con corso e visita validi', p.workers.length === 5 && ok.length === 3, p.workers.map(w => `${w.name}: ${w.training.status}/${w.fitness.status}`));

  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
