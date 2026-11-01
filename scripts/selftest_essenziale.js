#!/usr/bin/env node
/**
 * scripts/selftest_essenziale.js — F-418 (AUDIT.md del frontend).
 *
 * «Palladia essenziale» su un'azienda di prova vera (DB):
 *  - impresa nuova (nessuna riga): essenziale acceso, lavagna/da_pagare/conti_sub
 *    spenti, sia per il server (isFeatureEnabled) sia per la pagina (flagsPer);
 *  - una riga esplicita «lavagna = sì» la riaccende solo lei;
 *  - essenziale spento (come MSC): tutto torna come prima;
 *  - POS/PSC e subappaltatori non cambiano;
 *  - Oggi: «N documenti scaduti» porta a Da rinnovare.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const { isFeatureEnabled, flagsPer, FEATURES } = require('../lib/featureFlags');
const { componi } = require('../lib/oggi');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

(async () => {
  console.log('\n\x1b[1mF-418 — Palladia essenziale\x1b[0m');
  const { data: co, error } = await supabase.from('companies').insert({ name: `TEST-F418-${Date.now()}` }).select().single();
  if (error) throw new Error(error.message);
  const riga = (feature, enabled) => supabase.from('company_feature_flags').upsert({ company_id: co.id, feature, enabled }, { onConflict: 'company_id,feature' });
  try {
    let f = await flagsPer(co.id);
    check('impresa nuova: essenziale acceso', f.essenziale === true && await isFeatureEnabled(co.id, 'essenziale'), f.essenziale);
    check('impresa nuova: lavagna, da pagare, conti dei sub spenti (pagina e server)',
      !f.lavagna && !f.da_pagare && !f.conti_sub && !(await isFeatureEnabled(co.id, 'lavagna')) && !(await isFeatureEnabled(co.id, 'da_pagare')) && !(await isFeatureEnabled(co.id, 'conti_sub')), { lavagna: f.lavagna, da_pagare: f.da_pagare, conti_sub: f.conti_sub });
    check('impresa nuova: imprese, documenti, Oggi e menu restano come il default', f.subappaltatori === FEATURES.subappaltatori && f.documenti_semplici === FEATURES.documenti_semplici && f.home_semplice === FEATURES.home_semplice && f.menu_semplice === FEATURES.menu_semplice && f.psc_coordinatori === FEATURES.psc_coordinatori, f);
    await riga('lavagna', true);
    f = await flagsPer(co.id);
    check('una riga «lavagna = sì» la riaccende solo lei', f.lavagna === true && await isFeatureEnabled(co.id, 'lavagna') && !f.da_pagare, f);
    await riga('essenziale', false);
    f = await flagsPer(co.id);
    check('essenziale spento (come MSC): da pagare e conti dei sub tornano come prima', f.da_pagare === FEATURES.da_pagare && f.conti_sub === FEATURES.conti_sub && (await isFeatureEnabled(co.id, 'da_pagare')) === FEATURES.da_pagare, f);
  } finally {
    await supabase.from('company_feature_flags').delete().eq('company_id', co.id);
    await supabase.from('companies').delete().eq('id', co.id);
  }
  const da = [{ id: 'a', kind: 'scadenza', bucket: 'scaduto', type: 'idoneita', title: 'Visita medica — Rossi', subtitle: 'scaduta' }, { id: 'b', kind: 'scadenza', bucket: 'scaduto', type: 'durc', title: 'DURC — Edil', subtitle: 'scaduto' }];
  const h = componi({ items: da, oggi: '2026-11-01' });
  const r = [h.prima, ...h.poi].find(x => x?.id === 'documenti-scaduti');
  check('Oggi: «2 documenti scaduti» porta a Da rinnovare', r?.link === '/da-rinnovare', r);
  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
