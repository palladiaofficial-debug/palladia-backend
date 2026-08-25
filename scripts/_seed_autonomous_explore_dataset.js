#!/usr/bin/env node
// Livello 1 del sistema di test autonomo (richiesta utente 2026-08-25):
// dataset sintetico ma verosimile, isolato in un'unica company TEST-, per far
// emergere bug che appaiono solo sui volumi (query lente, liste che non
// paginano, calcoli che si rompono). Insert diretto a DB (service role),
// bypassando le pipeline AI/OCR (che hanno un cap a 500 file + circuit
// breaker giornaliero per design — vedi memoria ai_cost_protections) tranne
// per un piccolo campione instradato nel flusso reale a parte.
//
// Idempotente: rieseguibile, riusa la company/utente se già esistenti.
// Stampa alla fine un JSON con credenziali + tutti gli id creati, che serve
// da input al fuzzer di Livello 2 (EXPLORE_SEED_FILE) e alle property di
// Livello 3.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const COMPANY_NAME = 'TEST-AutoExplore';
const EMAIL = 'autoexplore@palladia-test.local';
const PASSWORD = 'AutoExplore' + crypto.randomBytes(6).toString('hex') + '!9';
const OUT_FILE = process.argv[2] || path.join(__dirname, '_autoexplore_seed.json');

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function dateNDaysAgo(n) { return daysFromNow(-n); }
function isoNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function randOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function badgeCode() { return crypto.randomBytes(8).toString('hex'); }

// CF sintatticamente plausibile (non e' il vero algoritmo, non serve: nessun
// CHECK a livello DB su fiscal_code, solo forma "6 lettere 2 cifre 1 lettera
// 2 cifre 1 lettera 3 cifre 1 lettera").
function fakeCF(seed) {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const rnd = (n) => { let s = ''; for (let i = 0; i < n; i++) s += L[(seed * 7 + i * 13 + s.length) % 26]; return s; };
  const digits = (n) => String(1000 + (seed * 31) % 9000).slice(0, n).padStart(n, '0');
  return `${rnd(6)}${digits(2)}${L[seed % 26]}${digits(2)}${L[(seed + 5) % 26]}${digits(3)}${L[(seed + 11) % 26]}`;
}

// 40 nomi italiani reali, con accenti e apostrofi come richiesto, più un
// gruppo minoritario di nomi non italiani (realistico su un cantiere).
const WORKERS = [
  ['Marco', 'Rossi'], ['Giuseppe', "D'Amico"], ['Luca', 'Bianchi'], ['Andrea', 'Ferrari'],
  ['Niccolò', 'Russo'], ["Giosuè", 'Romano'], ['Francesco', 'Colombo'], ['Antonio', 'Ricci'],
  ['Stefano', 'Marino'], ['Roberto', 'Greco'], ['Paolo', 'Bruno'], ['Simone', 'Gallo'],
  ['Matteo', 'Conti'], ['Alessandro', 'De Luca'], ['Davide', 'Mancini'], ['Riccardo', 'Costa'],
  ['Filippo', 'Giordano'], ['Lorenzo', 'Rizzo'], ['Emanuele', "Dell'Anna"], ['Gabriele', 'Lombardi'],
  ['Cristian', 'Moretti'], ['Fabio', 'Barbieri'], ['Michele', 'Fontana'], ['Salvatore', 'Santoro'],
  ['Vincenzo', "D'Angelo"], ['Domenico', 'Mariani'], ['Gianluca', 'Rinaldi'], ['Massimo', 'Caruso'],
  ['Enrico', 'Ferrara'], ['Pietro', "Lo Cascio"], ['Raffaele', 'Martini'], ['Renato', 'Leone'],
  ['Sergio', 'Longo'], ['Corrado', 'Gentile'], ['Ottavio', 'Vitale'], ["Amedeo", "Serra"],
  ['Ahmed', 'Hassan'], ['Amar', 'Diallo'], ['Ion', 'Popescu'], ['Wei', 'Zhang'],
];

