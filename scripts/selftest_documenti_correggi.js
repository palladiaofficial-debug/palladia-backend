#!/usr/bin/env node
/**
 * scripts/selftest_documenti_correggi.js — F-329 (AUDIT.md del frontend).
 *
 * Nella pagina Documenti senza cartelle (F-316) un documento in regola non si
 * poteva più correggere né eliminare. Qui:
 *   - correggi la scadenza di un documento: cambia la riga della sua tabella,
 *     e il campo del proprietario se veniva da quel documento (anche all'indietro:
 *     è una correzione, non un rinnovo);
 *   - "non scade" (scadenza null);
 *   - ogni documento della scheda dice come eliminarlo;
 *   - un documento di un'altra azienda non si tocca.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { scheda } = require('../lib/documentiStato');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F329-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const unified = async (table, id) => (await supabase.from('documents').select('id').eq('source_table', table).eq('legacy_id', id).maybeSingle()).data?.id;

async function main() {
  console.log('\n\x1b[1mF-329 — Correggere o eliminare un documento\x1b[0m');
  let correggi;
  try { ({ correggi } = require('../lib/documentiCorreggi')); } catch { correggi = null; }
  check('esiste lib/documentiCorreggi.correggi', typeof correggi === 'function');
  if (!correggi) { console.log(`\n${passed} passati, ${failed} falliti`); process.exit(1); }

  const company = await ins('companies', { name: T, durc_expiry: '2099-01-01' });
  const other = await ins('companies', { name: `${T}-altra` });
  const cid = company.id;
  try {
    const w = await ins('workers', { company_id: cid, full_name: `${T} Giuseppe`, is_active: true, fiscal_code: `F329${String(Date.now()).slice(-10)}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), health_fitness_expiry: '2099-01-01', safety_training_expiry: '2030-01-01' });
    const wd = await ins('worker_documents', { company_id: cid, worker_id: w.id, name: 'Visita medica', doc_type: 'idoneita_medica', expiry_date: '2099-01-01', file_path: `${cid}/workers/${w.id}/x.pdf` });
    const cd = await ins('company_documents', { company_id: cid, name: 'DURC', category: 'durc', ai_expiry_date: '2099-01-01', file_path: `${cid}/_company/durc.pdf` });
    const altro = await ins('company_documents', { company_id: other.id, name: 'Altrui', category: 'altro', ai_expiry_date: '2099-01-01', file_path: `${other.id}/_company/a.pdf` });
    const wdId = await unified('worker_documents', wd.id);
    const cdId = await unified('company_documents', cd.id);
    const altroId = await unified('company_documents', altro.id);
    check('i documenti sono nell\'archivio unificato', !!wdId && !!cdId && !!altroId);

    const s0 = await scheda(cid, 'lavoratori', w.id);
    const vis0 = s0.requirements.find(r => r.key === 'idoneita');
    check('prima: visita medica in regola (data sbagliata 2099)', vis0?.state === 'in_regola' && vis0.doc?.id === wdId, vis0);
    check('ogni documento della scheda dice come eliminarlo', typeof vis0.doc?.elimina === 'string' && vis0.doc.elimina.includes(wd.id), vis0.doc);

    // Correzione all'indietro: era 2099 per errore, la data vera è passata
    const r1 = await correggi({ companyId: cid, docId: wdId, scadenza: '2026-01-15' });
    const wd1 = (await supabase.from('worker_documents').select('expiry_date').eq('id', wd.id).single()).data;
    const w1 = (await supabase.from('workers').select('health_fitness_expiry').eq('id', w.id).single()).data;
    check('corretta la riga del documento', String(wd1.expiry_date).slice(0, 10) === '2026-01-15', wd1);
    check('corretto anche il campo del lavoratore (anche all\'indietro)', String(w1.health_fitness_expiry).slice(0, 10) === '2026-01-15', { w1, r1 });
    const vis1 = (await scheda(cid, 'lavoratori', w.id)).requirements.find(r => r.key === 'idoneita');
    check('dopo: la visita medica risulta scaduta', vis1?.state === 'scaduto', vis1);

    // DURC dell'impresa: ai_expiry_date + companies.durc_expiry
    await correggi({ companyId: cid, docId: cdId, scadenza: '2027-05-05' });
    const cd1 = (await supabase.from('company_documents').select('ai_expiry_date').eq('id', cd.id).single()).data;
    const c1 = (await supabase.from('companies').select('durc_expiry').eq('id', cid).single()).data;
    check('DURC: corretta la riga e la scadenza dell\'impresa', String(cd1.ai_expiry_date).slice(0, 10) === '2027-05-05' && String(c1.durc_expiry).slice(0, 10) === '2027-05-05', { cd1, c1 });

    // Un requisito (DURC) non può "non scadere"
    const noDate = await correggi({ companyId: cid, docId: cdId, scadenza: null }).then(() => null, e => e.code);
    check('DURC senza data rifiutato', noDate === 'SCADENZA_RICHIESTA', noDate);

    // "Non scade" su un documento qualsiasi (visura)
    const visura = await ins('company_documents', { company_id: cid, name: 'Visura', category: 'altro', ai_expiry_date: '2026-03-01', file_path: `${cid}/_company/visura.pdf` });
    await correggi({ companyId: cid, docId: await unified('company_documents', visura.id), scadenza: null });
    const visura1 = (await supabase.from('company_documents').select('ai_expiry_date').eq('id', visura.id).single()).data;
    check('"non scade": scadenza tolta dal documento', visura1.ai_expiry_date === null, visura1);

    // Data non valida
    const bad = await correggi({ companyId: cid, docId: wdId, scadenza: '2026-13-40' }).then(() => null, e => e.code);
    check('data non valida rifiutata', bad === 'INVALID_DATE', bad);

    // Documento di un'altra azienda
    const fuori = await correggi({ companyId: cid, docId: altroId, scadenza: '2027-01-01' }).then(() => null, e => e.code);
    const altro1 = (await supabase.from('company_documents').select('ai_expiry_date').eq('id', altro.id).single()).data;
    check('documento di un\'altra azienda: non trovato e non toccato', fuori === 'NOT_FOUND' && String(altro1.ai_expiry_date).slice(0, 10) === '2099-01-01', { fuori, altro1 });
  } finally {
    await supabase.from('worker_documents').delete().eq('company_id', cid);
    await supabase.from('company_documents').delete().in('company_id', [cid, other.id]);
    await supabase.from('workers').delete().eq('company_id', cid);
    await supabase.from('companies').delete().in('id', [cid, other.id]);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
