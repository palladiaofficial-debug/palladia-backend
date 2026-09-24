#!/usr/bin/env node
/**
 * scripts/selftest_inventario_f229.js — AUDIT.md F-229 (2026-09-24)
 *
 * Inventario Palladia: il titolare ha deciso voce per voce cosa tenere, unire,
 * congelare o eliminare. Questo test fallisce se un modulo ELIMINATO torna
 * raggiungibile o se un modulo CONGELATO si riaccende per sbaglio (env var,
 * FROZEN_FEATURES svuotato, tool rimesso nello schema di Ladia, cron riavviato).
 *
 * Nessun server richiesto: controlla il codice vero (featureFlags, schema tool
 * di Ladia caricato da routes/v1/chat.js, guardia sulle tabelle dei tool
 * generici) più un controllo strutturale su rotte montate e cron avviati —
 * una GET verso una rotta rimossa non dà un 404 affidabile perché alcuni
 * router montano verifySupabaseJwt globale e rispondono 400/401 a qualunque
 * path sconosciuto.
 */
'use strict';
require('dotenv').config({ quiet: true });
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(cond, name, got) { if (cond) ok(name); else fail(name, got); }

const FROZEN = [
  'economia', 'subappaltatori', 'studio_cdl', 'consulente', 'formazione_marketplace',
  'worker_self_onboarding', 'share_target', 'site_checklist', 'ladia_memory',
  'ladia_chat_folders', 'ladia_proactive', 'subappalto_contract', 'pos_signatures',
  'ladia_safety_tools', 'note_reminders', 'daily_digests', 'demo_page',
];
const RETIRED_FLAGS = [
  'document_archive_site', 'document_archive_formazione', 'document_archive_worker_docs',
  'document_archive_payslips', 'document_archive_studio_shared', 'document_archive_studio_requests',
  'document_hub_entry_worker', 'document_hub_entry_formazione', 'document_hub_entry_site',
  'document_hub_entry_subcontractor', 'document_hub_entry_payslips', 'document_hub_entry_equipment',
  'worker_page_v1', 'subcontractor_page_v1', 'equipment_page_v1',
];
const REAL_COMPANY_ID = '309e9018-1bcc-4876-9430-99cb89e043dd'; // MSCedilizia S.r.l., l'unica azienda reale

