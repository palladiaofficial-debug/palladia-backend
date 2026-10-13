#!/usr/bin/env node
/**
 * scripts/selftest_comunicazioni_coerenti.js — F-351/F-352/F-353/F-354 (AUDIT.md del frontend).
 *
 * Ogni canale che AVVISA il titolare sui documenti deve dire esattamente quello
 * che si vede su /documenti (lib/documentiStato.js). Il 13/10/2026 l'email del
 * mattino, Da fare (e il Telegram delle 7:30), le notifiche e il report del
 * lunedì calcolavano ognuno a modo suo: falsi "mancanti", corsi rinnovati
 * dati per scaduti, avvisi vecchi mai tolti.
 *
 * Azienda di prova con i casi veri visti quel giorno:
 *  - Rinnovato: corso vecchio scaduto + attestato "Formazione lavoratori" valido (Festim)
 *  - CampoRinnovato: visita vecchia scaduta, rinnovo solo sulla scheda (Mantelli)
 *  - Senza: nessun documento → l'unico "mancante"
 *  - Scaduto: visita scaduta da 41 giorni (Di Leonardo, sparito dal report del lunedì)
 *  - Inattivo: non deve comparire da nessuna parte
 *  - una notifica "mancanti" vecchia per Rinnovato (ferma dal 31/08)
 *  - DURC vecchio scaduto e già rinnovato, visura in scadenza fra 10 giorni
 * Nessun messaggio spedito: email, Telegram e push sono finti.
 * In fondo un controllo sul codice: i canali attivi non leggono più da soli
 * le date dei lavoratori.
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Canali finti: registrano invece di spedire ───────────────────────────────
const inviate = { email: [], weekly: [], telegram: [], push: [] };
function finto(rel, overrides) {
  const p = path.join(__dirname, '..', rel);
  const vero = require(p);
  require.cache[p].exports = { ...vero, ...overrides };
}
finto('services/email.js', {
  sendDailyAlertDigest: async (o) => { inviate.email.push(o); return { id: 'finta' }; },
  sendWeeklyExpiryReport: async (o) => { inviate.weekly.push(o); return { id: 'finta' }; },
});
finto('services/telegramNotifications.js', {
  notifyExpiryAlert: async (companyId, text) => { inviate.telegram.push({ companyId, text }); },
  notifyResolved: async (companyId, items) => { inviate.telegram.push({ companyId, resolved: items }); },
  notifyCompany: async (companyId, text) => { inviate.telegram.push({ companyId, text }); },
});
finto('services/pushNotifications.js', {
  sendPushToCompany: async (companyId, p) => { inviate.push.push({ companyId, p }); },
});

const supabase = require('../lib/supabase');
const { problemiLavoratori } = require('../lib/documentiStato');
const { buildDaFare } = require('../lib/daFare');
const { runDailyDigest } = require('../services/dailyDigestCron');
const { runDailyDocCheck } = require('../services/dailyDocCheckCron');
const { buildExpiryEvents } = require('../services/weeklyExpiryReportCron');
const { latestCompanyDocs } = require('../services/expiryHelper');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const T = `TEST-F352-${Date.now()}`;
const stamp = String(Date.now()).slice(-7);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const giorni = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function controlloCodice() {
  console.log('\n  Codice dei canali attivi');
  // Chi avvisa sui lavoratori passa da documentiStato: niente date lette da sé,
  // niente .in() con gli id di tutte le aziende.
  const canali = ['services/dailyDigestCron.js', 'services/dailyDocCheckCron.js', 'services/weeklyExpiryReportCron.js',
    'services/expiryAlertCron.js', 'lib/daFare.js', 'lib/alertDigest.js'];
  for (const f of canali) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    check(`${f}: niente calcolo proprio dei documenti dei lavoratori`,
      !/from\('worker_documents'\)|safety_training_expiry|health_fitness_expiry|REQUIRED_TYPES/.test(src));
    check(`${f}: niente .in('worker_id', …) su tutti i lavoratori`, !/\.in\('worker_id', workerIds\)/.test(src));
  }
}

async function main() {
  console.log('\n\x1b[1mF-351→F-354 — tutti i canali dicono la stessa cosa di /documenti\x1b[0m');
  controlloCodice();

  const company = await ins('companies', { name: T });
  let userId = null;
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `f352-owner-${stamp}@example.com`, email_confirm: true, password: crypto.randomBytes(12).toString('hex'),
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    userId = data.user.id;
    await ins('company_users', { company_id: company.id, user_id: userId, role: 'owner' });

    const worker = (nome, extra = {}) => ins('workers', {
      company_id: company.id, full_name: `${nome} ${stamp}`, is_active: true,
      fiscal_code: `F352${nome.slice(0, 4)}${stamp}`.toUpperCase().slice(0, 16), badge_code: `F352-${nome}-${stamp}`, ...extra,
    });
    const rinnovato = await worker('Rinnovato', { health_fitness_expiry: giorni(300) });
    const campo     = await worker('CampoRinnovato', { health_fitness_expiry: giorni(300), safety_training_expiry: giorni(1500) });
    const senza     = await worker('Senza');
    const scaduto   = await worker('Scaduto', { health_fitness_expiry: giorni(-41), safety_training_expiry: giorni(1500) });
    const inattivo  = await worker('Inattivo', { is_active: false });

    const { data: corso } = await supabase.from('course_types').select('id').eq('name', 'Formazione lavoratori - Rischio Alto').single();
    await ins('worker_documents', { company_id: company.id, worker_id: rinnovato.id, doc_type: 'formazione_sicurezza',
      name: 'Formazione sicurezza D.Lgs. 81/2008', file_path: `test/${T}/f.pdf`, expiry_date: giorni(-83) });
    await ins('worker_certificates', { company_id: company.id, worker_id: rinnovato.id, course_type_id: corso.id,
      issue_date: giorni(-20), expiry_date: giorni(1800), issuing_body: 'Ente prova' });
    await ins('worker_documents', { company_id: company.id, worker_id: campo.id, doc_type: 'idoneita_medica',
      name: 'Idoneità medica', file_path: `test/${T}/i.pdf`, expiry_date: giorni(-89) });
    // Notifica vecchia rimasta dal 31/08
    await ins('notifications', { company_id: company.id, type: 'worker_doc_missing', severity: 'critical',
      title: `${rinnovato.full_name} — Idoneità medica`, body: 'Documenti obbligatori mancanti',
      entity_type: 'worker', entity_id: rinnovato.id, updated_at: '2026-08-31T05:05:00Z' });
    await ins('company_documents', { company_id: company.id, name: 'DURC vecchio.pdf', category: 'durc', file_path: `test/${T}/d1.pdf`, ai_expiry_date: giorni(-60) });
    await ins('company_documents', { company_id: company.id, name: 'DURC nuovo.pdf', category: 'durc', file_path: `test/${T}/d2.pdf`, ai_expiry_date: giorni(200) });
    await ins('company_documents', { company_id: company.id, name: 'Visura.pdf', category: 'visura', file_path: `test/${T}/v.pdf`, ai_expiry_date: giorni(10) });

    // ── La verità: /documenti ──────────────────────────────────────────────
    console.log('\n  /documenti (la verità)');
    const vero = await problemiLavoratori(company.id);
    check('mancante solo chi non ha niente (visita e corso)',
      vero.mancanti.length === 1 && vero.mancanti[0].workerId === senza.id && vero.mancanti[0].missing.length === 2, vero.mancanti);
    check('in scadenza solo la visita scaduta da 41 giorni',
      vero.scadenze.length === 1 && vero.scadenze[0].workerId === scaduto.id && vero.scadenze[0].key === 'idoneita', vero.scadenze);
    check('lavoratore disattivato ignorato', !JSON.stringify(vero).includes(inattivo.id));

    const attesoMancanti = [senza.full_name];
    const attesoScadenze = [`${scaduto.full_name}|Visita medica`];

    // ── Email delle 7:30 ───────────────────────────────────────────────────
    console.log('\n  Email «Riepilogo conformità»');
    await runDailyDigest({ companyIds: [company.id] });
    const mail = inviate.email.find(e => e.companyName === T);
    check('email preparata', !!mail);
    if (mail) {
      check('mancanti = /documenti', same(mail.sections.missingDocs.map(w => w.full_name), attesoMancanti), mail.sections.missingDocs);
      check('scadenze lavoratori = /documenti', same(mail.sections.workerExpiry.map(d => `${d.worker.full_name}|${d.typeLabel}`), attesoScadenze), mail.sections.workerExpiry);
      check('documenti aziendali: solo la visura (DURC già rinnovato)', same(mail.sections.companyExpiry.map(d => d.name), ['Visura.pdf']), mail.sections.companyExpiry);
    }

    // ── Da fare (anche Telegram delle 7:30 e card Buongiorno) ─────────────
    console.log('\n  Da fare');
    const df = await buildDaFare(company.id, null, {});
    const righeLav = df.items.filter(i => [rinnovato, campo, senza, scaduto, inattivo].some(w => i.entityId === w.id || i.title.includes(w.full_name)));
    check('righe sui lavoratori = /documenti', same(righeLav.map(i => i.title), [
      `Visita medica — ${senza.full_name}`, `Corso sicurezza — ${senza.full_name}`, `Visita medica — ${scaduto.full_name}`,
    ]), righeLav.map(i => i.title));
    check('nessuna riga dalla notifica vecchia', !df.items.some(i => i.type === 'worker_doc_missing'), df.items.filter(i => i.kind === 'avviso'));
    check('documenti aziendali: niente DURC già rinnovato', !df.items.some(i => /DURC/.test(i.title)), df.items.filter(i => /DURC/.test(i.title)));

    // ── Notifiche in-app + Telegram delle 7:05 ─────────────────────────────
    console.log('\n  Notifiche in-app / Telegram');
    await runDailyDocCheck({ companyIds: [company.id] });
    const { data: notif, error: nErr } = await supabase.from('notifications').select('type, entity_id, title').eq('company_id', company.id);
    if (nErr) throw new Error(nErr.message);
    const miss = notif.filter(n => n.type === 'worker_doc_missing');
    const exp = notif.filter(n => n.type === 'worker_doc_expiry');
    check('notifica vecchia tolta, "mancanti" solo per chi non ha niente', same(miss.map(n => n.entity_id), [senza.id]), miss);
    check('scadenze solo la visita scaduta', exp.length === 1 && exp[0].title.startsWith(scaduto.full_name), exp);
    const tg = inviate.telegram.filter(m => m.companyId === company.id && m.text);
    check('Telegram: nomina chi manca e chi è scaduto, non gli altri',
      tg.length === 1 && tg[0].text.includes(senza.full_name) && tg[0].text.includes(scaduto.full_name)
      && !tg[0].text.includes(rinnovato.full_name) && !tg[0].text.includes(campo.full_name), tg);

    // ── Report del lunedì ──────────────────────────────────────────────────
    console.log('\n  Report del lunedì');
    const week = await buildExpiryEvents(company.id);
    const ev = [...week.critical, ...week.warning].map(e => e.label);
    check('lavoratori = /documenti (anche scaduto da più di 30 giorni)', ev.includes(`Visita medica — ${scaduto.full_name}`)
      && !ev.some(l => l.includes(rinnovato.full_name) || l.includes(campo.full_name)), ev);

    // ── Rinnovi dei documenti aziendali (cron in-app delle 7:12) ───────────
    console.log('\n  Documenti aziendali');
    const ultimi = latestCompanyDocs([
      { id: '1', company_id: 'a', category: 'durc', ai_expiry_date: giorni(-60) },
      { id: '2', company_id: 'a', category: 'durc', ai_expiry_date: giorni(200) },
      { id: '3', company_id: 'b', category: 'durc', ai_expiry_date: giorni(-5) },
      { id: '4', company_id: 'a', category: 'altro', ai_expiry_date: giorni(3) },
    ]);
    check('per azienda e categoria conta il più recente', same(ultimi.map(d => d.id), ['2', '3', '4']), ultimi);
  } finally {
    for (const t of ['notifications', 'worker_certificates', 'worker_documents', 'company_documents', 'documents', 'workers', 'company_users']) {
      await supabase.from(t).delete().eq('company_id', company.id);
    }
    await supabase.from('companies').delete().eq('id', company.id);
    if (userId) await supabase.auth.admin.deleteUser(userId);
  }
  console.log(`\n  ${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
