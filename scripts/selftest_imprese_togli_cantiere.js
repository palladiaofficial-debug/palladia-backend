#!/usr/bin/env node
/**
 * scripts/selftest_imprese_togli_cantiere.js — F-462 (AUDIT.md del frontend, 8/11).
 *
 * «Togli da questo cantiere» passa dalle pagine classiche dei subappaltatori alla scheda nuova
 * dell'impresa (lib/imprese.togliDaCantiere). Su un'azienda di prova vera (DB):
 *  - un'impresa in un cantiere senza importi si toglie davvero (la riga sparisce);
 *  - se sulla coppia impresa-cantiere c'è un budget, un SAL o un pagamento NON si toglie
 *    (409 HA_IMPORTI) e la riga resta col suo budget: prima la vecchia rotta cancellava tutto;
 *  - un'impresa che non è in quel cantiere → 404; un'impresa di un'altra azienda → 404.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const I = require('../lib/imprese');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const errore = async (fn) => { try { await fn(); return null; } catch (e) { return { status: e.status, code: e.code }; } };

(async () => {
  console.log('\n\x1b[1mF-462 — togli un\'impresa da un cantiere, senza perdere budget e pagamenti\x1b[0m');
  const T = `TEST-F462-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  const altra = await ins('companies', { name: `${T} altra` });
  try {
    const a = await ins('sites', { company_id: co.id, name: `${T} Via Libera`, address: 'Via Libera 1, Genova', status: 'attivo' });
    const b = await ins('sites', { company_id: co.id, name: `${T} Via Budget`, address: 'Via Budget 1, Genova', status: 'attivo' });
    const c = await ins('sites', { company_id: co.id, name: `${T} Via Pagata`, address: 'Via Pagata 1, Genova', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: co.id, company_name: `${T} AYAT`, is_active: true });
    const subAltra = await ins('subcontractors', { company_id: altra.id, company_name: `${T} Altra`, is_active: true });
    await ins('site_subcontractors', { company_id: co.id, site_id: a.id, subcontractor_id: sub.id });
    await ins('site_subcontractors', { company_id: co.id, site_id: b.id, subcontractor_id: sub.id, budget_totale: 11000, sal_percentuale: 70 });
    await ins('site_subcontractors', { company_id: co.id, site_id: c.id, subcontractor_id: sub.id });
    await ins('site_costs', { company_id: co.id, site_id: c.id, subcontractor_id: sub.id, descrizione: `${T} acconto`, importo: 500, tipo: 'manuale', data_documento: '2026-11-01' })
      .catch(async () => ins('site_costs', { company_id: co.id, site_id: c.id, subcontractor_id: sub.id, descrizione: `${T} acconto`, importo: 500 }));
    const riga = async (siteId) => (await supabase.from('site_subcontractors').select('id, budget_totale').eq('site_id', siteId).eq('subcontractor_id', sub.id).maybeSingle()).data;

    const e1 = await errore(() => I.togliDaCantiere(co.id, sub.id, a.id));
    check('senza importi: si toglie', e1 === null, e1);
    check('senza importi: la riga non c\'è più', (await riga(a.id)) === null);

    const e2 = await errore(() => I.togliDaCantiere(co.id, sub.id, b.id));
    check('con budget e SAL: 409 HA_IMPORTI', e2 && e2.status === 409 && e2.code === 'HA_IMPORTI', e2);
    const rb = await riga(b.id);
    check('con budget e SAL: la riga resta col suo budget', rb && Number(rb.budget_totale) === 11000, rb);

    const e3 = await errore(() => I.togliDaCantiere(co.id, sub.id, c.id));
    check('con un pagamento: 409 HA_IMPORTI', e3 && e3.status === 409 && e3.code === 'HA_IMPORTI', e3);
    check('con un pagamento: la riga resta', (await riga(c.id)) !== null);

    const e4 = await errore(() => I.togliDaCantiere(co.id, sub.id, a.id));
    check('non più in quel cantiere: 404', e4 && e4.status === 404, e4);

    const e5 = await errore(() => I.togliDaCantiere(co.id, subAltra.id, b.id));
    check('impresa di un\'altra azienda: 404', e5 && e5.status === 404, e5);
  } catch (e) {
    console.error(e); failed++;
  } finally {
    for (const id of [co.id, altra.id]) {
      await supabase.from('site_costs').delete().eq('company_id', id);
      await supabase.from('site_subcontractors').delete().eq('company_id', id);
      await supabase.from('subcontractors').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})();
