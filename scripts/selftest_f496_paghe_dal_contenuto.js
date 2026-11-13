#!/usr/bin/env node
/**
 * scripts/selftest_f496_paghe_dal_contenuto.js
 *
 * Regressione per F-496 (AUDIT.md del frontend, 13/11/2026): buste e prospetti
 * paghe finivano in Documenti (impresa, cantieri, lavoratori), dove li vedono
 * tecnici e coordinatori, se il nome del file non diceva «busta». Ne sono stati
 * trovati 4 col nome «altro». Ora si riconoscono dal CONTENUTO del PDF
 * (lib/bustePaga/riconosci.js) e vanno in Buste paga, solo titolare e
 * amministratori.
 *
 * 1. Riconoscimento: busta e prospetto sì; DURC, UNILAV, POS che nomina le buste no.
 * 2. Dal vivo (API di produzione, sessioni vere): un PDF di busta chiamato
 *    «scan001.pdf» caricato da ogni strada di Documenti → 409 BUSTE_PAGA,
 *    nessuna riga in Documenti, il file è fra i prospetti del titolare; il
 *    tecnico non lo vede. Un PDF normale si carica come sempre (201).
 * 3. Ladia (archiveChatUpload): stessa regola.
 * 4. Nessun PDF di Documenti delle imprese vere è una busta o un prospetto.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY o SUPABASE_KEY.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '') + '/api/v1';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const PROVA = /^(test|e2e)|test-|f184|prova|autoexplore/i;

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}

async function pdf(righe) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  righe.forEach((r, i) => page.drawText(r, { x: 40, y: 800 - i * 18, size: 10, font }));
  return Buffer.from(await doc.save());
}

const BUSTA = ['DITTA ROSSI COSTRUZIONI SRL   PERIODO DI LIQUIDAZIONE   OTTOBRE 2026', 'POSIZIONE INPS 1234567890   PAT INAIL 98765432', 'DIPENDENTE MARIO PROVA   COD. FISCALE PRVMRA80A01D969Z',
  'VOCE DESCRIZIONE ORE/GG.   COMPETENZE   TRATTENUTE', 'RETRIBUZIONE ORDINARIA 168,00   2.100,00', 'IMPONIBILE FISCALE 1.890,00', 'NETTO DEL MESE 1.512,00'];
const NORMALE = ['VERBALE DI CONSEGNA DPI', 'Cantiere di Via Prova 1, Genova', 'Il lavoratore riceve casco, guanti e scarpe antinfortunistiche.', 'Firma del datore di lavoro'];

async function main() {
  console.log('\nPalladia regression — F-496: buste e prospetti paghe riconosciuti dal contenuto\n');
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { console.log('  – skip: Supabase non configurato'); return; }
  const { sembraPaghe, controllaFile } = require('../lib/bustePaga/riconosci');

  // 1. Riconoscimento
  check('busta paga riconosciuta', sembraPaghe(BUSTA.join('\n')).paghe);
  check('mese della busta letto (ottobre 2026)', JSON.stringify(sembraPaghe(BUSTA.join('\n')).periodo) === '{"anno":2026,"mese":10}');
  check('prospetto riconosciuto', sembraPaghe('PERIODO DI LIQUIDAZIONE LUGLIO 2026 POSIZIONE INPS PAT INAIL DIPENDENTI (NORM) COMPETENZE TRATTENUTE TOTALE CONTRIBUTI INPS').paghe);
  check('DURC non è una busta', !sembraPaghe('DURC DOCUMENTO UNICO DI REGOLARITA CONTRIBUTIVA INPS INAIL CASSA EDILE POSIZIONE INPS PAT INAIL SCADENZA VALIDITA').paghe);
  check('UNILAV non è una busta', !sembraPaghe('UNILAV COMUNICAZIONE OBBLIGATORIA POSIZIONE INPS PAT INAIL RETRIBUZIONE/COMPENSO CCNL EDILIZIA LIVELLO 2 DATA INIZIO RAPPORTO').paghe);
  check('POS che nomina buste e libro unico non è una busta', !sembraPaghe('PIANO OPERATIVO DI SICUREZZA. LA BUSTA PAGA E IL LIBRO UNICO DEL LAVORO SONO CONSERVATI IN SEDE. RETRIBUZIONE ORDINARIA SECONDO CCNL.').paghe);
  const bustaPdf = await pdf(BUSTA);
  const normalePdf = await pdf(NORMALE);
  check('dal PDF: la busta si riconosce', (await controllaFile(bustaPdf, 'application/pdf', 'scan001.pdf')).paghe);
  check('dal PDF: il verbale no', !(await controllaFile(normalePdf, 'application/pdf', 'verbale.pdf')).paghe);

  // 2. Dal vivo
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: company, error: cErr } = await admin.from('companies').insert([{ name: 'TEST-F496-PagheDalContenuto' }]).select('id').single();
  if (cErr) throw new Error('company: ' + cErr.message);
  const CO = company.id;
  const token = {}; const userIds = {};
  try {
    for (const role of ['owner', 'tech']) {
      const email = `test-f496-${role}-${crypto.randomUUID()}@example.com`;
      const { data: u, error } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
      if (error) throw new Error('createUser: ' + error.message);
      userIds[role] = u.user.id;
      await admin.from('company_users').insert([{ company_id: CO, user_id: u.user.id, role }]);
      const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      const { data: ses, error: vErr } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
      if (vErr) throw new Error('verifyOtp: ' + vErr.message);
      token[role] = ses.session.access_token;
    }
    const { data: worker } = await admin.from('workers').insert([{ company_id: CO, full_name: 'Mario Prova', fiscal_code: 'PRVMRA80A01D969Z', is_active: true, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase() }]).select('id').single();
    const { data: site, error: sErr } = await admin.from('sites').insert({ company_id: CO, name: 'TEST-F496 cantiere', address: 'Via Prova 1, Genova', status: 'attivo' }).select('id').single();
    if (sErr) throw new Error('site: ' + sErr.message);

    const manda = async (role, path, buf, nome, campi = {}) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/pdf' }), nome);
      for (const [k, v] of Object.entries(campi)) fd.append(k, v);
      const r = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${token[role]}`, 'X-Company-Id': CO }, body: fd });
      let body = null; try { body = await r.json(); } catch { /* */ }
      return { status: r.status, body };
    };
    const strade = [
      ['Documenti › Impresa', '/company-documents', {}],
      ['Carica un documento (impresa)', '/documenti/carica', { kind: 'impresa' }],
      ['Carica un documento (lavoratore)', '/documenti/carica', { kind: 'lavoratori', id: worker.id }],
      ['Documenti del cantiere', `/sites/${site.id}/documents`, {}],
      ['Scheda del lavoratore', `/workers/${worker.id}/documents`, { name: 'Documento', doc_type: 'altro' }],
    ];
    for (const [nome, path, campi] of strade) {
      const r = await manda('owner', path, bustaPdf, 'scan001.pdf', campi);
      check(`${nome}: busta chiamata «scan001.pdf» → 409 BUSTE_PAGA`, r.status === 409 && r.body?.error === 'BUSTE_PAGA' && /Buste paga/.test(r.body?.message || ''), r);
    }
    for (const t of ['company_documents', 'site_documents', 'worker_documents']) {
      const { data } = await admin.from(t).select('id').eq('company_id', CO);
      check(`nessuna busta salvata in ${t}`, (data || []).length === 0, data);
    }
    const prospetti = await (await fetch(BASE + '/buste/riepiloghi', { headers: { Authorization: `Bearer ${token.owner}`, 'X-Company-Id': CO } })).json();
    check('il titolare le trova fra i prospetti di Buste paga (5)', Array.isArray(prospetti) && prospetti.filter(p => /scan001\.pdf \(caricato in Documenti\)/.test(p.nome)).length === strade.length, prospetti);
    const tech = await fetch(BASE + '/buste/riepiloghi', { headers: { Authorization: `Bearer ${token.tech}`, 'X-Company-Id': CO } });
    check('il tecnico non le vede (403)', tech.status === 403, tech.status);
    const rTech = await manda('tech', '/company-documents', bustaPdf, 'foto.pdf');
    check('anche se la carica il tecnico: 409, finisce in Buste paga', rTech.status === 409, rTech);

    const ok = await manda('owner', '/company-documents', normalePdf, 'verbale-dpi.pdf');
    check('un PDF normale si carica in Documenti come sempre (201)', ok.status === 201 && ok.body?.document?.id, ok);

    // 3. Ladia
    const tmp = `chat_uploads/${CO}/${crypto.randomUUID()}.pdf`;
    await admin.storage.from('site-documents').upload(tmp, bustaPdf, { contentType: 'application/pdf' });
    const { data: up } = await admin.from('chat_uploads').insert({ company_id: CO, user_id: userIds.owner, original_name: 'altro.pdf', mime_type: 'application/pdf', storage_path: tmp, size_bytes: bustaPdf.length }).select('id').single();
    const { archiveChatUpload } = require('../services/chatDocumentAnalysis');
    const rl = await archiveChatUpload({ uploadId: up.id, companyId: CO, userId: userIds.owner, destination: 'company_documents', name: 'altro', category: 'altro' });
    check('Ladia: la busta non va in Documenti, le dice che è in Buste paga', rl.spostato_in_buste_paga === true && /Buste paga/.test(rl.error || ''), rl);
    const { data: cdL } = await admin.from('company_documents').select('id, name').eq('company_id', CO);
    check('Ladia: in Documenti solo il verbale', (cdL || []).length === 1 && cdL[0].name === 'verbale-dpi.pdf', cdL);
  } finally {
    const { data: car } = await admin.from('buste_caricamenti').select('riepilogo_path').eq('company_id', CO);
    const files = (car || []).map(c => c.riepilogo_path);
    for (const t of ['company_documents', 'site_documents', 'worker_documents']) {
      const { data } = await admin.from(t).select('file_path').eq('company_id', CO);
      files.push(...(data || []).map(d => d.file_path));
      await admin.from(t).delete().eq('company_id', CO);
    }
    if (files.filter(Boolean).length) await admin.storage.from('site-documents').remove(files.filter(Boolean));
    await admin.from('buste_caricamenti').delete().eq('company_id', CO);
    await admin.from('chat_uploads').delete().eq('company_id', CO);
    await admin.from('sites').delete().eq('company_id', CO);
    await admin.from('workers').delete().eq('company_id', CO);
    await admin.from('company_users').delete().eq('company_id', CO);
    await admin.from('companies').delete().eq('id', CO);
    for (const id of Object.values(userIds)) await admin.auth.admin.deleteUser(id).catch(() => {});
  }

  // 4. Nessuna paga in Documenti delle imprese vere (dal contenuto)
  const cos = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await admin.from('companies').select('id, name').range(f, f + 999);
    cos.push(...(data || [])); if (!data || data.length < 1000) break;
  }
  const vere = new Set(cos.filter(c => !PROVA.test(c.name || '')).map(c => c.id));
  for (const t of ['company_documents', 'site_documents', 'worker_documents']) {
    const rows = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await admin.from(t).select('id, company_id, name, file_path, mime_type').not('file_path', 'is', null).range(f, f + 999);
      rows.push(...(data || [])); if (!data || data.length < 1000) break;
    }
    const pdfs = rows.filter(d => vere.has(d.company_id) && (/pdf/i.test(d.mime_type || '') || /\.pdf/i.test(d.file_path || '')));
    const paghe = [];
    for (let i = 0; i < pdfs.length; i += 10) {
      await Promise.all(pdfs.slice(i, i + 10).map(async d => {
        const { data: b } = await admin.storage.from('site-documents').download(d.file_path);
        if (b && (await controllaFile(Buffer.from(await b.arrayBuffer()), 'application/pdf', 'x.pdf')).paghe) paghe.push({ id: d.id, name: d.name });
      }));
    }
    check(`${t}: nessun PDF delle imprese vere è una busta o un prospetto (${pdfs.length} letti)`, paghe.length === 0, paghe);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
