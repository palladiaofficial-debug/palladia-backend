#!/usr/bin/env node
/**
 * scripts/selftest_f502_dichiarazione_art14.js
 *
 * Regressione per F-502 (AUDIT.md del frontend, 15/11/2026): la dichiarazione di non essere
 * sospesa (All. XVII D.Lgs. 81/2008, punto 1, lettera d), solo per le imprese).
 * Prima:
 *  - il modulo già compilato citava «punto 1, lettera e)»;
 *  - diceva solo «legale rappresentante» (in una ditta individuale firma il titolare);
 *  - senza impresa principale usciva «per conto di ,»;
 *  - il titolare leggeva «Dichiarazione che non è sospesa» e non poteva scaricare il modulo.
 *
 * 1. Puro: il testo del PDF.  2. Dal vivo (produzione): GET /imprese/:id/dichiarazione.pdf
 *    col JWT del titolare dà il modulo con i dati dell'impresa; un'altra azienda non lo apre;
 *    la scheda chiama la riga col nome nuovo.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY o SUPABASE_KEY.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const zlib = require('zlib');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '') + '/api/v1';
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
function fine() { console.log(`\n${passed} passed, ${failed} failed\n`); process.exit(failed ? 1 : 0); }

/** Il testo di un PDF di pdf-lib (stream compressi, testo in esadecimale WinAnsi). */
function testoPdf(buf) {
  const s = buf.toString('latin1');
  let out = '';
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let c;
    try { c = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { c = m[1]; }
    for (const t of c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out += Buffer.from(t[1], 'hex').toString('latin1') + '\n';
  }
  return out;
}

async function main() {
  console.log('\nPalladia regression — F-502: dichiarazione art. 14 (All. XVII punto 1 lettera d)\n');
  const { dichiarazionePdf } = require('../lib/impreseDichiarazione');
  const { requirementsFor } = require('../lib/documentiStato');

  let t = testoPdf(await dichiarazionePdf({ impresa: { nome: 'Edil Rossi di Rossi Mario', piva: '01234567890', indirizzo: 'Via Roma 1, Genova', referente: 'Mario Rossi' }, azienda: 'MSC Edilizia S.r.l.', cantieri: [{ nome: 'Via Balbi', indirizzo: 'Genova' }] }));
  check('il testo del PDF si legge (il test vede davvero il modulo)', /DICHIARA/.test(t) && /Edil Rossi di Rossi Mario/.test(t), t.slice(0, 300));
  check('cita l\'allegato XVII, punto 1, lettera d)', /punto 1, lettera d\)/.test(t), t.match(/allegato XVII[^\n]*/)?.[0]);
  check('non cita più la lettera e)', !/lettera e\)/.test(t));
  check('chi firma: titolare o legale rappresentante (ditta individuale compresa)', /titolare o legale rappresentante/.test(t), t.match(/qualit[^\n]*/)?.[0]);
  check('dice l\'art. 14 del D.Lgs. 81/2008', /sospensione o interdittivi di cui all'art\. 14 del D\.Lgs\. 81\/2008/.test(t.replace(/\n/g, ' ')));
  check('per conto di MSC nei cantieri', /per conto di MSC Edilizia S\.r\.l\. nei cantieri: Via Balbi - Genova/.test(t.replace(/\n/g, ' ')));
  t = testoPdf(await dichiarazionePdf({ impresa: { nome: 'Edil Rossi' }, azienda: '', cantieri: [] }));
  check('senza impresa principale: niente «per conto di ,», resta lo spazio da scrivere', !/per conto di ,/.test(t) && /per conto di _{6,}/.test(t), t.match(/per conto[^\n]*/)?.[0]);
  check('il piè di pagina va bene anche se il modulo lo stampa il titolare', !/dal link che hai ricevuto/.test(t), t.slice(-200));

  const label = (row) => requirementsFor('subappaltatori', row).find(r => r.key === 'dichiarazione')?.label;
  check('nome chiaro della riga: «Dichiarazione: non è sospesa dall\'Ispettorato»', label({ tipo_impresa: 'con_operai' }) === 'Dichiarazione: non è sospesa dall\'Ispettorato', label({ tipo_impresa: 'con_operai' }));
  check('non si chiede a chi lavora da solo né all\'impresa familiare (All. XVII punto 2)', !label({ tipo_impresa: 'da_solo' }) && !label({ tipo_impresa: 'familiare' }));

  const URL_ = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!URL_ || !SERVICE || !ANON) { console.log('  – skip parte dal vivo: env mancante'); return fine(); }
  const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: co } = await admin.from('companies').insert([{ name: 'TEST-F502 Impresa Principale' }]).select('id').single();
  const { data: co2 } = await admin.from('companies').insert([{ name: 'TEST-F502 Altra' }]).select('id').single();
  const CO = co.id; let userId = null;
  try {
    await admin.from('company_feature_flags').upsert({ company_id: CO, feature: 'subappaltatori', enabled: true }, { onConflict: 'company_id,feature' });
    const email = `test-f502-${crypto.randomUUID()}@example.com`;
    const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
    userId = u.user.id;
    await admin.from('company_users').insert([{ company_id: CO, user_id: userId, role: 'owner' }]);
    const { data: link0 } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const { data: ses } = await anon.auth.verifyOtp({ token_hash: link0.properties.hashed_token, type: 'magiclink' });
    const H = { Authorization: `Bearer ${ses.session.access_token}`, 'X-Company-Id': CO };

    const { data: sub } = await admin.from('subcontractors').insert({ company_id: CO, company_name: 'TEST-F502 Edil Bianchi srl', piva: '09876543210', legal_address: 'Via Po 3, Torino', contact_person: 'Luca Bianchi', is_active: true, tipo_impresa: 'con_operai' }).select('id').single();
    const { data: sub2 } = await admin.from('subcontractors').insert({ company_id: co2.id, company_name: 'TEST-F502 Di un altro', is_active: true }).select('id').single();

    let res = await fetch(`${BASE}/imprese/${sub.id}/dichiarazione.pdf`, { headers: H });
    const buf = Buffer.from(await res.arrayBuffer());
    t = testoPdf(buf).replace(/\n/g, ' ');
    check('dal vivo: il titolare scarica il modulo già compilato (PDF)', res.status === 200 && /application\/pdf/.test(res.headers.get('content-type') || '') && buf.slice(0, 5).toString() === '%PDF-', { status: res.status, ct: res.headers.get('content-type') });
    check('dal vivo: nel modulo impresa, P.IVA, sede, chi firma e impresa principale', /TEST-F502 Edil Bianchi srl/.test(t) && /09876543210/.test(t) && /Via Po 3, Torino/.test(t) && /Luca Bianchi/.test(t) && /per conto di TEST-F502 Impresa Principale/.test(t) && /lettera d\)/.test(t), t.slice(0, 600));
    res = await fetch(`${BASE}/imprese/${sub2.id}/dichiarazione.pdf`, { headers: H });
    check('dal vivo: l\'impresa di un\'altra azienda non si apre (404)', res.status === 404, res.status);
    res = await fetch(`${BASE}/imprese/${sub.id}/dichiarazione.pdf`);
    check('dal vivo: senza accesso niente modulo (401)', res.status === 401, res.status);
    res = await fetch(`${BASE}/imprese/${sub.id}/scheda`, { headers: H });
    const s = await res.json();
    check('dal vivo: nella scheda la riga ha il nome nuovo', s.requisiti?.find(x => x.key === 'dichiarazione')?.label === 'Dichiarazione: non è sospesa dall\'Ispettorato', s.requisiti?.map(x => x.label));
  } finally {
    await admin.from('subcontractors').delete().in('company_id', [CO, co2.id]);
    await admin.from('company_feature_flags').delete().eq('company_id', CO);
    await admin.from('company_users').delete().eq('company_id', CO);
    await admin.from('companies').delete().in('id', [CO, co2.id]);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
  fine();
}
main().catch(e => { console.error(e); process.exit(1); });
