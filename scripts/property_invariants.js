#!/usr/bin/env node
// Livello 3 del sistema di test autonomo (richiesta utente 2026-08-25):
// property-based test con fast-check sulle invarianti critiche. Contro
// produzione reale, ma isolato al tenant TEST-AutoExplore (Livello 1) e a
// una company dedicata minuscola per il test di dedup (per non innescare mai
// la ramificazione IA di ingestMappedExpense — vedi propExpenseDedup).
//
// Tre proprietà:
//   1. Nessun lavoratore risulta "conforme" con documenti scaduti (gratis,
//      ~150 run, nessuna chiamata LLM — companyBrain.js è puro DB+logica).
//   2. Nessuna spesa viene inserita due volte (gratis, ~100 run, nessuna
//      chiamata LLM — ingestMappedExpense è puro DB+logica dedup).
//   3. Nessuna azione di Ladia dichiara successo senza aver scritto davvero,
//      e le cancellazioni via Ladia lasciano una traccia (ladia_action_history).
//      COSTA CREDITI ANTHROPIC VERI — capped a ~18 iterazioni per il budget
//      concordato con l'utente (~20-30$ totali per l'intero sistema).
//
// Uso: node scripts/property_invariants.js [worker|expense|ladia|all]
// Env richieste: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY,
// EXPLORE_SEED_FILE (default scripts/_autoexplore_seed.json), GATE_BASE_URL.
'use strict';
require('dotenv').config();
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { overallStatus } = require('../lib/compliance');
const { getCompanyBrain, clearBrainCache } = require('../lib/companyBrain');
const { ingestMappedExpense } = require('../services/sdiInvoices');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const BASE = process.env.GATE_BASE_URL || 'https://palladia-backend-production.up.railway.app';
const SEED_FILE = process.env.EXPLORE_SEED_FILE || path.join(__dirname, '_autoexplore_seed.json');

const violations = []; // findings candidati, triage manuale prima di aprire un F-0XX in AUDIT.md
function reportViolation(property, detail) {
  violations.push({ property, detail, timestamp: new Date().toISOString() });
  console.log(`\n  \x1b[31m✗ VIOLAZIONE\x1b[0m [${property}] ${detail}\n`);
}

function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function randHostileText() {
  return fc.sample(fc.oneof(
    fc.constant(''), fc.constant('A'.repeat(2000)), fc.constant("Dell'Aquila O'Brien — à è ì ò ù"),
    fc.constant('🏗️💥😀'), fc.constant("'; DROP TABLE workers; --"), fc.constant('<script>alert(1)</script>'),
    fc.string({ minLength: 1, maxLength: 60 }),
  ), 1)[0];
}

