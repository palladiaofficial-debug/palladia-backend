#!/usr/bin/env node
/**
 * scripts/selftest_economia_movimenti_sync.js
 *
 * Test di regressione per il BLOCCO 1 del modulo Controllo Economico
 * (AUDIT.md F-119): il registro unico `site_economia_movimenti` deve
 * riflettere in tempo reale ogni scrittura sulle sorgenti collegate
 * (company_expenses, site_costs, site_computo, site_subcontracts,
 * site_subcontract_sal, site_sal_history, presence_logs) e non deve MAI
 * bloccare la scrittura sulla tabella sorgente se la sync stessa fallisce.
 *
 * Tutto su dati reali contro Supabase, con cleanup a fine test.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function execSql(sql) {
  let { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) ({ error } = await supabase.rpc('exec_sql', { sql }));
  return error;
}

async function getMov(sourceTable, sourceId) {
  const { data } = await supabase.from('site_economia_movimenti')
    .select('*').eq('source_table', sourceTable).eq('source_id', String(sourceId)).maybeSingle();
  return data;
}

async function main() {
  console.log('\nPalladia site_economia_movimenti sync regression — BLOCCO 1 (F-119)\n');

  const { data: company } = await supabase.from('companies').insert({ name: 'TEST-EconomiaSync-Probe' }).select().single();
  check('Creata azienda temporanea', !!company);
  const companyId = company.id;
  const { data: site } = await supabase.from('sites').insert({ company_id: companyId, name: 'TEST site economia', status: 'attivo', address: 'Via Test 1' }).select().single();
  check('Creato cantiere temporaneo', !!site);
  const siteId = site.id;
  const { data: worker } = await supabase.from('workers').insert({
    company_id: companyId, full_name: 'TEST Worker Economia',
    fiscal_code: `TSTEC${Date.now()}`.slice(0, 16).toUpperCase(), is_active: true,
    badge_code: `TSTEC${Date.now()}`, tariffa_oraria: 20,
  }).select().single();
  check('Creato lavoratore temporaneo con tariffa oraria', !!worker);
  const workerId = worker.id;
  const { data: subcontractor } = await supabase.from('subcontractors').insert({ company_id: companyId, company_name: 'TEST Subappaltatore Economia' }).select().single();
  check('Creato subappaltatore temporaneo', !!subcontractor);
  const subcontractorId = subcontractor.id;

  // ── 1. company_expenses (il ponte fatture→margine) ──────────────────────
  {
    const { data: row } = await supabase.from('company_expenses').insert({
      company_id: companyId, amount: 1234.56, description: 'TEST fattura materiali',
      category: 'materiali', site_id: siteId, expense_date: '2026-01-10',
    }).select().single();
    let mov = await getMov('company_expenses', row.id);
    check('company_expenses con site_id genera riga consuntivo/materiali', mov && mov.tipo === 'consuntivo' && mov.categoria === 'materiali' && Number(mov.importo) === 1234.56, mov);

    await supabase.from('company_expenses').update({ amount: 999 }).eq('id', row.id);
    mov = await getMov('company_expenses', row.id);
    check('UPDATE importo si riflette nel registro', mov && Number(mov.importo) === 999, mov);

    await supabase.from('company_expenses').update({ site_id: null }).eq('id', row.id);
    mov = await getMov('company_expenses', row.id);
    check('Rimuovere l\'attribuzione a cantiere rimuove la riga dal registro', !mov, mov);

    await supabase.from('company_expenses').delete().eq('id', row.id);
  }
  {
    const { data: row } = await supabase.from('company_expenses').insert({
      company_id: companyId, amount: 500, description: 'TEST subappalto fattura',
      category: 'subappalto', site_id: siteId, expense_date: '2026-01-10',
    }).select().single();
    const mov = await getMov('company_expenses', row.id);
    check('Categoria "subappalto" mappata correttamente su "subappalti"', mov && mov.categoria === 'subappalti', mov);
    await supabase.from('company_expenses').delete().eq('id', row.id);
    check('DELETE company_expenses rimuove la riga dal registro', !(await getMov('company_expenses', row.id)));
  }

  // ── 2. site_costs ─────────────────────────────────────────────────────────
  {
    const { data: row } = await supabase.from('site_costs').insert({
      company_id: companyId, site_id: siteId, descrizione: 'TEST DDT nolo gru', importo: 300,
      tipo: 'ddt', categoria: 'Nolo',
    }).select().single();
    const mov = await getMov('site_costs', row.id);
    check('site_costs genera riga consuntivo/noleggi', mov && mov.tipo === 'consuntivo' && mov.categoria === 'noleggi' && Number(mov.importo) === 300, mov);
    await supabase.from('site_costs').delete().eq('id', row.id);
    check('DELETE site_costs rimuove la riga dal registro', !(await getMov('site_costs', row.id)));
  }

  // ── 3. site_computo (budget) ────────────────────────────────────────────
  let computoId;
  {
    const { data: row } = await supabase.from('site_computo').insert({
      company_id: companyId, site_id: siteId, nome: 'TEST computo', fonte: 'manuale', totale_contratto: 100000,
    }).select().single();
    computoId = row.id;
    const mov = await getMov('site_computo', row.id);
    check('site_computo (base) genera riga budget', mov && mov.tipo === 'budget' && Number(mov.importo) === 100000, mov);
  }

  // ── 4/5. site_subcontracts → impegnato, site_subcontract_sal → consuntivo ──
  let subcontractId;
  {
    const { data: contract } = await supabase.from('site_subcontracts').insert({
      company_id: companyId, site_id: siteId, subcontractor_id: subcontractorId,
      descrizione: 'TEST impianto elettrico', importo_pattuito: 20000, stato: 'emesso',
    }).select().single();
    subcontractId = contract.id;
    const movImpegnato = await getMov('site_subcontracts', contract.id);
    check('Contratto subappalto emesso genera riga impegnato/subappalti', movImpegnato && movImpegnato.tipo === 'impegnato' && movImpegnato.categoria === 'subappalti' && Number(movImpegnato.importo) === 20000, movImpegnato);

    const { data: draft } = await supabase.from('site_subcontracts').insert({
      company_id: companyId, site_id: siteId, subcontractor_id: subcontractorId,
      descrizione: 'TEST bozza non ancora emessa', importo_pattuito: 5000, stato: 'bozza',
    }).select().single();
    check('Contratto in stato bozza NON genera riga impegnato', !(await getMov('site_subcontracts', draft.id)));
    await supabase.from('site_subcontracts').delete().eq('id', draft.id);

    const { data: sal } = await supabase.from('site_subcontract_sal').insert({
      subcontract_id: subcontractId, company_id: companyId, site_id: siteId, importo: 8000,
    }).select().single();
    const movConsuntivo = await getMov('site_subcontract_sal', sal.id);
    check('SAL del subappaltatore genera riga consuntivo/subappalti', movConsuntivo && movConsuntivo.tipo === 'consuntivo' && Number(movConsuntivo.importo) === 8000, movConsuntivo);

    const movImpegnatoAncora = await getMov('site_subcontracts', contract.id);
    check('L\'impegnato originale resta invariato dopo il SAL (nessun decremento distruttivo)', movImpegnatoAncora && Number(movImpegnatoAncora.importo) === 20000, movImpegnatoAncora);

    await supabase.from('site_subcontract_sal').delete().eq('id', sal.id);
  }

  // ── 6. site_sal_history → ricavo (delta, non cumulativo) ────────────────
  {
    const { data: sal1 } = await supabase.from('site_sal_history').insert({
      company_id: companyId, site_id: siteId, sal_number: 1, sal_percentuale: 20,
      totale_contratto: 100000, importo_maturato: 20000,
    }).select().single();
    const mov1 = await getMov('site_sal_history', sal1.id);
    check('Primo SAL genera ricavo pari all\'intero maturato (20000)', mov1 && mov1.tipo === 'ricavo' && Number(mov1.importo) === 20000, mov1);

    const { data: sal2 } = await supabase.from('site_sal_history').insert({
      company_id: companyId, site_id: siteId, sal_number: 2, sal_percentuale: 50,
      totale_contratto: 100000, importo_maturato: 50000,
    }).select().single();
    const mov2 = await getMov('site_sal_history', sal2.id);
    check('Secondo SAL genera ricavo pari al DELTA (50000-20000=30000), non al cumulativo', mov2 && Number(mov2.importo) === 30000, mov2);

    await supabase.from('site_sal_history').delete().eq('id', sal2.id);
    await supabase.from('site_sal_history').delete().eq('id', sal1.id);
  }

  // ── 7. Manodopera: sync_site_mo_consuntivo() da timbrature reali ────────
  {
    const entry = new Date('2026-01-10T08:00:00Z').toISOString();
    const exit  = new Date('2026-01-10T16:00:00Z').toISOString(); // 8 ore
    const { error: plErr } = await supabase.from('presence_logs').insert([
      { company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'ENTRY', timestamp_server: entry },
      { company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'EXIT',  timestamp_server: exit },
    ]);
    check('Timbrature ENTRY/EXIT inserite', !plErr, plErr);
    const { error: syncErr } = await supabase.rpc('sync_site_mo_consuntivo', { p_site_id: siteId });
    check('sync_site_mo_consuntivo() eseguita senza errori', !syncErr, syncErr);
    const mov = await getMov('presence_logs_aggregate', `${siteId}:${workerId}`);
    // 8 ore × 20 €/h = 160 €
    check('Timbrature (8h × 20€/h) generano riga consuntivo/manodopera da 160€', mov && mov.tipo === 'consuntivo' && mov.categoria === 'manodopera' && Number(mov.importo) === 160, mov);
  }

  // ── 8. Vincolo esplicito: un fallimento di sync non deve MAI bloccare la scrittura sorgente ──
  {
    const breakErr = await execSql(`ALTER TABLE site_economia_movimenti ADD CONSTRAINT test_force_economia_sync_failure CHECK (1 = 0) NOT VALID;`);
    check('Vincolo impossibile applicato a site_economia_movimenti (per rompere la sync di proposito)', !breakErr, breakErr);

    const { data: row, error: insertErr } = await supabase.from('site_costs')
      .insert({ company_id: companyId, site_id: siteId, descrizione: 'TEST resilienza', importo: 50, tipo: 'altro' })
      .select().single();
    check('INSERT su site_costs riesce comunque, nonostante site_economia_movimenti sia rotta', !insertErr && row, insertErr);

    if (row) {
      const { data: failures } = await supabase.from('economia_sync_failures')
        .select('*').eq('source_table', 'site_costs').eq('source_id', row.id);
      check('Il fallimento di sync è stato loggato in economia_sync_failures', failures && failures.length === 1 && /1 = 0|check/i.test(failures[0].error_message || ''), failures);
      if (failures?.length) {
        await supabase.from('economia_sync_failures').update({ resolved_at: new Date().toISOString() }).in('id', failures.map(f => f.id));
      }
    }

    const restoreErr = await execSql(`ALTER TABLE site_economia_movimenti DROP CONSTRAINT IF EXISTS test_force_economia_sync_failure;`);
    check('Vincolo di test rimosso, site_economia_movimenti ripristinata', !restoreErr, restoreErr);

    if (row) {
      await supabase.from('site_costs').update({ importo: 75 }).eq('id', row.id);
      const mov = await getMov('site_costs', row.id);
      check('Dopo il ripristino, la sync riprende a funzionare normalmente', mov && Number(mov.importo) === 75, mov);
      await supabase.from('site_costs').delete().eq('id', row.id);
    }
  }

  // ── Verifica allineamento globale non deve peggiorare per colpa del test ──
  {
    const { data: verify, error } = await supabase.rpc('verify_economia_movimenti_sync');
    check('verify_economia_movimenti_sync() eseguibile senza errori', !error, error);
    if (verify) {
      const bad = verify.filter(r => r.mismatched_count > 0 || r.orphaned_count > 0);
      check('Nessuna sorgente con mismatch/orfani residui dopo il test (cleanup pulito)', bad.length === 0, bad);
    }
  }

  // ── Cleanup ──
  try { await supabase.from('site_subcontracts').delete().eq('id', subcontractId); } catch { /* best-effort */ }
  try { await supabase.from('site_computo').delete().eq('id', computoId); } catch { /* best-effort */ }
  try { await supabase.from('presence_logs').delete().eq('worker_id', workerId); } catch { /* best-effort */ }
  try { await supabase.from('subcontractors').delete().eq('id', subcontractorId); } catch { /* best-effort */ }
  try { await supabase.from('workers').delete().eq('id', workerId); } catch { /* best-effort */ }
  try { await supabase.from('sites').delete().eq('id', siteId); } catch { /* best-effort */ }
  try { await supabase.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
