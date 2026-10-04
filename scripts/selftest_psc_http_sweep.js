#!/usr/bin/env node
/**
 * scripts/selftest_psc_http_sweep.js — F-280, F-281 (AUDIT.md del frontend).
 *
 * Chiamate HTTP vere (non funzioni interne) con un coordinatore temporaneo:
 *  - F-281: un computo senza voci leggibili risponde 422 con la spiegazione,
 *    non 500 "Qualcosa non ha funzionato";
 *  - F-280: nel cantiere di esempio non parte nessuna email, nemmeno se il
 *    coordinatore scrive un indirizzo in un'impresa o nel committente
 *    (invito, firma del verbale, segnalazione art. 92);
 *  - F-279 (lato server): archivia / riapri / elimina un PSC.
 *
 * Env: PSC_API_URL (default produzione), SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY. Crea e cancella le proprie fixture TEST-E2E.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');
const supabase = require('../lib/supabase');

const API = (process.env.PSC_API_URL || 'https://palladia-backend-production.up.railway.app/api/v1').replace(/\/$/, '');
const RUN = `TEST-E2E-PSCSWEEP-${Date.now().toString(36)}`;
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let failed = 0, passed = 0;
const check = (name, ok, info) => { console.log(`${ok ? '✓' : '✗'} ${name}${!ok && info !== undefined ? `  → ${JSON.stringify(info).slice(0, 300)}` : ''}`); ok ? passed++ : failed++; };

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log('SKIP: mancano le variabili Supabase'); return; }
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[01IO]/g, 'Z');
  const code = `CSE-${part()}-${part()}`;
  const email = `${RUN.toLowerCase()}@palladia-test.it`, pw = 'Prova-Sweep-2026!';
  let userId = null, cid = null;
  try {
    await supabase.from('psc_beta_invites').insert({ code, note: RUN });
    const { data: u, error } = await supabase.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { full_name: 'Ing. Sweep' } });
    if (error) throw error;
    userId = u.user.id;
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    const { data: s } = await anon.auth.signInWithPassword({ email, password: pw });
    const jwt = s.session.access_token;
    const call = async (method, path, { json, form } = {}) => {
      const headers = { Authorization: `Bearer ${jwt}` };
      if (cid) headers['X-Company-Id'] = cid;
      let body;
      if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      if (form) body = form;
      const r = await fetch(`${API}${path}`, { method, headers, body });
      const t = await r.text();
      let b = null; try { b = JSON.parse(t); } catch { b = t; }
      return { status: r.status, body: b };
    };
    const setup = await call('POST', '/onboarding/setup', { json: { company_name: `${RUN} Studio`, full_name: 'Ing. Sweep', account_type: 'coordinatore', beta_code: code } });
    cid = setup.body && setup.body.company_id;
    if (!cid) throw new Error(`onboarding fallito: ${JSON.stringify(setup)}`);

    // ── F-281 ────────────────────────────────────────────────────────────────
    const p = (await call('POST', '/psc/projects', { json: { title: `${RUN} Computo`, address: 'Via Roma 10, Genova' } })).body.project;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x').addRow(['niente di utile']);
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(await wb.xlsx.writeBuffer())], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'vuoto.xlsx');
    let r = await call('POST', `/psc/projects/${p.id}/computo`, { form: fd });
    check('F-281: computo senza voci → 422 (non 500)', r.status === 422, r);
    check('F-281: il messaggio spiega cosa fare', /voce|voci/i.test((r.body && r.body.message) || '') && !/Qualcosa non ha funzionato/.test((r.body && r.body.message) || ''), r.body);
    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from('questo non è un excel')], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'rotto.xlsx');
    r = await call('POST', `/psc/projects/${p.id}/computo`, { form: fd2 });
    check('F-281: file Excel rotto → 422 (non 500)', r.status === 422, r);

    // ── F-279 (server) ───────────────────────────────────────────────────────
    r = await call('POST', `/psc/projects/${p.id}/archivia`);
    check('F-279: archivia', r.status === 200 && r.body.status === 'archiviato', r);
    r = await call('POST', `/psc/projects/${p.id}/archivia`, { json: { riapri: true } });
    check('F-279: riapri', r.status === 200 && r.body.status === 'bozza', r);
    r = await call('DELETE', `/psc/projects/${p.id}`);
    const gone = await call('GET', `/psc/projects/${p.id}`);
    check('F-279: elimina → poi 404', r.status === 200 && gone.status === 404, gone);

    // ── F-280 ────────────────────────────────────────────────────────────────
    const es = (await call('POST', '/psc/esempio')).body.project.id;
    const full = (await call('GET', `/psc/projects/${es}`)).body;
    const imp = full.imprese[0];
    await call('PATCH', `/psc/imprese/${imp.id}`, { json: { email: `${RUN.toLowerCase()}-impresa@palladia-test.it` } });
    await call('PATCH', `/psc/projects/${es}`, { json: { soggetti: { ...full.project.soggetti, committente: { ...(full.project.soggetti.committente || {}), email: `${RUN.toLowerCase()}-committente@palladia-test.it` } } } });
    r = await call('POST', `/psc/imprese/${imp.id}/invita`, { json: { invia_email: true } });
    check('F-280: esempio, invito con email nell\'impresa → nessuna email', r.status === 200 && r.body.emailed === false && r.body.url, r.body);
    const v = (await call('POST', `/psc/projects/${es}/verbali`, { json: { tipo: 'sopralluogo' } })).body.verbale;
    r = await call('POST', `/psc/verbali/${v.id}/firma`, { json: { signed_name: 'Ing. Sweep', signature: PNG_1x1, invia: true } });
    check('F-280: esempio, firma del verbale → nessuna email', r.status === 200 && r.body.inviato_a === 0, r.body && { inviato_a: r.body.inviato_a });
    const testo = 'Segnalazione di prova sul cantiere di esempio: testo abbastanza lungo per essere accettato.';
    r = await call('POST', `/psc/projects/${es}/segnalazioni`, { json: { destinatario: 'committente', testo, invia_email: true } });
    check('F-280: esempio, segnalazione al committente → nessuna email', r.status === 201 && r.body.inviata === false, r.body && { inviata: r.body.inviata });
  } catch (e) {
    check('ERRORE', false, e.message);
  } finally {
    if (cid) {
      for (const t of ['psc_segnalazioni', 'psc_nc', 'psc_verbali', 'psc_pos_checks', 'psc_revisions', 'psc_interferenze', 'psc_costi', 'psc_lavorazioni', 'psc_imprese', 'psc_projects', 'psc_library', 'psc_imports', 'company_feature_flags', 'company_users']) await supabase.from(t).delete().eq('company_id', cid);
      await supabase.from('companies').delete().eq('id', cid);
    }
    await supabase.from('psc_beta_invites').delete().eq('code', code);
    if (userId) await supabase.auth.admin.deleteUser(userId);
    console.log(`\n${passed} passati, ${failed} falliti`);
    process.exit(failed ? 1 : 0);
  }
})();
