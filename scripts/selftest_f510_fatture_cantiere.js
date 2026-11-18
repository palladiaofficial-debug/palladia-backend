#!/usr/bin/env node
/**
 * scripts/selftest_f510_fatture_cantiere.js — F-510 (AUDIT.md del frontend, 18/11/2026).
 *
 * Le fatture dei fornitori vanno sul cantiere giusto (lib/fattureCantiere.js):
 *   1. il cantiere si riconosce dal testo della fattura solo con via + numero
 *      civico («Corso Sardegna 95» non è «Corso Sardegna 88»); un nome senza
 *      numero («Magazzino MSCedilizia») non si propone mai;
 *   2. più cantieri nella stessa fattura: tutti proposti, nell'ordine in cui compaiono;
 *   3. il salvataggio: cantiere scelto → site_id; «spesa generale» → site_id NULL
 *      ma cantiere_scelto_at valorizzato, e la fattura non si richiede più;
 *      un cantiere di un'altra impresa → rifiutato (impresa temporanea, nessun dato vero toccato);
 *   4. dal vivo su MSC: l'elenco esce e Stelli 277/FE propone Corso Sardegna 95;
 *   5. HTTP: tech 403, cantiere non valido 400.
 */
'use strict';
require('dotenv').config({ quiet: true });
const FC = require('../lib/fattureCantiere');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}

