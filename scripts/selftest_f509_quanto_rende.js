#!/usr/bin/env node
/**
 * scripts/selftest_f509_quanto_rende.js — F-509 (AUDIT.md del frontend, 18/11/2026).
 *
 * Quanto costa la manodopera di ogni cantiere, da prospetto contabile, buste
 * paga e timbrature (lib/quantoRende.js). Controlla:
 *   1. lettura del prospetto (lorde + oneri ditta) e dell'imponibile della busta;
 *   2. ripartizione: chi non si legge prende il resto, il totale torna sempre;
 *   3. costo orario sulle ore di contratto del mese intero (non sulle timbrate);
 *      magazzino e simili nelle spese generali, mai su un cantiere;
 *   4. dal vivo su MSCedilizia S.r.l. (ottobre 2026): conto pronto, totale =
 *      cantieri + spese generali, costo orario dei cantieri plausibile (15-35 €/h),
 *      nessun magazzino fra i cantieri;
 *   5. dal vivo via HTTP: owner vede, tech riceve 403 (sono paghe, F-494).
 */
'use strict';
require('dotenv').config({ quiet: true });
const Q = require('../lib/quantoRende');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const vicino = (a, b) => Math.abs(a - b) < 0.6;

async function main() {
  console.log('\nPalladia regression — F-509: quanto rende ogni cantiere\n');

  // 1. Lettura
  const P = 'PROSPETTO CONTABILE PERIODO LIQUIDAZIONE OTTOBRE 2026 N0100 Retribuzioni lorde 38.471,53 ... DZTOT Totale oneri ditta 15.087,48 W Totale contr.';
  check('prospetto: lorde e oneri ditta letti', JSON.stringify(Q.leggiProspetto(P)) === JSON.stringify({ lorde: 38471.53, oneri: 15087.48 }), Q.leggiProspetto(P));
  check('un testo che non è un prospetto contabile → null', Q.leggiProspetto('PROSPETTO DETTAGLIO FONDI Retribuzioni lorde 1.000,00') === null);
  check('busta: imponibile F.P.L.D. letto', Q.leggiImponibile('Ore mal./inf.: | IMP.LE F.P.L.D. 2655,00 IMP.LE IMP.LE TOTALE') === 2655);
  check('busta senza imponibile → null', Q.leggiImponibile('CEDOLINO PAGA') === null);

  // 2. Ripartizione
  const r = Q.ripartisci({ lorde: 10000, oneri: 4000, imponibili: { a: 3000, b: 5000, c: null, d: null } });
  check('chi si legge: imponibile × (lorde+oneri)/lorde', vicino(r.a.costo, 4200) && vicino(r.b.costo, 7000) && !r.a.stimato, r);
  check('chi non si legge: il resto in parti uguali, segnato «stimato»', vicino(r.c.costo, 1400) && vicino(r.d.costo, 1400) && r.c.stimato, r);
  const somma = Object.values(r).reduce((s, x) => s + x.costo, 0);
  check('la somma torna al costo del mese (14.000)', vicino(somma, 14000), somma);

  // 3. Conto del mese
  const conto = Q.contoMese({
    persone: [
      { id: 'a', costo: 3360, perCantiere: { s1: 60 * 80, mag: 60 * 20 } }, // 3360 € / 168 h = 20 €/h
      { id: 'b', costo: 1680, perCantiere: { s1: 60 * 10, s2: 60 * 40 } },  // 10 €/h, anche se ha timbrato solo 50 h
      { id: 't', costo: 5000, perCantiere: {} },                              // tecnico: niente cantieri
    ],
    cantieri: { s1: 'Via Balbi 31', s2: 'Via Spalato 65', mag: 'Magazzino MSCedilizia' },
    giorniLavorativi: 21, oreGiornoMin: 480, costoMese: 10040,
  });
  const s1 = conto.cantieri.find(c => c.siteId === 's1'), s2 = conto.cantieri.find(c => c.siteId === 's2');
  check('costo orario sulle ore di contratto: Via Balbi = 80 h × 20 + 10 h × 10 = 1.700 €', s1?.costo === 1700, s1);
  check('Via Spalato = 40 h × 10 = 400 € (non gonfiato dalle poche ore timbrate)', s2?.costo === 400, s2);
  check('il magazzino non è un cantiere', !conto.cantieri.some(c => /Magazzino/.test(c.nome)), conto.cantieri);
  check('spese generali = costo del mese − cantieri (tecnico, magazzino, ore non timbrate)', conto.speseGenerali === 10040 - 2100 && conto.aiCantieri === 2100, conto);

  // 4. Dal vivo
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  – skip controlli dal vivo: Supabase non configurato');
  } else {
    const CO = '309e9018-1bcc-4876-9430-99cb89e043dd';
    const ott = await Q.quantoRendeMese(CO, '2026-10');
    check('MSC ottobre 2026: conto pronto', ott.pronto === true, ott);
    if (ott.pronto) {
      check('costo del mese = prospetto (38.471,53 + 15.087,48)', ott.costoMese === Math.round(38471.53 + 15087.48), ott.costoMese);
      check('totale = cantieri + spese generali', ott.aiCantieri + ott.speseGenerali === ott.costoMese, ott);
      const fuori = ott.cantieri.filter(c => c.ore >= 50 && (c.costo / c.ore < 15 || c.costo / c.ore > 35));
      check('costo orario dei cantieri plausibile (15-35 €/h)', fuori.length === 0, fuori);
      check('nessun magazzino fra i cantieri', !ott.cantieri.some(c => Q.NON_CANTIERE.test(c.nome)), ott.cantieri.map(c => c.nome));
      check('almeno 14 buste su 17 lette', ott.affidabilita.busteLette >= 14, ott.affidabilita);
    }
    const nov = await Q.quantoRendeMese(CO, '2099-01');
    check('un mese senza prospetto non inventa numeri', nov.pronto === false && nov.manca === 'prospetto', nov);

    // 5. Via HTTP, con lo stesso JWT/header dell'app
    const base = process.env.SELFTEST_API_URL || 'https://palladia-backend-production.up.railway.app';
    const supabase = require('../lib/supabase');
    const { createClient } = require('@supabase/supabase-js');
    const sessione = async (email) => {
      const { data: link } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
      const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false } });
      const { data } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
      return data.session?.access_token;
    };
    const chiama = async (jwt) => fetch(`${base}/api/v1/quanto-rende?mese=2026-10`, { headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': CO } });
    const owner = await sessione('carpio@mscedilizia.it');
    const ro = await chiama(owner);
    if (ro.status === 404) {
      console.log(`  – skip HTTP: la rotta non è ancora pubblicata su ${base}`);
    } else {
      const jo = await ro.json();
      check('HTTP owner: 200 e conto pronto', ro.status === 200 && jo.pronto === true, { status: ro.status, jo });
      const { data: tech } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'tech').limit(1).maybeSingle();
      if (tech) {
        const { data: u } = await supabase.auth.admin.getUserById(tech.user_id);
        const rt = await chiama(await sessione(u.user.email));
        check('HTTP tech: 403 (sono paghe)', rt.status === 403, rt.status);
      }
    }
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
