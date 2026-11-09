#!/usr/bin/env node
/**
 * scripts/selftest_f482_titolari_badge_foto.js — F-482 / F-483 (AUDIT.md del frontend).
 *
 * F-482: «Claudio Miosi e Arianna Catalano sono i titolari. Non hanno bisogno di
 * visite mediche e attestati vari» → chi ha qualifica o ruolo «Titolare» /
 * «Datore di lavoro» non deve risultare incompleto né far partire avvisi.
 * F-483: il PDF del badge metteva il percorso privato della foto in <img src>
 * (immagine rotta). Ora la foto è dentro il PDF.
 * Contro il DB vero: azienda di prova creata e cancellata qui; la foto vera
 * di un lavoratore MSC si legge soltanto.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F482-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-482 — i titolari non hanno bisogno di visita medica e corso\x1b[0m');
  const C = require('../lib/compliance');
  check('regola unica: nonServonoDocumenti esiste in lib/compliance', typeof C.nonServonoDocumenti === 'function');
  const nsd = C.nonServonoDocumenti || (() => false);
  check('«Titolare» (qualifica) → non servono', nsd({ qualification: 'Titolare' }) === true);
  check('«Datore di lavoro» (qualifica) e «Titolare» (ruolo) → non servono', nsd({ qualification: 'Datore di lavoro', role: 'Titolare' }) === true);
  check('maiuscole e spazi non contano («  TITOLARE »)', nsd({ role: '  TITOLARE ' }) === true);
  check('«Operaio», «Capocantiere», «Socio lavoratore» → servono', !nsd({ qualification: 'Operaio' }) && !nsd({ role: 'Capocantiere' }) && !nsd({ qualification: 'Socio lavoratore' }));
  check('overallStatus: titolare senza date = in regola (non «incompleto»)', C.overallStatus({ is_active: true, qualification: 'Titolare' }) === 'compliant', C.overallStatus({ is_active: true, qualification: 'Titolare' }));
  check('overallStatus: operaio senza date = incompleto (come prima)', C.overallStatus({ is_active: true, qualification: 'Operaio' }) === 'incomplete');

  const company = await ins('companies', { name: T });
  try {
    const tit = await ins('workers', { company_id: company.id, full_name: `${T} Claudio`, is_active: true, qualification: 'Datore di lavoro', role: 'Titolare', fiscal_code: `F482AAAA${stamp}`, badge_code: `F482A${stamp}` });
    const op = await ins('workers', { company_id: company.id, full_name: `${T} Mario`, is_active: true, qualification: 'Operaio', fiscal_code: `F482BBBB${stamp}`, badge_code: `F482B${stamp}` });
    const { problemiLavoratori, statoLavoratori } = require('../lib/documentiStato');
    const p = await problemiLavoratori(company.id);
    check('avvisi (email, Da fare): il titolare non è tra i «mancanti», l\'operaio sì', !p.mancanti.some(m => m.workerId === tit.id) && p.mancanti.some(m => m.workerId === op.id), p.mancanti.map(m => m.name));
    const st = await statoLavoratori(company.id);
    const sTit = st.find(x => x.id === tit.id);
    check('Documenti: il titolare è in regola, visita e corso «non servono: titolare»', sTit?.state === 'in_regola' && sTit.requirements.every(r => r.state === 'in_regola' && /titolare/i.test(r.esente || '')), sTit);
  } finally {
    await supabase.from('companies').delete().eq('id', company.id);
  }

  console.log('\n\x1b[1mF-483 — la foto dentro il PDF del badge\x1b[0m');
  let fotoPerPdf = null;
  try { ({ fotoPerPdf } = require('../routes/v1/badge')); } catch { fotoPerPdf = null; }
  check('esiste fotoPerPdf (routes/v1/badge.js)', typeof fotoPerPdf === 'function');
  if (typeof fotoPerPdf === 'function') {
    const { data: w } = await supabase.from('workers').select('photo_url').eq('company_id', '309e9018-1bcc-4876-9430-99cb89e043dd').ilike('full_name', 'Petriccione%').maybeSingle();
    const src = await fotoPerPdf(w?.photo_url);
    check('foto vera di Petriccione (percorso privato) → immagine dentro il PDF (data:image/…)', typeof src === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(src) && src.length > 2000, String(src).slice(0, 80));
    check('un indirizzo web già pieno resta com\'è', (await fotoPerPdf('https://example.com/f.jpg')) === 'https://example.com/f.jpg');
    check('percorso che non esiste → nessuna foto (segnaposto), non immagine rotta', (await fotoPerPdf('non-esiste/xyz.jpg')) === null);
    check('nessuna foto → null', (await fotoPerPdf(null)) === null);
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