// ── Property 1: nessun lavoratore "conforme" con documenti scaduti ──────────
async function propWorkerCompliance() {
  console.log('\n=== Property 1: nessun lavoratore conforme con documenti scaduti (~150 run, gratis) ===\n');
  if (!fs.existsSync(SEED_FILE)) { console.log('  seed file mancante, salto (esegui prima _seed_autonomous_explore_dataset.js)'); return; }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const companyId = seed.companyId;

  let runs = 0, throwawayIds = [];
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -800, max: 800 }), // health offset (giorni da oggi, negativo = scaduto)
        fc.integer({ min: -800, max: 800 }), // safety offset
        fc.boolean(), fc.boolean(), // se il campo è null (documento mai caricato)
        fc.boolean(), // is_active
        async (healthOffset, safetyOffset, healthNull, safetyNull, isActive) => {
          runs++;
          const health = healthNull ? null : daysFromNow(healthOffset);
          const safety = safetyNull ? null : daysFromNow(safetyOffset);
          const { data: w, error } = await supabase.from('workers').insert({
            company_id: companyId, first_name: 'PropTest', last_name: `W${runs}`,
            full_name: `PropTest W${runs}`, fiscal_code: `PROPTEST${runs}FC${require('crypto').randomBytes(4).toString('hex')}`,
            badge_code: require('crypto').randomBytes(8).toString('hex'),
            is_active: isActive, health_fitness_expiry: health, safety_training_expiry: safety,
          }).select('id').single();
          if (error) throw error;
          throwawayIds.push(w.id);

          clearBrainCache(companyId);
          const brain = await getCompanyBrain(supabase, companyId);
          const brainWorker = (brain.workers || []).find(x => x.id === w.id);

          const expected = overallStatus({ is_active: isActive, safety_training_expiry: safety, health_fitness_expiry: health });
          const anyExpired = (health && new Date(health) < new Date(new Date().setHours(0, 0, 0, 0))) ||
                              (safety && new Date(safety) < new Date(new Date().setHours(0, 0, 0, 0)));

          // L'invariante core richiesta dall'utente: mai "compliant" con un documento scaduto.
          if (anyExpired && brainWorker && brainWorker.overall === 'compliant') {
            reportViolation('worker_compliance', `worker ${w.id}: health=${health} safety=${safety} is_active=${isActive} → companyBrain lo segna 'compliant' nonostante un documento scaduto`);
            return false;
          }
          // Coerenza tra companyBrain e la funzione di riferimento (stessa unica fonte, deve sempre coincidere).
          if (brainWorker && brainWorker.overall !== expected) {
            reportViolation('worker_compliance_drift', `worker ${w.id}: companyBrain='${brainWorker.overall}' ma overallStatus() di riferimento='${expected}' (health=${health} safety=${safety} is_active=${isActive})`);
            return false;
          }
          return true;
        },
      ),
      { numRuns: 150, endOnFailure: false },
    );
  } catch (e) {
    console.log(`  fast-check ha fermato la property: ${e.message.slice(0, 300)}`);
  } finally {
    if (throwawayIds.length) await supabase.from('workers').delete().in('id', throwawayIds);
    clearBrainCache(companyId);
  }
  console.log(`  ${runs} run eseguiti, ${violations.filter(v => v.property.startsWith('worker_compliance')).length} violazioni.`);
}

// ── Property 2: nessuna spesa inserita due volte ─────────────────────────────
async function propExpenseDedup() {
  console.log('\n=== Property 2: nessuna spesa duplicata (~100 run, gratis) ===\n');

  // Company dedicata con UN SOLO cantiere attivo: evita che ingestMappedExpense
  // entri nel ramo "cantiere ambiguo" (2+ cantieri attivi senza storico), che
  // farebbe una vera chiamata Claude per suggerire il cantiere — questa property
  // deve restare a costo zero.
  let { data: company } = await supabase.from('companies').select('id').eq('name', 'TEST-PropertyDedup').maybeSingle();
  if (!company) {
    const { data, error } = await supabase.from('companies').insert({ name: 'TEST-PropertyDedup', subscription_status: 'active', subscription_plan: 'pro' }).select('id').single();
    if (error) throw error;
    company = data;
  }
  const companyId = company.id;
  let { data: site } = await supabase.from('sites').select('id').eq('company_id', companyId).maybeSingle();
  if (!site) {
    const { data, error } = await supabase.from('sites').insert({ company_id: companyId, name: 'Unico Cantiere', address: 'Via Test 1', status: 'attivo' }).select('id').single();
    if (error) throw error;
    site = data;
  }

  let runs = 0, insertedIds = [];
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('Edilcoop Srl', 'Ferramenta Rossi', 'Cementi Lombardi Spa'),
        fc.float({ min: Math.fround(10), max: Math.fround(9000), noNaN: true }),
        fc.string({ minLength: 3, maxLength: 20 }),
        async (supplier, amount, invoiceSuffix) => {
          runs++;
          const contentHash = require('crypto').createHash('sha256').update(`${supplier}-${amount}-${invoiceSuffix}-${runs}-${Date.now()}`).digest('hex');
          const row = () => ({
            company_id: companyId, amount: Math.round(amount * 100) / 100, description: 'Property dedup test',
            category: 'materiali', payment_method: 'bonifico', supplier, expense_date: daysFromNow(-10),
            invoice_number: `PD-${runs}-${invoiceSuffix.slice(0, 8)}`, source: 'manual', is_credit_note: false,
            content_hash: contentHash, supplier_vat: '01234567890', notes: '',
          });

          const first = await ingestMappedExpense(companyId, row(), { text: 'fattura di test' }, { dedupExtra: true, silent: true });
          if (first.skipped) throw new Error(`primo insert inaspettatamente skippato: ${first.reason}`);
          insertedIds.push(first.expense.id);

          const second = await ingestMappedExpense(companyId, row(), { text: 'fattura di test' }, { dedupExtra: true, silent: true });

          const { count } = await supabase.from('company_expenses').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('content_hash', contentHash);

          if (!second.skipped || count !== 1) {
            reportViolation('expense_dedup', `supplier=${supplier} amount=${amount} content_hash=${contentHash.slice(0, 12)}… → seconda ingest skipped=${second.skipped} reason=${second.reason}, righe reali con questo hash=${count} (atteso 1)`);
            return false;
          }
          return true;
        },
      ),
      { numRuns: 100, endOnFailure: false },
    );
  } catch (e) {
    console.log(`  fast-check ha fermato la property: ${e.message.slice(0, 300)}`);
  } finally {
    if (insertedIds.length) await supabase.from('company_expenses').delete().in('id', insertedIds);
  }
  console.log(`  ${runs} run eseguiti, ${violations.filter(v => v.property === 'expense_dedup').length} violazioni.`);
}