const SITE_DEFS = [
  { name: 'Via Torino 88', city: 'Milano', status: 'attivo' },
  { name: 'Corso Buenos Aires 40', city: 'Milano', status: 'attivo' },
  { name: 'Via Roma 22', city: 'Torino', status: 'attivo' },
  { name: 'Piazza Dante 5', city: 'Bologna', status: 'attivo' },
  { name: 'Via Garibaldi 14', city: 'Genova', status: 'attivo' },
  { name: 'Viale Europa 63', city: 'Firenze', status: 'attivo' },
  { name: 'Via dei Mille 7', city: 'Napoli', status: 'attivo' },
  { name: 'Corso Vittorio Emanuele 101', city: 'Palermo', status: 'attivo' },
  { name: 'Via Verdi 19', city: 'Verona', status: 'ultimato' },
  { name: 'Piazza Cavour 3', city: 'Padova', status: 'ultimato' },
  { name: "Via dell'Industria 55", city: 'Brescia', status: 'chiuso' },
  { name: 'Via Marconi 12', city: 'Bari', status: 'chiuso' },
];

const COMPANY_DOC_CATEGORIES = ['rspp', 'rls', 'medico_competente', 'visite_mediche', 'primo_soccorso', 'emergenze', 'preposto', 'dvr', 'duvri', 'formazione', 'durc', 'visura', 'iso', 'soa', 'assicurazione', 'polizza', 'f24', 'altro'];
const WORKER_DOC_TYPES = ['carta_identita', 'permesso_soggiorno', 'patente', 'certificato_medico', 'contratto', 'busta_paga', 'tessera_sanitaria', 'altro'];
const SITE_DOC_CATEGORIES = ['pos', 'psc', 'notifica_asl', 'durc', 'dvr', 'assicurazione', 'altro'];
const EQUIPMENT_TYPES = ['Betoniera', 'Gru a torre', 'Escavatore', 'Ponteggio mobile', 'Autocarro', 'Piattaforma aerea', 'Compressore', 'Saldatrice'];

async function uploadSeedFile(bucket, key, localFile) {
  const buf = fs.readFileSync(localFile);
  const { error } = await supabase.storage.from(bucket).upload(key, buf, { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error(`upload ${bucket}/${key}: ${error.message}`);
  return key;
}

async function batchInsert(table, rows, chunkSize = 500) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw new Error(`insert ${table} chunk@${i}: ${error.message}`);
    inserted += chunk.length;
    process.stdout.write(`\r  ${table}: ${inserted}/${rows.length}`);
  }
  console.log('');
  return inserted;
}

