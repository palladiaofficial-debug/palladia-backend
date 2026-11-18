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
  // F-512: le 2 buste di MSC che non si leggevano (ottobre 2026)
  check('busta con «IMP.LE F.P.L.D» senza punto finale (Daniel Miosi)', Q.leggiImponibile('Ore mal./inf.: IMP.LE F.P.L.D 2051,00 IMP.LE IMP.LE TOTALE COMPETENZE') === 2051);
  check('busta di amministratore in gestione separata «IMP.LE F.A.P.» (Catalano)', Q.leggiImponibile('PERIODO COMP. 01/10/26 31/10/26 IMP.LE F.A.P. 3990,00 IMP.LE IMP.LE TOTALE') === 3990);

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

  // 3b. Congruità (DM 143/2021, tabella verificata sul decreto il 18/11/2026)
  check('17 categorie, come la tabella del decreto', Object.keys(Q.CATEGORIE).length === 17);
  check('ristrutturazione civile 22%, nuova civile 14,28%, restauro tutelati 30%',
    Q.CATEGORIE.ristrutturazione_civile.perc === 22 && Q.CATEGORIE.nuova_civile.perc === 14.28 && Q.CATEGORIE.restauro_tutelati.perc === 30);
  const cg = Q.congruita({ valore: 100000, categoria: 'ristrutturazione_civile', manodopera: 13995 });
  check('esempio del disegno: servono 22.000 €, fatti 13.995 €, 64%, mancano 8.005 €',
    cg && cg.serve === 22000 && cg.fatta === 13995 && cg.percentuale === 64 && cg.mancano === 8005 && cg.obbligatoria, cg);
  check('sotto 70.000 € la congruità non è obbligatoria', Q.congruita({ valore: 69999, categoria: 'nuova_civile', manodopera: 0 }).obbligatoria === false);
  check('a 70.000 € esatti sì (pari o superiore)', Q.congruita({ valore: 70000, categoria: 'nuova_civile', manodopera: 0 }).obbligatoria === true);
  check('senza valore o senza tipo di lavoro nessun numero inventato',
    Q.congruita({ valore: null, categoria: 'nuova_civile', manodopera: 1 }) === null && Q.congruita({ valore: 1000, categoria: null, manodopera: 1 }) === null);

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
      check('tutte le buste di ottobre lette (17 su 17, F-512)', ott.affidabilita.busteLette === ott.affidabilita.buste && ott.affidabilita.buste >= 17, ott.affidabilita);
    }
    const nov = await Q.quantoRendeMese(CO, '2099-01');
    check('un mese senza prospetto non inventa numeri', nov.pronto === false && nov.manca === 'prospetto', nov);

    // Il cantiere: Via Balbi 31 = somma dei suoi mesi; la memoria risponde in fretta
    const { data: balbi } = await require('../lib/supabase').from('sites').select('id').eq('company_id', CO).eq('name', 'Via Balbi 31').maybeSingle();
    if (balbi) {
      await Q.soldiCantiere(CO, balbi.id);
      const t0 = Date.now();
      const sc = await Q.soldiCantiere(CO, balbi.id);
      const ms = Date.now() - t0;
      check('Via Balbi: operai = somma dei mesi', sc.speso.operai === sc.mesi.reduce((s, m) => s + m.costo, 0) && sc.mesi.length >= 2, sc);
      check('Via Balbi: ottobre uguale al conto del mese', sc.mesi.find(m => m.mese === '2026-10')?.costo === ott.cantieri?.find(c => c.siteId === balbi.id)?.costo, sc.mesi);
      check(`dalla memoria in meno di 3 secondi (${ms} ms)`, ms < 3000, ms);
    }

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
    const jo0 = ro.status === 404 ? await ro.clone().json().catch(() => ({})) : {};
    if (ro.status === 404 && jo0.error === 'FEATURE_DISABLED') {
      // F-514: a MSC il costo della manodopera è nascosto finché il commercialista non conferma il conto
      // (selftest_f514). Il tecnico deve restare fuori comunque.
      console.log('  – HTTP owner: nascosto per F-514 (flag quanto_rende spento), salto i controlli del titolare');
      const { data: tech } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'tech').limit(1).maybeSingle();
      if (tech) {
        const { data: u } = await supabase.auth.admin.getUserById(tech.user_id);
        const rt = await chiama(await sessione(u.user.email));
        check('HTTP tech: 403 (sono paghe)', rt.status === 403, rt.status);
      }
    } else if (ro.status === 404) {
      console.log(`  – skip HTTP: la rotta non è ancora pubblicata su ${base}`);
    } else {
      const jo = await ro.json();
      check('HTTP owner: 200 e conto pronto', ro.status === 200 && jo.pronto === true, { status: ro.status, jo });
      const { data: tech } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'tech').limit(1).maybeSingle();
      if (tech) {
        const { data: u } = await supabase.auth.admin.getUserById(tech.user_id);
        const rt = await chiama(await sessione(u.user.email));
        check('HTTP tech: 403 (sono paghe)', rt.status === 403, rt.status);
        const rtp = await fetch(`${base}/api/v1/quanto-rende/cantiere/${balbi?.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${await sessione(u.user.email)}`, 'X-Company-Id': CO, 'Content-Type': 'application/json' }, body: JSON.stringify({ valore: 1 }) });
        check('HTTP tech non può scrivere il valore del lavoro: 403', rtp.status === 403, rtp.status);
      }
      if (balbi) {
        const h = { Authorization: `Bearer ${owner}`, 'X-Company-Id': CO, 'Content-Type': 'application/json' };
        const rc = await fetch(`${base}/api/v1/quanto-rende/cantiere/${balbi.id}`, { headers: h });
        const jc = await rc.json();
        check('HTTP cantiere: 200 con speso, mesi e le 17 categorie', rc.status === 200 && jc.speso && Array.isArray(jc.mesi) && jc.categorie?.length === 17, { status: rc.status, jc });
        const bad = await fetch(`${base}/api/v1/quanto-rende/cantiere/${balbi.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ categoria: 'inventata' }) });
        check('HTTP: un tipo di lavoro inventato → 400', bad.status === 400, bad.status);
        const neg = await fetch(`${base}/api/v1/quanto-rende/cantiere/${balbi.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ valore: -5 }) });
        check('HTTP: un valore negativo → 400', neg.status === 400, neg.status);
        // Riscrive i valori che c'erano già: prova il salvataggio senza cambiare i dati veri
        const same = await fetch(`${base}/api/v1/quanto-rende/cantiere/${balbi.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ valore: jc.valore, categoria: jc.categoria }) });
        const js = await same.json();
        check('HTTP: il salvataggio risponde col conto aggiornato, dati invariati', same.status === 200 && js.valore === jc.valore && js.categoria === jc.categoria, { status: same.status, js });
      }
    }
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