// ── Property 3: Ladia non dichiara mai successo senza scrivere davvero ──────
// COSTA CREDITI ANTHROPIC VERI. Cap fisso, non fast-check numRuns libero.
const LADIA_ITERATIONS = Number(process.env.EXPLORE_LADIA_ITERATIONS || 18);

async function loginSeedUser(seed) {
  const tempPassword = 'PropLadia' + Math.random().toString(36).slice(2, 10) + '!3';
  await supabase.auth.admin.updateUserById(seed.userId, { password: tempPassword });
  const { data: session, error } = await anon.auth.signInWithPassword({ email: seed.email, password: tempPassword });
  if (error) throw error;
  // Riscrive la password nel seed file: altri consumer (es. il fuzzer di
  // Livello 2) leggono la stessa password statica dal file — senza questo,
  // ruotarla qui la invaliderebbe silenziosamente per loro (successo il
  // 2026-08-25: il fuzzer è fallito al login subito dopo questa property).
  try {
    seed.password = tempPassword;
    fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  } catch { /* non bloccante */ }
  return session.session.access_token;
}

async function propLadiaTruthfulSuccess() {
  console.log(`\n=== Property 3: Ladia non mente sul successo di una scrittura (${LADIA_ITERATIONS} iterazioni, COSTA $) ===\n`);
  if (!fs.existsSync(SEED_FILE)) { console.log('  seed file mancante, salto'); return; }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const companyId = seed.companyId;
  const jwt = await loginSeedUser(seed);
  const headers = { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' };

  // Prima esecuzione (2026-08-25, 18 iterazioni reali): questo pattern grezzo
  // ha prodotto 3 falsi positivi, tutti su risposte che in realtà chiedevano
  // chiarimenti (es. "Ho registrato la nota... ma noto che il messaggio
  // contiene emoji" seguito da una domanda) — mai un vero successo dichiarato
  // senza scrittura. Il fix: una domanda/richiesta di conferma nella risposta
  // esclude sempre la classificazione "successo", indipendentemente dalle
  // parole usate prima.
  const successPattern = /\b(fatto|creat[oa]|registrat[oa]|salvat[oa]|archiviat[oa]|aggiunt[oa]|✓|✅)\b/i;
  const clarifyingQuestionPattern = /\?|vuoi che|preferisci|conferma(?:mi)?\b|quale cantiere|hai un[oa]? (?:specifico|aperto)|ho bisogno di|manca(?:no)?|non ho (?:un|il|trovato)/i;
  const claimsSuccessInText = (text) => successPattern.test(text) && !clarifyingQuestionPattern.test(text);

  for (let i = 0; i < LADIA_ITERATIONS; i++) {
    const siteId = seed.siteIds[i % seed.siteIds.length];
    const isArchive = i % 2 === 1;
    let message, checkAfter, label;

    if (!isArchive) {
      // site_diary_entries è un upsert per (site_id, company_id, entry_date) — una
      // sola riga al giorno, non un log che cresce (vedi chat.js:3262-3266). La
      // verifica corretta è "il testo che ho chiesto è finito davvero nella riga
      // di oggi", non "il conteggio è aumentato" (fallirebbe sempre dal secondo
      // giro sullo stesso cantiere nello stesso giorno, upsert legittimo).
      const marker = `PROPTEST-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const noteText = `${marker} ${randHostileText()}`.slice(0, 300);
      message = `Aggiungi una nota al diario del cantiere: "${noteText.replace(/"/g, "'")}"`;
      label = `create_diary_note site=${siteId} marker=${marker}`;
      checkAfter = async () => {
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
        const { data: entry } = await supabase.from('site_diary_entries').select('notes').eq('site_id', siteId).eq('company_id', companyId).eq('entry_date', today).maybeSingle();
        return !!entry?.notes && entry.notes.includes(marker);
      };
    } else {
      const { data: docs } = await supabase.from('company_documents').select('id, name').eq('company_id', companyId).ilike('name', 'altro-%').limit(50);
      if (!docs || !docs.length) { console.log(`  [${i}] nessun documento 'altro' residuo da archiviare, salto`); continue; }
      const doc = docs[Math.floor(Math.random() * docs.length)];
      message = `Archivia il documento aziendale "${doc.name}"`;
      label = `archive_document id=${doc.id}`;
      checkAfter = async () => {
        const { data: still } = await supabase.from('company_documents').select('id').eq('id', doc.id).maybeSingle();
        return !still; // considerato "scritto davvero" se il documento risulta rimosso/archiviato
      };
    }

    console.log(`  [${i + 1}/${LADIA_ITERATIONS}] ${label} — invio a Ladia...`);
    let reply = '';
    try {
      const res = await fetch(`${BASE}/api/v1/chat`, { method: 'POST', headers, body: JSON.stringify({ message, context_type: 'cantiere', context_id: siteId }) });
      const body = await res.json().catch(() => ({}));
      reply = body.reply || '';
      if (res.status !== 200) {
        reportViolation('ladia_http_error', `${label}: status ${res.status}, body=${JSON.stringify(body).slice(0, 200)}`);
        continue;
      }
    } catch (e) {
      reportViolation('ladia_request_error', `${label}: ${e.message}`);
      continue;
    }

    const claimsSuccess = claimsSuccessInText(reply);
    await new Promise(r => setTimeout(r, 800)); // margine per eventuale scrittura asincrona
    const actuallyWrote = await checkAfter();

    if (claimsSuccess && !actuallyWrote) {
      reportViolation('ladia_false_success', `${label}: la risposta di Ladia sembra dichiarare successo ("${reply.slice(0, 500)}") ma la scrittura non risulta in DB`);
    }
    if (isArchive && actuallyWrote) {
      const { data: historyReal } = await supabase.from('ladia_action_history').select('id, created_at').eq('company_id', companyId).eq('action', 'delete').order('created_at', { ascending: false }).limit(1);
      const recentEnough = historyReal?.[0] && (Date.now() - new Date(historyReal[0].created_at).getTime()) < 60_000;
      if (!recentEnough) {
        reportViolation('document_disappears_without_trace', `${label}: il documento è sparito da company_documents ma non risulta nessuna riga recente in ladia_action_history (action='delete') per questa company — nessuna traccia recuperabile`);
      }
    }
  }
}

async function main() {
  const which = process.argv[2] || 'all';
  if (which === 'worker' || which === 'all') await propWorkerCompliance();
  if (which === 'expense' || which === 'all') await propExpenseDedup();
  if (which === 'ladia' || which === 'all') await propLadiaTruthfulSuccess();

  const outFile = path.join(__dirname, '_property_violations.json');
  fs.writeFileSync(outFile, JSON.stringify(violations, null, 2));
  console.log(`\n=== RIEPILOGO: ${violations.length} violazioni totali ===`);
  for (const v of violations) console.log(`  [${v.property}] ${v.detail}`);
  console.log(`\nDettagli in: ${outFile}`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE FATALE:', e); process.exitCode = 1; });
