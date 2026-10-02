#!/usr/bin/env node
/**
 * scripts/selftest_pos_figures.js — F-263 (AUDIT.md del frontend).
 *
 * Le figure della sicurezza del POS dell'impresa arrivano da ciò che Palladia
 * sa già, ognuna con la sua fonte, in quest'ordine: registro dell'azienda,
 * documenti (attestati RSPP/RLS) e attestati dei lavoratori (primo soccorso,
 * antincendio), ultimo POS, titolare dell'account.
 *  - i documenti battono l'ultimo POS (un POS sbagliato non fa da verità);
 *  - gli addetti emergenze: chi ha l'attestato valido, prima chi è nel cantiere;
 *    mai attestati scaduti né lavoratori dei subappaltatori;
 *  - il registro salvato vince su tutto; salva solo chiavi note e nomi non vuoti;
 *  - i lavoratori del POS portano i loro corsi validi.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { figureSuggestions, saveRegistry, nameFromDocName } = require('../lib/posFigures');
const { buildPosPrefill, lastPosOf } = require('../lib/posPrefill');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F263-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
async function courseId(name) {
  const { data } = await supabase.from('course_types').select('id').eq('name', name).maybeSingle();
  if (!data) throw new Error(`course_types: manca "${name}"`);
  return data.id;
}

async function main() {
  console.log('\n\x1b[1mF-263 — figure della sicurezza già compilate, con la fonte\x1b[0m');

  check('nome dal titolo: "ATTESTATO AGG. RSPP R.A. CATALANO ARIANNA.pdf"', nameFromDocName('ATTESTATO AGG. RSPP R.A. CATALANO ARIANNA.pdf') === 'Catalano Arianna');
  check('nome dal titolo: "AGG. RLS DI LEONARDO CARLO.pdf" (il "Di" del cognome resta)', nameFromDocName('AGG. RLS DI LEONARDO CARLO.pdf') === 'Di Leonardo Carlo');
  check('nessun nome: "nomina medico competente 16.07.2025.pdf"', nameFromDocName('nomina medico competente 16.07.2025.pdf') === null);
  check('nessun nome: "RSPP.pdf"', nameFromDocName('RSPP.pdf') === null);

  const PS = await courseId('Primo Soccorso - Gruppo B/C');
  const AI = await courseId('Antincendio - Rischio Medio');
  const QUOTA = await courseId('Lavori in quota');

  const company = await ins('companies', { name: T, vat_number: '01234567890' });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via Test 1', city: 'Genova', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: company.id, company_name: `${T}-Sub` });
    const w = async (n, extra = {}) => ins('workers', { company_id: company.id, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F263${n.slice(0, 4).toUpperCase()}${stamp}`, badge_code: `F263${n.slice(0, 3)}${stamp}`, ...extra });
    const wCant = await w('Anna Cantiere');
    const wFuori = await w('Bruno Fuori');
    const wScad = await w('Carla Scaduta');
    const wSub = await w('Dario Sub', { subcontractor_id: sub.id });
    await ins('worksite_workers', { site_id: site.id, worker_id: wCant.id, status: 'active', company_id: company.id });
    const cert = (worker, course, expiry) => ins('worker_certificates', { company_id: company.id, worker_id: worker.id, course_type_id: course, issue_date: '2025-01-01', expiry_date: expiry, issuing_body: 'Ente prova F263' });
    await cert(wFuori, PS, '2030-01-01');
    await cert(wCant, PS, '2029-01-22');
    await cert(wScad, AI, '2020-01-01');
    await cert(wSub, AI, '2031-01-01');
    await cert(wCant, QUOTA, '2030-06-01');
    await ins('company_documents', { company_id: company.id, name: 'ATTESTATO RSPP ROSSI MARIO.pdf', category: 'rspp', file_path: `${T}/rspp.pdf` });
    await ins('company_documents', { company_id: company.id, name: 'nomina medico competente 2025.pdf', category: 'medico_competente', file_path: `${T}/mc.pdf` });
    // Ultimo POS dell'impresa con figure diverse dai documenti
    await ins('pos_documents', { company_id: company.id, site_id: site.id, revision: 1, content: 'x', pos_data: { rspp: 'RSPP Del Pos', rls: 'RLS Del Pos', rlsTel: '010 1', medico: 'Medico Del Pos', antincendio: 'AI Del Pos', preposto: 'Preposto Del Pos' } });

    const lastPos = await lastPosOf(company.id, null);
    const r = await figureSuggestions(company.id, site.id, { company, lastPos });
    check('RSPP dal documento, non dall’ultimo POS', r.figures.rspp.nome === 'Rossi Mario' && r.sources.rspp.tipo === 'documento', { f: r.figures.rspp, s: r.sources.rspp });
    check('RLS dall’ultimo POS (nessun documento), con il telefono', r.figures.rls.nome === 'RLS Del Pos' && r.figures.rls.telefono === '010 1' && r.sources.rls.tipo === 'pos', r.figures.rls);
    check('primo soccorso: chi ha l’attestato ed è nel cantiere, prima di chi non c’è', r.figures.addettoPrimoSoccorso.nome === `${T} Anna Cantiere` && r.sources.addettoPrimoSoccorso.tipo === 'attestato', r.figures.addettoPrimoSoccorso);
    check('candidati primo soccorso: entrambi, quello in cantiere per primo', r.candidati.addettoPrimoSoccorso.map(c => c.nome).join('|') === `${T} Anna Cantiere|${T} Bruno Fuori`, r.candidati.addettoPrimoSoccorso);
    check('antincendio: attestato scaduto e lavoratore del subappaltatore esclusi → ultimo POS', r.figures.addettoAntincendio.nome === 'AI Del Pos' && r.candidati.addettoAntincendio.length === 0, { f: r.figures.addettoAntincendio, c: r.candidati.addettoAntincendio });
    check('medico: dall’ultimo POS quando la nomina non ha il nome', r.figures.medicoCompetente.nome === 'Medico Del Pos' && r.sources.medicoCompetente.tipo === 'pos');
    check('nessuna figura senza fonte quando ha un nome', Object.keys(r.figures).every(k => !r.figures[k].nome || r.sources[k]), r.sources);

    // Registro dell'azienda: vince su tutto
    const saved = await saveRegistry(company.id, null, { rspp: { nome: '  Verdi Luca ', telefono: '333' }, medicoCompetente: { nome: 'Dott. Neri' }, rls: { nome: '' }, inventata: { nome: 'X' } });
    check('registro: solo chiavi note e nomi non vuoti, spazi tolti', JSON.stringify(Object.keys(saved).sort()) === '["medicoCompetente","rspp"]' && saved.rspp.nome === 'Verdi Luca', saved);
    const r2 = await figureSuggestions(company.id, site.id, { company, lastPos });
    check('registro salvato vince su documento e ultimo POS', r2.registro && r2.figures.rspp.nome === 'Verdi Luca' && r2.figures.rspp.telefono === '333' && r2.sources.rspp.tipo === 'registro' && r2.figures.medicoCompetente.nome === 'Dott. Neri', r2.figures.rspp);
    check('figure non nel registro: restano le altre fonti', r2.figures.rls.nome === 'RLS Del Pos');

    // Precompilazione completa del POS dell'impresa
    const p = await buildPosPrefill(company.id, site.id, null);
    check('prefill: figure con le fonti e i candidati', p.figures.rspp.nome === 'Verdi Luca' && p.figureSources.rspp.tipo === 'registro' && Array.isArray(p.figureCandidates.addettoPrimoSoccorso) && p.figuresFromRegistry === true);
    check('prefill: lavoratore con i suoi corsi validi', JSON.stringify(p.workers.find(x => x.id === wCant.id)?.corsi) === JSON.stringify(['Lavori in quota', 'Primo Soccorso - Gruppo B/C'].sort()), p.workers);
    const ps = await buildPosPrefill(company.id, site.id, sub.id);
    check('prefill subappaltatore: niente registro né documenti dell’impresa', ps.figures.rspp.nome === '' && !ps.figuresFromRegistry, ps.figures.rspp);
  } finally {
    await supabase.from('company_safety_figures').delete().eq('company_id', company.id);
    await supabase.from('worker_certificates').delete().eq('company_id', company.id);
    await supabase.from('company_documents').delete().eq('company_id', company.id);
    await supabase.from('pos_documents').delete().eq('company_id', company.id);
    const { data: ss } = await supabase.from('sites').select('id').eq('company_id', company.id);
    for (const s of ss || []) await supabase.from('worksite_workers').delete().eq('site_id', s.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('subcontractors').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
