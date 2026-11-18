#!/usr/bin/env node
/**
 * scripts/selftest_f511_oggi_soldi.js — F-510/F-511 (AUDIT.md del frontend, 18/11/2026).
 * Su Oggi, solo per titolare e amministratori:
 *   - «Cassa Edile: a X mancano N € di manodopera» quando la fine lavori è entro
 *     30 giorni o passata da meno di 60, e la manodopera non basta (F-511);
 *   - «N fatture senza cantiere» con «Dimmelo» (F-510).
 * Mai al tecnico. Mai per un cantiere sotto i 70.000 €, già congruo o lontano dalla fine.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { componi, costruisci } = require('../lib/oggi');
const { daAvvisare } = require('../lib/oggiSoldi');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}

async function main() {
  console.log('\nPalladia regression — F-511: la Cassa Edile e le fatture senza cantiere su Oggi\n');
  const oggi = '2026-11-18';
  const c = (fine, perc, obbl = true) => ({ fine, congruita: { obbligatoria: obbl, percentuale: perc } });
  check('fine fra 22 giorni, al 64% → avvisa', daAvvisare([c('2026-12-10', 64)], oggi).length === 1);
  check('fine fra 6 mesi → non ancora', daAvvisare([c('2027-06-01', 10)], oggi).length === 0);
  check('sotto i 70.000 € → mai', daAvvisare([c('2026-12-10', 10, false)], oggi).length === 0);
  check('già congruo → mai', daAvvisare([c('2026-12-10', 100)], oggi).length === 0);
  check('finito da 30 giorni, non congruo → avvisa (saldo ancora da fare)', daAvvisare([c('2026-10-19', 50)], oggi).length === 1);
  check('finito da 90 giorni → non più', daAvvisare([c('2026-08-20', 50)], oggi).length === 0);

  const r = componi({ items: [], oggi, soldiDaFare: { fattureSenzaCantiere: 5, congruita: [{ siteId: 's1', nome: 'Via Balbi 31', fine: '2026-12-10', mancano: 8005 }] } });
  const cg = r.righe.find(x => x.id === 'congruita-s1');
  check('riga Cassa Edile con importo in euro senza decimali', cg && cg.titolo === 'Cassa Edile: a Via Balbi 31 mancano 8.005 € di manodopera', cg);
  check('riga Cassa Edile porta alla scheda Soldi del cantiere', cg && cg.link === '/cantieri/s1/soldi' && /10 dicembre/.test(cg.sotto), cg);
  const ft = r.righe.find(x => x.id === 'fatture-cantiere');
  check('riga «5 fatture senza cantiere» con «Dimmelo»', ft && ft.titolo === '5 fatture senza cantiere' && ft.tasto === 'Dimmelo' && ft.link === '/soldi?vista=cantieri&fatture=1', ft);
  check('senza dati sui soldi nessuna riga nuova', componi({ items: [], oggi }).righe.every(x => !/congruita|fatture-cantiere/.test(x.id)));

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = require('../lib/supabase');
    const CO = '309e9018-1bcc-4876-9430-99cb89e043dd';
    const { count } = await supabase.from('company_expenses').select('id', { count: 'exact', head: true })
      .eq('company_id', CO).is('site_id', null).is('cantiere_scelto_at', null);
    const { data: own } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'owner').limit(1).maybeSingle();
    const titolare = await costruisci(CO, own?.user_id, 'owner');
    const riga = titolare.righe.find(x => x.id === 'fatture-cantiere');
    const pag = titolare.righe.find(x => x.id === 'pagamenti');
    // F-357 (decisione del titolare, ottobre): su Oggi al massimo UNA riga sulle fatture
    check(`MSC titolare: mai due righe sulle fatture su Oggi (da pagare: ${!!pag}, senza cantiere: ${count})`, !(pag && riga), titolare.righe.map(x => x.id));
    check('MSC titolare: «fatture senza cantiere» c\'è quando non c\'è già la riga da pagare', pag || !count ? true : !!riga, { count, riga });
    const { data: tech } = await supabase.from('company_users').select('user_id').eq('company_id', CO).eq('role', 'tech').limit(1).maybeSingle();
    if (tech) {
      const t = await costruisci(CO, tech.user_id, 'tech');
      check('MSC tecnico: né Cassa Edile né fatture senza cantiere', t.righe.every(x => !/congruita|fatture-cantiere/.test(x.id)), t.righe.map(x => x.id));
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