async function main() {
  console.log(`=== Seed dataset "${COMPANY_NAME}" ===`);

  // 1. Utente + company + membership -----------------------------------
  const { data: existingUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  let user = existingUsers?.users?.find(u => u.email === EMAIL);
  let password = PASSWORD;
  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({ email: EMAIL, password, email_confirm: true, user_metadata: { full_name: 'AutoExplore Bot' } });
    if (error) throw error;
    user = data.user;
    console.log('Utente creato:', EMAIL);
  } else {
    await supabase.auth.admin.updateUserById(user.id, { password });
    console.log('Utente già esistente, password rigenerata.');
  }

  let { data: company } = await supabase.from('companies').select('id').eq('name', COMPANY_NAME).maybeSingle();
  if (!company) {
    const { data, error } = await supabase.from('companies').insert({ name: COMPANY_NAME, subscription_status: 'active', subscription_plan: 'pro' }).select('id').single();
    if (error) throw error;
    company = data;
    console.log('Company creata:', company.id);
  } else {
    console.log('Company già esistente:', company.id);
  }
  const companyId = company.id;

  const { data: member } = await supabase.from('company_users').select('user_id').eq('company_id', companyId).eq('user_id', user.id).maybeSingle();
  if (!member) {
    const { error } = await supabase.from('company_users').insert({ company_id: companyId, user_id: user.id, role: 'admin' });
    if (error) throw error;
  }

  // 2. File demo caricati una volta, riusati da tutte le righe documento ---
  console.log('Upload file demo su storage...');
  const demoDir = __dirname;
  const seedFiles = {
    companyDoc: await uploadSeedFile('site-documents', `${companyId}/seed/company-doc.pdf`, path.join(demoDir, '_demo_attestato.pdf')),
    workerDoc: await uploadSeedFile('site-documents', `${companyId}/seed/worker-doc.pdf`, path.join(demoDir, '_demo_attestato_ahmed.pdf')),
    siteDoc: await uploadSeedFile('site-documents', `${companyId}/seed/site-doc.pdf`, path.join(demoDir, '_demo_prezzario.pdf')),
    certificate: await uploadSeedFile('site-documents', `${companyId}/seed/certificate.pdf`, path.join(demoDir, '_demo_attestato_luigi.pdf')),
    equipmentDoc: await uploadSeedFile('equipment-docs', `${companyId}/seed/equipment-doc.pdf`, path.join(demoDir, '_demo_carta_circolazione.pdf')),
    expenseReceipt: await uploadSeedFile('company-docs', `${companyId}/seed/receipt.pdf`, path.join(demoDir, '_demo_scontrino_test.pdf')),
  };

  // 3. Sites -------------------------------------------------------------
  const siteIds = {};
  const siteRows = [];
  for (const s of SITE_DEFS) {
    const { data: existing } = await supabase.from('sites').select('id').eq('company_id', companyId).eq('name', s.name).maybeSingle();
    if (existing) { siteIds[s.name] = existing.id; continue; }
    const concluded = s.status !== 'attivo';
    siteRows.push({
      company_id: companyId, name: s.name, address: `${s.name}, ${s.city}`, status: s.status,
      end_date: concluded ? dateNDaysAgo(randInt(30, 500)) : null,
    });
  }
  if (siteRows.length) {
    const { data, error } = await supabase.from('sites').insert(siteRows).select('id, name');
    if (error) throw error;
    for (const s of data) siteIds[s.name] = s.id;
    console.log(`Cantieri creati: ${data.length}`);
  }
  const activeSiteNames = SITE_DEFS.filter(s => s.status === 'attivo').map(s => s.name);
  const concludedSiteNames = SITE_DEFS.filter(s => s.status !== 'attivo').map(s => s.name);

  // 4. Workers -------------------------------------------------------------
  const workerIds = {};
  const workerRows = [];
  WORKERS.forEach(([first, last], i) => {
    const key = `${first} ${last}`;
    const expiredHealth = i % 6 === 0;
    const soonHealth = i % 6 === 1;
    const expiredSafety = i % 5 === 0;
    const soonSafety = i % 5 === 1;
    workerRows.push({
      __key: key,
      company_id: companyId, first_name: first, last_name: last, full_name: key,
      fiscal_code: fakeCF(i + 1), badge_code: badgeCode(), is_active: true,
      qualification: randOf(['Operaio edile', 'Caposquadra', 'Ponteggiatore', 'Muratore', 'Carpentiere', 'Elettricista', 'Gruista']),
      hire_date: dateNDaysAgo(randInt(60, 1500)),
      health_fitness_expiry: expiredHealth ? dateNDaysAgo(randInt(1, 90)) : soonHealth ? daysFromNow(randInt(1, 25)) : daysFromNow(randInt(60, 500)),
      safety_training_expiry: expiredSafety ? dateNDaysAgo(randInt(1, 90)) : soonSafety ? daysFromNow(randInt(1, 25)) : daysFromNow(randInt(60, 500)),
    });
  });
  const toInsertWorkers = [];
  for (const w of workerRows) {
    const { data: existing } = await supabase.from('workers').select('id').eq('company_id', companyId).eq('fiscal_code', w.fiscal_code).maybeSingle();
    if (existing) { workerIds[w.__key] = existing.id; continue; }
    const { __key, ...rest } = w;
    toInsertWorkers.push({ __key, row: rest });
  }
  if (toInsertWorkers.length) {
    const { data, error } = await supabase.from('workers').insert(toInsertWorkers.map(w => w.row)).select('id, fiscal_code');
    if (error) throw error;
    const byCf = new Map(data.map(d => [d.fiscal_code, d.id]));
    for (const w of toInsertWorkers) workerIds[w.__key] = byCf.get(w.row.fiscal_code);
    console.log(`Lavoratori creati: ${data.length}`);
  }
  const workerKeys = Object.keys(workerIds);

  // 5. Assegnazioni cantiere (worksite_workers) -----------------------------
  const assignRows = [];
  workerKeys.forEach((wKey, i) => {
    const site = activeSiteNames[i % activeSiteNames.length];
    assignRows.push({ company_id: companyId, worker_id: workerIds[wKey], site_id: siteIds[site], status: 'active', start_date: dateNDaysAgo(randInt(30, 700)) });
  });
  // qualche assegnazione storica su cantieri conclusi
  workerKeys.slice(0, 10).forEach((wKey, i) => {
    const site = concludedSiteNames[i % concludedSiteNames.length];
    assignRows.push({ company_id: companyId, worker_id: workerIds[wKey], site_id: siteIds[site], status: 'ended', start_date: dateNDaysAgo(randInt(400, 900)), end_date: dateNDaysAgo(randInt(60, 300)) });
  });
  for (const a of assignRows) {
    const { data: existing } = await supabase.from('worksite_workers').select('id').eq('worker_id', a.worker_id).eq('site_id', a.site_id).maybeSingle();
    if (!existing) await supabase.from('worksite_workers').insert(a);
  }
  console.log(`Assegnazioni cantiere: ${assignRows.length}`);

  // 6. Presenze — 3 anni per un sottoinsieme di lavoratori (bypass punch_atomic,
  // insert diretto: nessun CHECK sulla data, solo trigger append-only su UPDATE/DELETE) --
  const historyWorkers = workerKeys.slice(0, 15);
  const presenceRows = [];
  for (const wKey of historyWorkers) {
    const site = activeSiteNames[workerKeys.indexOf(wKey) % activeSiteNames.length];
    const siteId = siteIds[site];
    const workerId = workerIds[wKey];
    for (let d = 1095; d >= 1; d--) { // 3 anni
      const day = isoNDaysAgo(d);
      const dow = day.getDay();
      if (dow === 0 || dow === 6) continue; // weekend
      if (Math.random() < 0.06) continue; // assenza sporadica realistica
      const entry = new Date(day); entry.setHours(7 + randInt(0, 1), randInt(0, 59), 0, 0);
      presenceRows.push({ company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'ENTRY', timestamp_server: entry.toISOString(), method: 'seed_history' });
      if (Math.random() < 0.97) { // qualche uscita mancante, realistico
        const exit = new Date(day); exit.setHours(16 + randInt(0, 1), randInt(0, 59), 0, 0);
        presenceRows.push({ company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'EXIT', timestamp_server: exit.toISOString(), method: 'seed_history' });
      }
    }
  }
  console.log(`Generazione presenze: ${presenceRows.length} righe su 3 anni per ${historyWorkers.length} lavoratori`);
  await batchInsert('presence_logs', presenceRows);

  // 7. Documenti aziendali (17 categorie x 15) -----------------------------
  const companyDocRows = [];
  for (const cat of COMPANY_DOC_CATEGORIES) {
    for (let i = 0; i < 15; i++) {
      const expiring = i % 10 === 0;
      companyDocRows.push({
        company_id: companyId, name: `${cat}-${i + 1} TEST-AutoExplore`, category: cat,
        file_path: seedFiles.companyDoc, file_size: 42730, mime_type: 'application/pdf',
        uploaded_by: user.id,
        ai_expiry_date: expiring ? daysFromNow(randInt(1, 20)) : null,
      });
    }
  }
  await batchInsert('company_documents', companyDocRows);

  // 8. Documenti lavoratore (8 per lavoratore) ------------------------------
  const workerDocRows = [];
  for (const wKey of workerKeys) {
    for (let i = 0; i < 8; i++) {
      const type = WORKER_DOC_TYPES[i % WORKER_DOC_TYPES.length];
      const expired = i === 0;
      workerDocRows.push({
        company_id: companyId, worker_id: workerIds[wKey], doc_type: type, name: `${type} — ${wKey}`,
        issued_date: dateNDaysAgo(randInt(100, 900)),
        expiry_date: expired ? dateNDaysAgo(randInt(1, 60)) : daysFromNow(randInt(30, 700)),
        file_url: seedFiles.workerDoc,
      });
    }
  }
  await batchInsert('worker_documents', workerDocRows);

  // 9. Attestati/certificati (4 per lavoratore, mix scaduti/in scadenza/validi/soft-deleted) --
  const { data: courseTypes } = await supabase.from('course_types').select('id, validity_years').not('name', 'ilike', 'TEST-%');
  const certRows = [];
  workerKeys.forEach((wKey, wi) => {
    for (let i = 0; i < 4; i++) {
      const course = courseTypes[(wi * 4 + i) % courseTypes.length];
      const validityDays = (course.validity_years || 5) * 365;
      const state = i % 4; // 0 valido, 1 in scadenza, 2 scaduto, 3 soft-deleted (valido ma cancellato)
      let issueOffset;
      if (state === 2) issueOffset = validityDays + randInt(1, 90); // scaduto
      else if (state === 1) issueOffset = validityDays - randInt(1, 20); // in scadenza
      else issueOffset = randInt(30, Math.max(31, validityDays - 60)); // valido
      certRows.push({
        company_id: companyId, worker_id: workerIds[wKey], course_type_id: course.id,
        site_id: siteIds[activeSiteNames[wi % activeSiteNames.length]],
        issue_date: dateNDaysAgo(issueOffset), expiry_date: dateNDaysAgo(issueOffset - validityDays),
        issuing_body: 'Ente Formazione TEST-AutoExplore', certificate_number: `AE-${wi}-${i}`,
        pdf_url: seedFiles.certificate,
        deleted_at: state === 3 ? new Date().toISOString() : null,
      });
    }
  });
  await batchInsert('worker_certificates', certRows);

  // 10. Mezzi + documenti mezzo ---------------------------------------------
  const equipmentIds = [];
  const equipmentRows = EQUIPMENT_TYPES.map((type, i) => ({
    company_id: companyId, type, model: `Modello ${i + 1}`, plate_or_serial: `AE-${1000 + i}`,
    ownership: 'Aziendale', is_active: true,
    inspection_date: dateNDaysAgo(randInt(30, 300)),
    insurance_expiry: i % 4 === 0 ? dateNDaysAgo(randInt(1, 30)) : daysFromNow(randInt(60, 400)),
  }));
  {
    const toInsert = [];
    for (const e of equipmentRows) {
      const { data: existing } = await supabase.from('equipment').select('id').eq('company_id', companyId).eq('plate_or_serial', e.plate_or_serial).maybeSingle();
      if (existing) equipmentIds.push(existing.id); else toInsert.push(e);
    }
    if (toInsert.length) {
      const { data, error } = await supabase.from('equipment').insert(toInsert).select('id');
      if (error) throw error;
      equipmentIds.push(...data.map(d => d.id));
    }
  }
  const equipmentDocRows = [];
  for (const eqId of equipmentIds) {
    for (let i = 0; i < 5; i++) {
      equipmentDocRows.push({ company_id: companyId, equipment_id: eqId, doc_type: ['libretto', 'assicurazione', 'revisione', 'collaudo', 'altro'][i], file_name: `mezzo-doc-${i + 1}.pdf`, file_url: seedFiles.equipmentDoc, file_size: 67235, mime_type: 'application/pdf', uploaded_by: user.id });
    }
  }
  await batchInsert('equipment_documents', equipmentDocRows);

  // 11. Documenti cantiere (10 per cantiere) ---------------------------------
  const siteDocRows = [];
  for (const name of Object.keys(siteIds)) {
    for (let i = 0; i < 10; i++) {
      siteDocRows.push({ company_id: companyId, site_id: siteIds[name], name: `${SITE_DOC_CATEGORIES[i % SITE_DOC_CATEGORIES.length]}-${i + 1}`, category: SITE_DOC_CATEGORIES[i % SITE_DOC_CATEGORIES.length], file_path: seedFiles.siteDoc, file_size: 46360, mime_type: 'application/pdf', uploaded_by: user.id });
    }
  }
  await batchInsert('site_documents', siteDocRows);

  // 12. Spese/fatture con duplicati e note di credito -----------------------
  const expenseRows = [];
  const suppliers = ['Edilcoop Srl', 'Ferramenta Rossi', 'Cementi Lombardi Spa', 'Noleggio Mezzi Nord', 'Elettroforniture Sud'];
  for (let i = 0; i < 70; i++) {
    const supplier = randOf(suppliers);
    const amount = randInt(50, 8000) + Math.random();
    expenseRows.push({
      company_id: companyId, amount: amount.toFixed(2), description: `Fornitura materiali #${i + 1}`,
      category: randOf(['materiali', 'noleggio', 'trasporto', 'manodopera', 'altro']),
      payment_method: randOf(['bonifico', 'contanti', 'carta']),
      supplier, expense_date: dateNDaysAgo(randInt(1, 1000)),
      site_id: siteIds[randOf(Object.keys(siteIds))], receipt_url: seedFiles.expenseReceipt,
      invoice_number: `${2023 + Math.floor(i / 30)}-${i + 1}`, source: 'manual',
    });
  }
  // 6 coppie nota di credito (stesso pattern di selftest_expense_credit_note_summary.js)
  for (let i = 0; i < 6; i++) {
    const supplier = randOf(suppliers);
    const amount = randInt(200, 3000);
    const invoiceNumber = `CN-${2025}-${i + 1}`;
    expenseRows.push({ company_id: companyId, amount, description: `Fattura ${invoiceNumber}`, category: 'materiali', payment_method: 'bonifico', supplier, expense_date: dateNDaysAgo(randInt(10, 300)), invoice_number: invoiceNumber, source: 'sdi_auto', is_credit_note: false, receipt_url: seedFiles.expenseReceipt });
    expenseRows.push({ company_id: companyId, amount, description: `Nota di credito ${invoiceNumber}`, category: 'materiali', payment_method: 'bonifico', supplier, expense_date: dateNDaysAgo(randInt(1, 9)), invoice_number: invoiceNumber, source: 'sdi_auto', is_credit_note: true, sdi_document_type: 'TD04', receipt_url: seedFiles.expenseReceipt });
  }
  // 4 "quasi duplicati" (stesso fornitore+importo+numero fattura simile, hash diverso — il
  // caso che un umano riconoscerebbe ma un sistema ingenuo no; bersaglio della property F-0XX Livello 3)
  for (let i = 0; i < 4; i++) {
    const supplier = randOf(suppliers);
    const amount = randInt(500, 2000);
    const invNum = `DUP-${i + 1}`;
    expenseRows.push({ company_id: companyId, amount, description: `Fattura ${invNum}`, category: 'materiali', payment_method: 'bonifico', supplier, expense_date: dateNDaysAgo(50), invoice_number: invNum, source: 'manual', receipt_url: seedFiles.expenseReceipt });
    expenseRows.push({ company_id: companyId, amount, description: `Fattura ${invNum} (ricaricata)`, category: 'materiali', payment_method: 'bonifico', supplier, expense_date: dateNDaysAgo(50), invoice_number: invNum + ' ', source: 'manual', receipt_url: seedFiles.expenseReceipt });
  }
  await batchInsert('company_expenses', expenseRows);

  // 13. Riepilogo -------------------------------------------------------------
  const docCount = companyDocRows.length + workerDocRows.length + certRows.length + equipmentDocRows.length + siteDocRows.length;
  const summary = {
    email: EMAIL, password, companyId, userId: user.id,
    siteIds: Object.values(siteIds), workerIds: Object.values(workerIds),
    equipmentIds, subcontractorIds: [],
    counts: {
      workers: workerKeys.length, sites: Object.keys(siteIds).length, presence: presenceRows.length,
      documents: docCount, certificates: certRows.length, equipment: equipmentIds.length, expenses: expenseRows.length,
    },
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
  console.log('\n=== FATTO ===');
  console.log(JSON.stringify(summary.counts, null, 2));
  console.log(`Seed file scritto in: ${OUT_FILE}`);
  console.log(`Documenti totali: ${docCount} (obiettivo 800+: ${docCount >= 800 ? 'OK' : 'DA RIVEDERE'})`);
}

main().catch(e => { console.error('ERRORE:', e); process.exit(1); });
