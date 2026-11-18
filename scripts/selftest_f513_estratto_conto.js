#!/usr/bin/env node
/**
 * scripts/selftest_f513_estratto_conto.js — F-513 (AUDIT.md del frontend, 18/11/2026).
 *
 * L'estratto conto della banca, caricato dal titolare, segna le fatture pagate davvero.
 *   1. si leggono i formati di cinque banche (Intesa xlsx, UniCredit csv, BPER csv
 *      Dare/Avere, Banco BPM xlsx Entrate/Uscite, Poste csv con anno a 2 cifre):
 *      stessi 7 movimenti, stessi importi, stesse date;
 *   2. importi e date all'italiana; PDF e colonne sconosciute danno un errore chiaro;
 *   3. abbinamento sulle fatture di MSC (importi e fornitori veri):
 *      Stelli 600 + 1.500 con un solo bonifico da 2.100 → sicuro;
 *      Guardalà 4.702 e WC Loc 922,47 col nome nel bonifico → sicuro;
 *      3.450,91 pagato col POS (nessun nome) → da confermare;
 *      stipendi, F24 e l'incasso dal condominio → mai.
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const L = require('../lib/estrattoConto/leggi');
const { abbina } = require('../lib/estrattoConto/abbina');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

const ATTESI = [
  ['2026-10-20', -2100], ['2026-10-22', -4702], ['2026-10-25', -922.47], ['2026-10-27', -3450.91],
  ['2026-10-27', -38471.53], ['2026-10-16', -5120.4], ['2026-10-30', 12000],
];
const FATTURE = [
  { id: 'stelli-207', fornitore: 'STELLI IMPIANTI DI STELLI MARCO', importo: 600, data: '2026-10-15' },
  { id: 'stelli-277', fornitore: 'STELLI IMPIANTI DI STELLI MARCO', importo: 1500, data: '2026-10-15' },
  { id: 'guardala-10', fornitore: "GUARDALA' GIUSEPPINA", importo: 4702, data: '2026-10-15' },
  { id: 'wcloc-621', fornitore: 'WC Loc Italia S.r.l. Unipersonale', importo: 922.47, data: '2026-08-31' },
  { id: 'wcloc-pos', fornitore: 'WC LOC ITALIA S.r.l.', importo: 3450.91, data: '2026-10-15' },
];

async function main() {
  console.log('\nPalladia regression — F-513: l\'estratto conto segna le fatture pagate davvero\n');

  // 2. Numeri e date all'italiana
  check('«-2.100,00» → -2100', L.importoItaliano('-2.100,00') === -2100);
  check('«1.234,56» → 1234.56', L.importoItaliano('1.234,56') === 1234.56);
  check('«12,00-» (segno in fondo) → -12', L.importoItaliano('12,00-') === -12);
  check('«€ 922,47» → 922.47', L.importoItaliano('€ 922,47') === 922.47);
  check('«1234.56» (punto decimale) → 1234.56', L.importoItaliano('1234.56') === 1234.56);
  check('«20/10/2026» → 2026-10-20', L.dataIso('20/10/2026') === '2026-10-20');
  check('«20/10/26» → 2026-10-20', L.dataIso('20/10/26') === '2026-10-20');
  check('«Saldo finale» non è una data', L.dataIso('Saldo finale') === null);

  // 1. Cinque banche
  const DIR = path.join(__dirname, 'fixtures', 'estratti');
  if (!fs.existsSync(path.join(DIR, 'intesa.xlsx'))) require('child_process').execSync(`node "${path.join(__dirname, 'fixture_estratti_conto.js')}"`);
  for (const f of ['intesa.xlsx', 'unicredit.csv', 'bper.csv', 'bancobpm.xlsx', 'poste.csv']) {
    const r = await L.leggiEstratto(fs.readFileSync(path.join(DIR, f)), f);
    const ok = !r.errore && r.movimenti.length === 7 && ATTESI.every(([d, imp], i) => r.movimenti[i].data === d && r.movimenti[i].importo === imp);
    check(`${f}: 7 movimenti con date e importi giusti`, ok, r.errore || r.movimenti.map(m => [m.data, m.importo]));
    check(`${f}: la descrizione c'è`, r.movimenti[0]?.descrizione?.includes('STELLI'), r.movimenti[0]);
  }
  check('PDF → errore chiaro (scarica l\'Excel)', (await L.leggiEstratto(Buffer.from('%PDF-1.4'), 'estratto.pdf')).errore === 'PDF');
  check('colonne sconosciute → errore chiaro', L.movimentiDaRighe([['nome', 'cognome'], ['a', 'b']]).errore === 'COLONNE');

  // 3. Abbinamento
  const { movimenti } = await L.leggiEstratto(fs.readFileSync(path.join(DIR, 'unicredit.csv')), 'unicredit.csv');
  const ris = abbina(movimenti, FATTURE);
  const di = (id) => ris.find(r => r.fatture.some(f => f.id === id));
  const stelli = di('stelli-207');
  check('Stelli: un bonifico da 2.100 € per le due fatture (600 + 1.500) → sicuro',
    stelli && stelli.tipo === 'sicuro' && stelli.fatture.length === 2 && di('stelli-277') === stelli && stelli.movimento.importo === -2100, stelli);
  check('Guardalà 4.702 € col nome nel bonifico → sicuro', di('guardala-10')?.tipo === 'sicuro', di('guardala-10'));
  check('WC Loc 922,47 € (addebito SDD col nome) → sicuro', di('wcloc-621')?.tipo === 'sicuro', di('wcloc-621'));
  check('3.450,91 € pagato col POS, senza nome → da confermare', di('wcloc-pos')?.tipo === 'da_confermare', di('wcloc-pos'));
  check('stipendi, F24 e incasso dal condominio non abbinano', ris.every(r => ![-38471.53, -5120.4, 12000].includes(r.movimento.importo)), ris.map(r => r.movimento.importo));
  check('ogni fattura al massimo una volta', new Set(ris.flatMap(r => r.fatture.map(f => f.id))).size === ris.flatMap(r => r.fatture).length);
  // Un bonifico più vecchio della fattura (oltre 10 giorni) non la paga
  const vecchio = abbina([{ data: '2026-09-01', importo: -4702, descrizione: 'BONIFICO GUARDALA GIUSEPPINA' }], FATTURE);
  check('un bonifico di settembre non paga una fattura del 15 ottobre', vecchio.length === 0, vecchio);
  // Due importi uguali senza nome: nessuna proposta (non si indovina)
  const due = abbina([{ data: '2026-10-20', importo: -100, descrizione: 'PAGAMENTO' }], [{ id: 'a', fornitore: 'Alfa', importo: 100, data: '2026-10-01' }, { id: 'b', fornitore: 'Beta', importo: 100, data: '2026-10-01' }]);
  check('stesso importo per due fornitori, senza nome → nessuna proposta', due.length === 0, due);

  // 4. Il percorso completo su un'impresa temporanea (nessun dato vero toccato)
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = require('../lib/supabase');
    const E = require('../lib/estrattoConto');
    const { data: co } = await supabase.from('companies').insert({ name: 'TEST-F513-Estratto' }).select('id').single();
    try {
      const ins = (supplier, amount, n) => ({ company_id: co.id, supplier, amount, invoice_number: n, expense_date: '2026-10-15', da_pagare: true, description: 'test F-513' });
      const { data: fat, error: fe } = await supabase.from('company_expenses').insert([
        ins('STELLI IMPIANTI DI STELLI MARCO', 600, '207/FE'), ins('STELLI IMPIANTI DI STELLI MARCO', 1500, '277/FE'),
        ins("GUARDALA' GIUSEPPINA", 4702, '10'), ins('WC Loc Italia S.r.l. Unipersonale', 922.47, '621169197'), ins('WC LOC ITALIA S.r.l.', 3450.91, null),
      ]).select('id, invoice_number, amount');
      if (fe) throw new Error(fe.message);
      const id = (n) => fat.find(f => f.invoice_number === n)?.id;
      const file = fs.readFileSync(path.join(DIR, 'unicredit.csv'));
      const r1 = await E.carica({ companyId: co.id, userId: null, buffer: file, nomeFile: 'unicredit.csv' });
      check('caricamento: 7 movimenti letti, 7 nuovi', r1.letti.movimenti === 7 && r1.letti.nuovi === 7, r1.letti);
      check('proposte: 3 sicure (Stelli doppia, Guardalà, WC Loc) e 1 dubbia (POS)', r1.sicure.length === 3 && r1.dubbie.length === 1, { s: r1.sicure.length, d: r1.dubbie.length });
      const stelli = r1.sicure.find(s => s.fatture.length === 2);
      await E.conferma(co.id, stelli.movimento.id, stelli.fatture.map(f => f.id));
      const { data: st } = await supabase.from('company_expenses').select('pagato_il, pagato_banca_at, pagato_movimento_id').in('id', [id('207/FE'), id('277/FE')]);
      check('Stelli confermate: data del bonifico (20/10) e «lo dice la banca»', st.every(x => x.pagato_il === '2026-10-20' && x.pagato_banca_at && x.pagato_movimento_id === stelli.movimento.id), st);
      const r2 = await E.carica({ companyId: co.id, userId: null, buffer: file, nomeFile: 'unicredit.csv' });
      check('stesso file ricaricato: 0 movimenti nuovi, Stelli non più proposta', r2.letti.nuovi === 0 && r2.sicure.length === 2 && !r2.sicure.some(s => s.fatture.some(f => f.id === id('207/FE'))), { nuovi: r2.letti.nuovi, s: r2.sicure.length });
      let rif = null;
      try { await E.conferma(co.id, stelli.movimento.id, [id('10')]); } catch (e) { rif = e; }
      check('un movimento già usato non si riusa', rif && rif.status === 409, rif && rif.message);
      const guard = r2.sicure.find(s => s.fatture[0].id === id('10'));
      rif = null;
      try { await E.conferma(co.id, guard.movimento.id, [id('621169197')]); } catch (e) { rif = e; }
      check('importo diverso dal movimento → rifiutato', rif && rif.status === 400, rif && rif.message);
      await E.scarta(co.id, r2.dubbie[0].movimento.id);
      const r3 = await E.proposte(co.id);
      check('«No» sul pagamento POS: non si propone più', r3.dubbie.length === 0, r3.dubbie);
    } finally {
      await supabase.from('company_expenses').delete().eq('company_id', co.id);
      await supabase.from('estratti_conto').delete().eq('company_id', co.id);
      await supabase.from('companies').delete().eq('id', co.id);
    }

    // 5. HTTP: spento per MSC (il flag non è acceso), tecnico respinto
    const base = process.env.SELFTEST_API_URL || 'https://palladia-backend-production.up.railway.app';
    const CO = '309e9018-1bcc-4876-9430-99cb89e043dd';
    const { createClient } = require('@supabase/supabase-js');
    const sessione = async (email) => {
      const { data: link } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
      const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false } });
      const { data } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
      return data.session?.access_token;
    };
    const ro = await fetch(`${base}/api/v1/estratto-conto/proposte`, { headers: { Authorization: `Bearer ${await sessione('carpio@mscedilizia.it')}`, 'X-Company-Id': CO } });
    const jo = await ro.json().catch(() => ({}));
    if (ro.status === 404 && jo.error !== 'FEATURE_DISABLED') console.log(`  – skip HTTP: rotta non ancora pubblicata su ${base}`);
    else {
      check('HTTP MSC titolare: spento (FEATURE_DISABLED) finché non lo accendiamo', ro.status === 404 && jo.error === 'FEATURE_DISABLED', { status: ro.status, jo });
      const { data: tech } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'tech').limit(1).maybeSingle();
      if (tech) {
        const { data: u } = await supabase.auth.admin.getUserById(tech.user_id);
        const rt = await fetch(`${base}/api/v1/estratto-conto/proposte`, { headers: { Authorization: `Bearer ${await sessione(u.user.email)}`, 'X-Company-Id': CO } });
        check('HTTP tecnico: 403', rt.status === 403, rt.status);
      }
    }
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