(async () => {
  console.log('\n=== selftest_inventario_f229 ===\n');
  const ff = require('../lib/featureFlags');

  // ── 1. Flag congelati: spenti di default, anche per la master company ──────
  for (const f of FROZEN) {
    check(f in ff.FEATURES, `flag congelato "${f}" esiste`);
    check(ff.FEATURES[f] === false, `"${f}" spento di default in questo ambiente`, ff.FEATURES[f]);
    check(ff.FROZEN_FEATURES.has(f), `"${f}" in FROZEN_FEATURES (la master company non lo accende)`);
  }
  const master = [...ff.MASTER_IDS][0];
  if (master) {
    for (const f of ['economia', 'studio_cdl', 'ladia_memory']) {
      check((await ff.isFeatureEnabled(master, f)) === false, `"${f}" spento ANCHE per la master company`);
    }
  }
  for (const f of RETIRED_FLAGS) check(!(f in ff.FEATURES), `flag di rollout ritirato "${f}" non esiste più`);

  // ── 2. Ladia web: schema tool filtrato + nota nel prompt ───────────────────
  const { blockedToolNames, isResourceFrozen, isPathFrozen } = require('../lib/ladiaFrozenTools');
  const chat = require('../routes/v1/chat.js');
  const names = chat.TOOLS_CACHED.map(t => t.name);
  const leaked = [...blockedToolNames()].filter(n => names.includes(n));
  check(leaked.length === 0, 'nessun tool di un modulo eliminato/congelato nello schema di Ladia', leaked);
  for (const t of ['get_risk_score', 'resolve_nonconformity', 'get_site_phases', 'create_expense_from_image', 'draft_subappalto_contract', 'get_pos_draft']) {
    check(!names.includes(t), `tool "${t}" assente dallo schema`);
  }
  for (const t of ['archive_document', 'get_payslips', 'update_worker', 'undo_action', 'get_presence_today', 'create_diary_note', 'get_weather_forecast']) {
    check(names.includes(t), `tool del nucleo "${t}" ancora presente`);
  }
  check(!!chat.TOOLS_CACHED.at(-1).cache_control, 'cache_control ancora sull\'ultimo tool (prompt cache intatta)');
  check(chat.SYSTEM_PROMPT.includes('FUNZIONI NON ATTIVE'), 'nota "funzioni non attive" nel prompt statico');
  check(chat.SYSTEM_PROMPT.includes('archive_document') && /FATTURA, SCONTRINO/.test(chat.SYSTEM_PROMPT),
    'il prompt dice di archiviare fatture/scontrini come documento, non come costo');

  // ── 3. Ladia via Telegram: niente tool non conformità ──────────────────────
  const tgSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'telegramLadia.js'), 'utf8');
  check(/tools:\s*ACTIVE_TOOL_DEFINITIONS/.test(tgSrc), 'Telegram passa lo schema filtrato, non LADIA_TOOL_DEFINITIONS grezzo');
  const { LADIA_TOOL_DEFINITIONS } = require('../services/ladiaTools');
  const { filterFrozenTools } = require('../lib/ladiaFrozenTools');
  const tgNames = filterFrozenTools(LADIA_TOOL_DEFINITIONS).map(t => t.name);
  check(!tgNames.includes('crea_non_conformita') && !tgNames.includes('lista_nc_aperte'), 'Telegram: tool NC filtrati', tgNames);

  // ── 4. Tool generici: tabelle congelate rifiutate, nucleo no ───────────────
  for (const r of ['site_costs', 'company_expenses', 'site_phases', 'subcontractors', 'site_bookings', 'pos_drafts']) {
    check(isResourceFrozen(r), `tabella "${r}" rifiutata da create/update/delete_record`);
  }
  for (const r of ['workers', 'worker_documents', 'site_diary_entries', 'payslips', 'sites']) {
    check(!isResourceFrozen(r), `tabella del nucleo "${r}" ancora scrivibile`);
  }
  const { createRecord } = require('../lib/ladiaGenericTools');
  const res = await createRecord('site_costs', { descrizione: 'x', importo: 1 }, REAL_COMPANY_ID, null, null);
  check(res && res.error === 'MODULO_NON_ATTIVO', 'createRecord("site_costs") → MODULO_NON_ATTIVO, nessuna scrittura', res);

  // ── 5. Navigazione di Ladia verso pagine congelate ─────────────────────────
  for (const p of ['/economia', '/economia?tab=spese', '/prezzario', '/cantieri/abc/economia', '/subappaltatori/abc/scheda']) {
    check(isPathFrozen(p), `navigazione bloccata verso ${p}`);
  }
  for (const p of ['/cantieri/abc/presenze', '/risorse', '/documenti', '/scadenze', '/lavoratori/abc/buste-paga']) {
    check(!isPathFrozen(p), `navigazione consentita verso ${p}`);
  }
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'v1', 'chat.js'), 'utf8');
  check(/if \(forcedPath && isPathFrozen\(forcedPath\)\)/.test(chatSrc), 'navigazione forzata ("fammi vedere l\'economia") salta le pagine congelate');

  // ── 6. Rotte eliminate non più montate ─────────────────────────────────────
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'v1', 'index.js'), 'utf8');
  const mounted = [...indexSrc.matchAll(/router\.use\(\s*'\/'\s*,\s*require\(\s*'\.\/([\w-]+)'\s*\)\s*\)/g)].map(m => m[1]);
  for (const r of ['dvr', 'pimus', 'safetyCopilot', 'ladiaConfig', 'sitePhases']) {
    check(!mounted.includes(r), `rotte "${r}" non montate`);
  }
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check(!/generate-dvr-stream|generate-pimus-stream|\/api\/dvr\/|\/api\/pimus\//.test(serverSrc), 'nessun endpoint DVR/PIMUS in server.js');

  // ── 7. Cron: eliminati mai avviati, congelati dietro il loro modulo ─────────
  check(!/startLadiaLiveCron|startSafetyCopilotCron/.test(serverSrc), 'cron Ladia In Cantiere e Safety Copilot non più avviati');
  const frozenCrons = {
    startEveningSummaryCron: 'daily_digests', startWeeklyValueCron: 'daily_digests', startMonthlyReportCron: 'daily_digests',
    startLadiaProactiveCron: 'ladia_proactive', startReminderCron: 'note_reminders',
    startStudioDigestCron: 'studio_cdl', startStudioDurcAlertCron: 'studio_cdl', startStudioMonthlyReportCron: 'studio_cdl',
    startSdiConsultationPollCron: 'economia', startRecurringExpenseCron: 'economia', startSubcontractorExpiryCron: 'subappaltatori',
  };
  for (const [fn, mod] of Object.entries(frozenCrons)) {
    check(new RegExp(`frozen\\('${mod}', ${fn}\\)`).test(serverSrc) && !new RegExp(`^\\s*${fn}\\(\\);`, 'm').test(serverSrc),
      `${fn} parte solo se "${mod}" è riacceso`);
  }
  check(/^\s*startDailyDigestCron\(\);/m.test(serverSrc), 'email riepilogo scadenze (dailyDigest) resta attiva');

  // ── 8. Memoria di Ladia e checklist: nessuna chiamata AI da spente ─────────
  const mem = require('../services/ladiaMemory');
  check((await mem.getMemory(REAL_COMPANY_ID, { userId: 'x' })) === '', 'memoria di Ladia non iniettata nel prompt');
  check((await mem.getOpenObjectives(REAL_COMPANY_ID, null)) === '', 'obiettivi di Ladia non iniettati nel prompt');
  check((await mem.updateMemoryAfterConversation(REAL_COMPANY_ID, {}, [{ role: 'user', content: 'ciao ciao ciao' }])) === undefined,
    'estrazione memoria dopo la conversazione saltata');
  const { generateAndSave } = require('../routes/v1/siteChecklist');
  check((await generateAndSave('00000000-0000-0000-0000-000000000000', REAL_COMPANY_ID, null, {})) === null,
    'checklist di apertura: nessuna generazione AI');

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('Errore imprevisto:', e.stack || e.message);
  process.exit(1);
});