async function main() {
  console.log('\nPalladia regression — F-510: le fatture sul cantiere giusto\n');

  // 1-2. Riconoscimento dal testo
  check('chiave di «Via Balbi 31»', JSON.stringify(FC.chiaveCantiere('Via Balbi 31')) === JSON.stringify({ parola: 'balbi', numero: '31' }));
  check('chiave di «Corso Sardegna 88»', FC.chiaveCantiere('Corso Sardegna 88').numero === '88');
  const siti = [
    { id: 's88', name: 'Corso Sardegna 88' }, { id: 's95', name: 'Corso Sardegna 95' },
    { id: 'sbalbi', name: 'Via Balbi 31' }, { id: 'smag', name: 'Magazzino MSCedilizia' }, { id: 'sriboli', name: 'Via Riboli 4b' },
  ];
  check('«Corso Sardegna 95» nel testo → solo il 95', JSON.stringify(FC.cantieriNelTesto('Lavori in Corso Sardegna, 95 - Genova', siti)) === '["s95"]', FC.cantieriNelTesto('Lavori in Corso Sardegna, 95 - Genova', siti));
  check('«Corso Sardegna» senza numero → nessuna proposta', FC.cantieriNelTesto('consegna Corso Sardegna Genova', siti).length === 0);
  check('il magazzino (nome senza numero) non si propone mai', !FC.cantieriNelTesto('Fattura a MSCedilizia S.r.l. magazzino MSCedilizia', siti).includes('smag'));
  check('«Via Riboli 4b» riconosciuto anche col numero con la lettera', JSON.stringify(FC.cantieriNelTesto('noleggio presso via riboli 4b', siti)) === '["sriboli"]');
  check('più cantieri nella stessa fattura: tutti, nell\'ordine del testo',
    JSON.stringify(FC.cantieriNelTesto('WC presso Via Balbi 31 e Corso Sardegna 88', siti)) === '["sbalbi","s88"]', FC.cantieriNelTesto('WC presso Via Balbi 31 e Corso Sardegna 88', siti));
  check('un 31 lontano dalla via non conta', FC.cantieriNelTesto('Via Balbi, consegnati il 31/08 materiali vari per un totale importante', siti).length === 0);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  – skip controlli dal vivo');
  } else {
    const supabase = require('../lib/supabase');
    // 3. Salvataggio su un'impresa temporanea
    const { data: co } = await supabase.from('companies').insert({ name: 'TEST-F510-Fatture' }).select('id').single();
    const { data: altra } = await supabase.from('companies').insert({ name: 'TEST-F510-Altra' }).select('id').single();
    const ids = { exp: [], sites: [] };
    try {
      const { data: s1 } = await supabase.from('sites').insert({ company_id: co.id, name: 'TEST Via Prova 12', address: 'Via Prova 12', status: 'attivo' }).select('id').single();
      const { data: sx } = await supabase.from('sites').insert({ company_id: altra.id, name: 'TEST Via Altra 3', address: 'Via Altra 3', status: 'attivo' }).select('id').single();
      ids.sites.push(s1.id, sx.id);
      const { data: e1, error: ee } = await supabase.from('company_expenses').insert({ company_id: co.id, supplier: 'TEST Fornitore', amount: 100, expense_date: '2026-11-01', description: 'test F-510' }).select('id').single();
      if (ee) throw new Error(ee.message);
      const { data: e2 } = await supabase.from('company_expenses').insert({ company_id: co.id, supplier: 'TEST Fornitore', amount: 50, expense_date: '2026-11-02', description: 'test F-510' }).select('id').single();
      ids.exp.push(e1.id, e2.id);

      let el = await FC.fattureSenzaCantiere(co.id);
      check('le 2 fatture nuove sono da assegnare', el.fatture.length === 2, el.fatture);
      await FC.assegna(co.id, e1.id, s1.id);
      const { data: r1 } = await supabase.from('company_expenses').select('site_id, cantiere_scelto_at').eq('id', e1.id).single();
      check('cantiere scelto → site_id salvato', r1.site_id === s1.id && !!r1.cantiere_scelto_at, r1);
      el = await FC.fattureSenzaCantiere(co.id);
      check('stesso fornitore: la fattura dopo propone lo stesso cantiere', el.fatture.length === 1 && el.fatture[0].proposte[0] === s1.id, el.fatture);
      await FC.assegna(co.id, e2.id, null);
      const { data: r2 } = await supabase.from('company_expenses').select('site_id, cantiere_scelto_at').eq('id', e2.id).single();
      check('«spesa generale» → site_id NULL ma risposta segnata', r2.site_id === null && !!r2.cantiere_scelto_at, r2);
      el = await FC.fattureSenzaCantiere(co.id);
      check('la spesa generale non si richiede più', el.fatture.length === 0, el.fatture);
      let rifiutato = false;
      try { await FC.assegna(co.id, e1.id, sx.id); } catch (e) { rifiutato = e.status === 404; }
      check('un cantiere di un\'altra impresa è rifiutato', rifiutato);
    } finally {
      await supabase.from('company_expenses').delete().in('id', ids.exp);
      await supabase.from('sites').delete().in('id', ids.sites);
      await supabase.from('companies').delete().in('id', [co.id, altra.id]);
    }

    // 4. Dal vivo su MSC (solo lettura)
    const CO = '309e9018-1bcc-4876-9430-99cb89e043dd';
    const msc = await FC.fattureSenzaCantiere(CO);
    const nome = Object.fromEntries(msc.cantieri.map(c => [c.id, c.nome]));
    const stelli = msc.fatture.find(f => f.numero === '277/FE');
    if (stelli) check('MSC: Stelli 277/FE propone Corso Sardegna 95 (scritto nella fattura)', nome[stelli.proposte[0]] === 'Corso Sardegna 95', stelli);
    check('MSC: nessuna proposta per il magazzino', !msc.fatture.some(f => f.proposte.some(id => /magazzino/i.test(nome[id] || ''))));

    // 5. HTTP
    const base = process.env.SELFTEST_API_URL || 'https://palladia-backend-production.up.railway.app';
    const { createClient } = require('@supabase/supabase-js');
    const sessione = async (email) => {
      const { data: link } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
      const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false } });
      const { data } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
      return data.session?.access_token;
    };
    const owner = await sessione('carpio@mscedilizia.it');
    const r = await fetch(`${base}/api/v1/quanto-rende/fatture-senza-cantiere`, { headers: { Authorization: `Bearer ${owner}`, 'X-Company-Id': CO } });
    if (r.status === 404) {
      console.log(`  – skip HTTP: rotta non ancora pubblicata su ${base}`);
    } else {
      const j = await r.json();
      check('HTTP owner: elenco fatture e cantieri', r.status === 200 && Array.isArray(j.fatture) && Array.isArray(j.cantieri), { status: r.status, j });
      const bad = await fetch(`${base}/api/v1/quanto-rende/fattura/${msc.fatture[0]?.id || '00000000-0000-0000-0000-000000000000'}`, { method: 'PATCH', headers: { Authorization: `Bearer ${owner}`, 'X-Company-Id': CO, 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: 'inventato' }) });
      check('HTTP: cantiere non valido → 400', bad.status === 400, bad.status);
      const { data: tech } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'tech').limit(1).maybeSingle();
      if (tech) {
        const { data: u } = await supabase.auth.admin.getUserById(tech.user_id);
        const rt = await fetch(`${base}/api/v1/quanto-rende/fatture-senza-cantiere`, { headers: { Authorization: `Bearer ${await sessione(u.user.email)}`, 'X-Company-Id': CO } });
        check('HTTP tech: 403', rt.status === 403, rt.status);
      }
    }
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
