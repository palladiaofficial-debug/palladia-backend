#!/usr/bin/env node
/**
 * scripts/ladia_evals/setup_fixtures.js
 *
 * Riporta la company TEST-LadiaEvals allo stato noto richiesto dai 60
 * scenari in scenarios.json. Va eseguito prima di ogni run dell'harness
 * (run_evals.js) così ogni esecuzione parte da uno stato riproducibile.
 *
 * NON cancella sites/workers/subcontractors: presence_logs ha un trigger
 * DB append-only (voluto, vedi memoria ci_test_fixtures — audit trail di
 * compliance) che blocca in cascata la cancellazione di qualunque worker/
 * sito con timbrature. Questi anchor entity sono quindi find-or-create
 * (stesso fiscal_code/nome+indirizzo → stesso id riusato tra run diversi).
 * Tutto ciò che NON ha questo vincolo (site_notes, site_costs, SAL,
 * computo, certificati, documenti, subappaltatori-per-cantiere,
 * assegnazioni) viene cancellato e riseminato da zero ad ogni run, per
 * garantire lo stato di partenza esatto che ogni scenario si aspetta
 * (es. la NC di W07 deve essere aperta, non già risolta da un run precedente).
 *
 * Uso: node scripts/ladia_evals/setup_fixtures.js
 * Richiede: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_CI_PASSWORD
 *   (quest'ultima solo su Railway — vedi scripts/setup-ci-user.js).
 */
'use strict';
require('dotenv').config();
const supabase = require('../../lib/supabase');
const { generateBadgeCode } = require('../../lib/badgeCode');

const COMPANY_NAME = 'TEST-LadiaEvals';
const CI_EMAIL = 'ci-test@palladia.internal';

function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoAt(hour, daysOffset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function mustInsert(table, rows) {
  const { error } = await supabase.from(table).insert(rows);
  if (error) throw new Error(`Insert ${table} fallito: ${error.message}`);
}

// Cancella solo le tabelle "storia" (mai bloccate da trigger append-only) —
// mai sites/workers/subcontractors/equipment/presence_logs qui.
async function wipeMutableStoryState(companyId) {
  const tables = [
    // chat_messages non ha company_id diretto (solo conversation_id) — ripulita
    // in cascata quando chat_conversations viene cancellata, non va tentata qui.
    'ladia_action_history', 'chat_conversations',
    'worksite_workers',
    'site_notes', 'site_costs', 'site_weather_logs',
    'site_computo_voci', 'site_computo', 'site_sal_history',
    'site_subcontractors',
    'worker_certificates', 'company_documents',
  ];
  for (const t of tables) {
    const { error } = await supabase.from(t).delete().eq('company_id', companyId);
    if (error) console.warn(`  ⚠ wipe ${t}: ${error.message}`);
  }
  // Equipment di test creato da un run precedente di W06 (create_equipment
  // reale) — non ha il vincolo append-only, va ripulito per riscenario "nessun
  // escavatore con quella targa".
  await supabase.from('equipment').delete().eq('company_id', companyId).eq('plate_or_serial', 'AB123CD');
}

async function findOrCreateSite(companyId, row) {
  const { data: existing } = await supabase.from('sites')
    .select('id').eq('company_id', companyId).eq('name', row.name).eq('address', row.address).maybeSingle();
  if (existing) {
    if (row.budget_totale !== undefined) {
      await supabase.from('sites').update({ budget_totale: row.budget_totale }).eq('id', existing.id);
    }
    if (row.sal_percentuale !== undefined) {
      await supabase.from('sites').update({ sal_percentuale: row.sal_percentuale }).eq('id', existing.id);
    }
    return existing.id;
  }
  const { data, error } = await supabase.from('sites').insert({ company_id: companyId, ...row }).select('id').single();
  if (error) throw new Error(`Creazione sito ${row.name} fallita: ` + error.message);
  return data.id;
}

async function findOrCreateWorker(companyId, row) {
  const { data: existing } = await supabase.from('workers')
    .select('id').eq('company_id', companyId).eq('fiscal_code', row.fiscal_code).maybeSingle();
  if (existing) return existing.id;
  const [firstName, ...rest] = row.full_name.split(' ');
  const { data, error } = await supabase.from('workers').insert({
    company_id: companyId, first_name: firstName, last_name: rest.join(' '),
    badge_code: generateBadgeCode(), ...row,
  }).select('id').single();
  if (error) throw new Error(`Creazione worker ${row.full_name} fallita: ` + error.message);
  return data.id;
}

async function findOrCreateSubcontractor(companyId, companyName) {
  const { data: existing } = await supabase.from('subcontractors')
    .select('id').eq('company_id', companyId).eq('company_name', companyName).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supabase.from('subcontractors')
    .insert({ company_id: companyId, company_name: companyName, is_active: true }).select('id').single();
  if (error) throw new Error(`Creazione subappaltatore ${companyName} fallita: ` + error.message);
  return data.id;
}

// Idempotente: non duplica le timbrature ENTRY/EXIT se il run gira più
// volte nello stesso giorno (presence_logs non è cancellabile).
async function ensurePresence(companyId, siteId, workerId, eventType, timestampIso) {
  const day = timestampIso.slice(0, 10);
  const { data: existing } = await supabase.from('presence_logs')
    .select('id').eq('company_id', companyId).eq('site_id', siteId).eq('worker_id', workerId)
    .eq('event_type', eventType).gte('timestamp_server', `${day}T00:00:00Z`).lt('timestamp_server', `${day}T23:59:59Z`)
    .maybeSingle();
  if (existing) return;
  const { error } = await supabase.from('presence_logs').insert({
    company_id: companyId, site_id: siteId, worker_id: workerId,
    event_type: eventType, timestamp_server: timestampIso, method: 'test_fixture',
  });
  if (error) throw new Error(`Insert presence_logs fallito: ${error.message}`);
}

// forScenarioId: se passato, aggiunge SOLO le azioni recenti richieste da
// quello specifico scenario "annullamenti" (vedi step 15) — omesso o null
// per un reset generico senza extra di sessione.
async function resetFixtures(forScenarioId = null) {
  // In modalità "per scenario" (harness, 56 reset per run) i log verbosi di
  // ogni singolo step affogherebbero l'output utile — silenziati, non rimossi:
  // restano tutti quando lo script gira standalone (node setup_fixtures.js).
  const realLog = console.log;
  if (forScenarioId) console.log = () => {};
  try {
    return await resetFixturesVerbose(forScenarioId);
  } finally {
    console.log = realLog;
  }
}

async function resetFixturesVerbose(forScenarioId) {
  console.log(`\n=== Reset fixture TEST-LadiaEvals${forScenarioId ? ' (per ' + forScenarioId + ')' : ''} ===\n`);

  // 1. Company (trova o crea)
  const { data: existingCompany } = await supabase
    .from('companies').select('id').eq('name', COMPANY_NAME).maybeSingle();
  let companyId;
  if (existingCompany) {
    companyId = existingCompany.id;
    console.log(`Company esistente: ${companyId}`);
    await wipeMutableStoryState(companyId);
    console.log('Stato mutabile ripulito (sites/workers/presence_logs riusati, non cancellati).');
  } else {
    const { data: created, error } = await supabase.from('companies').insert({
      name: COMPANY_NAME, account_type: 'impresa',
      subscription_plan: 'business', subscription_status: 'active',
    }).select('id').single();
    if (error) throw new Error('Creazione company fallita: ' + error.message);
    companyId = created.id;
    console.log(`Company creata: ${companyId}`);
  }

  // 2. Utente CI come admin
  // listUsers() senza perPage vede solo i primi 50 utenti (default Supabase) —
  // con 91 utenti reali sulla piattaforma, l'utente CI (creato per primo,
  // quindi "vecchio") può restare fuori dalla prima pagina e sembrare
  // "non trovato" anche se esiste davvero (stesso bug scoperto in F-104).
  const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const ciUser = users?.users?.find(u => u.email === CI_EMAIL);
  if (!ciUser) throw new Error(`Utente CI ${CI_EMAIL} non trovato — eseguire prima scripts/setup-ci-user.js`);
  const { data: membership } = await supabase.from('company_users')
    .select('user_id').eq('company_id', companyId).eq('user_id', ciUser.id).maybeSingle();
  if (!membership) {
    await supabase.from('company_users').insert({ company_id: companyId, user_id: ciUser.id, role: 'admin' });
    console.log('Utente CI aggiunto come admin.');
  } else {
    console.log('Utente CI già admin.');
  }

  // 3. Sites — Aurelia (ricco), Ostia (semplice), Ponza×2 (omonimi, SOLO per A01)
  const sites = {};
  for (const [key, row] of Object.entries({
    // sal_percentuale:15 — riflette il progresso reale già coperto da SAL 1/2
    // (€100k+€120k emessi, sotto), altrimenti emit_sal calcola sempre importo
    // maturato €0 (legge sites.sal_percentuale, non lo storico site_sal_history)
    // e Ladia si rifiuta correttamente di emettere un SAL a valore zero — bug
    // di fixture scambiato per bug di Ladia in M02/D09 (AUDIT.md, 2026-08-08).
    aurelia: { name: 'Aurelia', address: 'Via Aurelia 120', city: 'Roma', status: 'attivo', budget_totale: 700000, sal_percentuale: 15 },
    ostia:   { name: 'Ostia',   address: 'Via delle Baleniere 8', city: 'Roma', status: 'attivo' },
    ponza1:  { name: 'Ponza',  address: 'Via Ponza Centro 4',  city: 'Ponza', status: 'attivo' },
    ponza2:  { name: 'Ponza',  address: 'Via del Porto 12',    city: 'Ponza', status: 'attivo' },
  })) {
    sites[key] = await findOrCreateSite(companyId, row);
  }
  console.log('Sites:', sites);

  // 4. Workers — Mario Rossi, Mario Bianchi (A02), Luigi Bianchi (A06/M05),
  //    + 5 generici per il conteggio presenze di R01.
  const workers = {};
  const workerDefs = {
    marioRossi:   { full_name: 'Mario Rossi',   fiscal_code: 'RSSMRA80A01H501Z' },
    marioBianchi: { full_name: 'Mario Bianchi', fiscal_code: 'BNCMRA82B02H501K' },
    luigiBianchi: { full_name: 'Luigi Bianchi', fiscal_code: 'BNCLGU79C03H501X' },
    g1: { full_name: 'Operaio Test Uno',     fiscal_code: 'OPTUNO01A01H501A' },
    g2: { full_name: 'Operaio Test Due',     fiscal_code: 'OPTDUE02A01H501B' },
    g3: { full_name: 'Operaio Test Tre',     fiscal_code: 'OPTTRE03A01H501C' },
    g4: { full_name: 'Operaio Test Quattro', fiscal_code: 'OPTQUA04A01H501D' },
    g5: { full_name: 'Operaio Test Cinque',  fiscal_code: 'OPTCIN05A01H501E' },
  };
  for (const [key, row] of Object.entries(workerDefs)) {
    workers[key] = await findOrCreateWorker(companyId, row);
  }
  console.log('Workers:', workers);
  console.log('(Giuseppe Verdi NON creato di proposito — D02 chiede di crearlo senza CF)');

  // I lavoratori sono riusati tra un run e l'altro (find-or-create) — uno
  // scenario precedente (M03: "il lavoratore ha lasciato l'azienda") può
  // averli disattivati o modificati davvero. Riportarli allo stato baseline
  // ad ogni reset, altrimenti scenari successivi nello stesso run ereditano
  // lo stato lasciato da uno scenario precedente invece di quello dichiarato
  // nel proprio "stato_iniziale" — bug reale trovato nel primo run (2026-08-06):
  // M05/M08 "non trovavano" Mario Rossi perché M03 lo aveva disattivato poco prima.
  await supabase.from('workers').update({ is_active: true }).eq('company_id', companyId).in('id', Object.values(workers));

  // 5. Assegnazioni cantiere-lavoratore (tabella non bloccata, riseminata da zero).
  //    Mario Rossi su 3 cantieri (Aurelia, Ostia, Ponza1) — richiesto da M03
  //    ("toglilo da tutti i cantieri attivi", deve rimuoverlo da tutti e 3, non solo il primo).
  await mustInsert('worksite_workers', [
    { company_id: companyId, site_id: sites.aurelia, worker_id: workers.luigiBianchi, status: 'active' },
    { company_id: companyId, site_id: sites.ostia,   worker_id: workers.luigiBianchi, status: 'active' },
    { company_id: companyId, site_id: sites.aurelia, worker_id: workers.marioRossi,   status: 'active' },
    { company_id: companyId, site_id: sites.ostia,   worker_id: workers.marioRossi,   status: 'active' },
    { company_id: companyId, site_id: sites.ponza1,  worker_id: workers.marioRossi,   status: 'active' },
    ...['g1', 'g2', 'g3', 'g4', 'g5'].map(k => ({ company_id: companyId, site_id: sites.aurelia, worker_id: workers[k], status: 'active' })),
  ]);

  // 6. Presenze oggi su Aurelia (6 ENTRY, 1 EXIT) — R01. Oggi su Ostia — A03.
  //    Storico 30gg per Mario Rossi — R02. Idempotente: non duplica se rieseguito lo stesso giorno.
  for (const k of ['marioRossi', 'g1', 'g2', 'g3', 'g4', 'g5']) {
    await ensurePresence(companyId, sites.aurelia, workers[k], 'ENTRY', isoAt(8));
  }
  await ensurePresence(companyId, sites.aurelia, workers.g1, 'EXIT', isoAt(17));
  await ensurePresence(companyId, sites.ostia, workers.luigiBianchi, 'ENTRY', isoAt(8));
  for (let i = 3; i <= 28; i += 4) {
    await ensurePresence(companyId, sites.aurelia, workers.marioRossi, 'ENTRY', isoAt(8, -i));
    await ensurePresence(companyId, sites.aurelia, workers.marioRossi, 'EXIT', isoAt(17, -i));
  }

  // 7. site_costs su Aurelia (4 righe) — R06
  await mustInsert('site_costs', [
    { company_id: companyId, site_id: sites.aurelia, descrizione: 'Noleggio gru', importo: 4500, fornitore: 'GruService Srl' },
    { company_id: companyId, site_id: sites.aurelia, descrizione: 'Cemento e inerti', importo: 3200, fornitore: 'Cave Laziali' },
    { company_id: companyId, site_id: sites.aurelia, descrizione: 'Ponteggio esterno', importo: 2100, fornitore: 'Ponteggi Rossi' },
    { company_id: companyId, site_id: sites.aurelia, descrizione: 'Manodopera extra', importo: 1800, fornitore: 'Coop. Edile' },
  ]);

  // 8. site_notes: 1 NC aperta su Aurelia (W07), la nota di W01 nasce fresca in conversazione
  await mustInsert('site_notes', {
    company_id: companyId, site_id: sites.aurelia, category: 'non_conformita', urgency: 'alta',
    content: 'Scala portatile non a norma sul ponteggio est', author_name: 'Fixture eval',
  });

  // 9. Subappaltatori — Elettrica Rossi + Idraulica Verdi su Aurelia, Carpenteria Neri su Ostia,
  //    Idraulica Bianchi non assegnata (W09)
  const subs = {};
  for (const name of ['Elettrica Rossi', 'Idraulica Verdi', 'Carpenteria Neri', 'Idraulica Bianchi']) {
    const key = name.replace(/\s+/g, '');
    subs[key] = await findOrCreateSubcontractor(companyId, name);
  }
  await mustInsert('site_subcontractors', [
    { company_id: companyId, site_id: sites.aurelia, subcontractor_id: subs['ElettricaRossi'] },
    { company_id: companyId, site_id: sites.aurelia, subcontractor_id: subs['IdraulicaVerdi'] },
    { company_id: companyId, site_id: sites.ostia,   subcontractor_id: subs['CarpenteriaNeri'] },
  ]);
  console.log('Subappaltatori:', subs);

  // 10. SAL — Aurelia #1,#2 pagati (M02); Ostia #3 non pagato (W04)
  await mustInsert('site_sal_history', [
    { company_id: companyId, site_id: sites.aurelia, sal_number: 1, importo_maturato: 100000, data_emissione: daysFromNow(-60), pagato_il: daysFromNow(-50) },
    { company_id: companyId, site_id: sites.aurelia, sal_number: 2, importo_maturato: 120000, data_emissione: daysFromNow(-30), pagato_il: daysFromNow(-20) },
    { company_id: companyId, site_id: sites.ostia,   sal_number: 3, importo_maturato: 80000,  data_emissione: daysFromNow(-5),  pagato_il: null },
  ]);

  // 11. Meteo ieri su Aurelia (R08)
  await mustInsert('site_weather_logs', {
    company_id: companyId, site_id: sites.aurelia, log_date: daysFromNow(-1),
    precipitation_mm: 2.4, wind_max_kmh: 18, temp_min_c: 14, temp_max_c: 22, weather_desc: 'Pioggia debole',
  });

  // 12. Computo base + voci — Aurelia (scavi ambigue per A08/D06, calcestruzzo per M06),
  //     stessa voce su Ostia e Ponza1 per completare M06 (3 cantieri)
  for (const [siteKey, siteId] of [['aurelia', sites.aurelia], ['ostia', sites.ostia], ['ponza1', sites.ponza1]]) {
    const { data: computo, error } = await supabase.from('site_computo').insert({
      company_id: companyId, site_id: siteId, nome: 'Computo base', tipo: 'base', totale_contratto: 500000,
    }).select('id').single();
    if (error) throw new Error(`Creazione computo ${siteKey} fallita: ` + error.message);
    const voci = [
      { descrizione: 'Calcestruzzo C25/30', unita_misura: 'mc', quantita: 100, prezzo_unitario: 120, importo: 12000 },
    ];
    if (siteKey === 'aurelia') {
      voci.push(
        { descrizione: 'Scavi di sbancamento', unita_misura: 'mc', quantita: 200, prezzo_unitario: 15, importo: 3000 },
        { descrizione: 'Scavi a sezione ristretta', unita_misura: 'mc', quantita: 50, prezzo_unitario: 22, importo: 1100 },
      );
    }
    await mustInsert('site_computo_voci', voci.map(v => ({
      company_id: companyId, site_id: siteId, computo_id: computo.id, tipo: 'voce', ...v,
    })));
  }

  // 13. Certificati lavoratori in scadenza entro 60gg (R09) — 2 su 5 lavoratori generici,
  //     ENTRAMBI di tipo Antincendio (lo scenario chiede esplicitamente "chi ha il
  //     certificato antincendio" — senza course_type_id il tipo risulta "N/D" e Ladia
  //     rifiuta correttamente di rispondere, bug di fixture scambiato per bug di Ladia).
  const { data: antincendioType } = await supabase.from('course_types')
    .select('id').ilike('name', 'Antincendio%').limit(1).single();
  await mustInsert('worker_certificates', [
    { company_id: companyId, worker_id: workers.g1, course_type_id: antincendioType.id, issue_date: daysFromNow(-300), expiry_date: daysFromNow(20), issuing_body: 'Ente Formazione Test', certificate_number: 'CERT-EVAL-001' },
    { company_id: companyId, worker_id: workers.g2, course_type_id: antincendioType.id, issue_date: daysFromNow(-300), expiry_date: daysFromNow(45), issuing_body: 'Ente Formazione Test', certificate_number: 'CERT-EVAL-002' },
  ]);

  // 14. Documenti aziendali con scadenze (R04) — 2 entro 30gg, 1 oltre
  await mustInsert('company_documents', [
    { company_id: companyId, name: 'DURC Test', category: 'durc', file_path: 'test/durc.pdf', ai_expiry_date: daysFromNow(5) },
    { company_id: companyId, name: 'Polizza RC Test', category: 'polizza', file_path: 'test/polizza.pdf', ai_expiry_date: daysFromNow(25) },
    { company_id: companyId, name: 'Visura Camerale Test', category: 'visura', file_path: 'test/visura.pdf', ai_expiry_date: daysFromNow(45) },
  ]);

  // 15. Azioni recenti pre-seedate SOLO per lo scenario "annullamenti" che sta
  //     per girare (U02/U05/U06/U08 dichiarano un'azione fatta poco prima
  //     nella stessa sessione — il nostro harness invia UN solo messaggio per
  //     scenario, non simula un multi-turno reale, quindi l'azione "appena
  //     fatta" va creata qui). Condizionato a `forScenarioId` — mai per gli
  //     altri scenari (U01/U03/U07 dipendono esplicitamente dal NON vedere
  //     nessuna azione recente; get_recent_actions è scoped per company/
  //     finestra temporale, non per conversazione, quindi seedare questi
  //     sempre romperebbe quelli — trovato nel primo run, 2026-08-06).
  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

  if (forScenarioId === 'U04') {
    // "l'ultima azione della sessione è un emit_sal già confermato e scritto"
    const { data: sal } = await supabase.from('site_sal_history')
      .select('id, importo_maturato').eq('site_id', sites.aurelia).eq('sal_number', 2).single();
    await mustInsert('ladia_action_history', {
      company_id: companyId, user_id: ciUser.id, resource: 'site_sal_history', table_name: 'site_sal_history',
      pk_column: 'id', record_id: sal.id, action: 'create',
      // F-112 (AUDIT.md): un vero emit_sal registra changed_fields col
      // record intero (incluso importo_maturato, sensitivity 'medium' in
      // ladiaSchemaRegistry.js) — senza questo campo qui, undoActionGated()
      // calcola sensitivity 'low' (nessuna chiave presente) e il gate non
      // scatta mai: lo scenario non testerebbe la condizione reale che
      // vuole verificare. Trovato riverificando U04 dal vivo in produzione
      // subito dopo il fix, con esattamente questo fixture.
      changed_fields: { importo_maturato: sal.importo_maturato },
      summary: 'Emesso SAL 2', created_at: minutesAgo(1),
    });
  }

  if (forScenarioId === 'U02') {
    const { data: u02Note, error } = await supabase.from('site_notes').insert({
      company_id: companyId, site_id: sites.aurelia, category: 'nota', urgency: 'normale',
      content: 'Nota di test per scenario U02', author_name: 'Fixture eval',
    }).select('id').single();
    if (error) throw new Error('Creazione nota U02 fallita: ' + error.message);
    await mustInsert('ladia_action_history', {
      company_id: companyId, user_id: ciUser.id, resource: 'site_notes', table_name: 'site_notes',
      pk_column: 'id', record_id: u02Note.id, action: 'create',
      summary: 'Creato: site_notes', created_at: minutesAgo(0.5),
    });
  }

  if (forScenarioId === 'U05') {
    const { data: u05Phase, error } = await supabase.from('site_phases').insert({
      company_id: companyId, site_id: sites.aurelia, nome: 'Fase Test U05', stato: 'non_iniziata',
    }).select('id').single();
    if (error) throw new Error('Creazione fase U05 fallita: ' + error.message);
    await mustInsert('ladia_action_history', {
      company_id: companyId, user_id: ciUser.id, resource: 'site_phases', table_name: 'site_phases',
      pk_column: 'id', record_id: u05Phase.id, action: 'create',
      summary: 'Creata fase: Fase Test U05', created_at: minutesAgo(2),
    });
  }

  if (forScenarioId === 'U06') {
    // I valori ATTUALI del worker devono combaciare con changed_fields,
    // altrimenti undo_action rifiuta con SNAPSHOT_MANCANTE (comportamento
    // corretto del sistema, non va aggirato).
    await supabase.from('workers').update({
      qualification: 'Muratore specializzato', employer_name: 'Coop Edile Test',
    }).eq('id', workers.marioRossi);
    await mustInsert('ladia_action_history', [
      {
        company_id: companyId, user_id: ciUser.id, resource: 'workers', table_name: 'workers',
        pk_column: 'id', record_id: workers.marioRossi, action: 'update',
        changed_fields: { qualification: 'Muratore specializzato' }, previous_values: { qualification: null },
        summary: 'Modificato: workers — Mario Rossi (qualifica)', created_at: minutesAgo(5),
      },
      {
        company_id: companyId, user_id: ciUser.id, resource: 'workers', table_name: 'workers',
        pk_column: 'id', record_id: workers.marioRossi, action: 'update',
        changed_fields: { employer_name: 'Coop Edile Test' }, previous_values: { employer_name: null },
        summary: 'Modificato: workers — Mario Rossi (datore lavoro)', created_at: minutesAgo(3),
      },
    ]);
  }

  if (forScenarioId === 'U08') {
    const { data: u08Note } = await supabase.from('site_notes').insert({
      company_id: companyId, site_id: sites.aurelia, category: 'nota', urgency: 'normale',
      content: 'Nota di test per scenario U08', author_name: 'Fixture eval',
    }).select('id').single();
    const { data: u08Phase } = await supabase.from('site_phases').insert({
      company_id: companyId, site_id: sites.aurelia, nome: 'Fase Test U08', stato: 'non_iniziata',
    }).select('id').single();
    const { data: u08Sal } = await supabase.from('site_sal_history')
      .select('id').eq('site_id', sites.aurelia).eq('sal_number', 1).single();
    await mustInsert('ladia_action_history', [
      { company_id: companyId, user_id: ciUser.id, resource: 'site_notes', table_name: 'site_notes', pk_column: 'id', record_id: u08Note.id, action: 'create', summary: 'Creato: site_notes', created_at: minutesAgo(8) },
      { company_id: companyId, user_id: ciUser.id, resource: 'site_phases', table_name: 'site_phases', pk_column: 'id', record_id: u08Phase.id, action: 'create', summary: 'Creata fase: Fase Test U08', created_at: minutesAgo(5) },
      { company_id: companyId, user_id: ciUser.id, resource: 'site_sal_history', table_name: 'site_sal_history', pk_column: 'id', record_id: u08Sal.id, action: 'update', summary: 'Modificato: SAL', created_at: minutesAgo(2) },
    ]);
  }

  // M05 ("Crea il cantiere 'Via Tiburtina 45'...") presuppone che il cantiere
  // NON esista ancora — ma una volta che Ladia lo crea davvero in un run, il
  // sito sopravvive per sempre (sites non è mai hard-deletabile per il
  // vincolo append-only su presence_logs, vedi wipeMutableStoryState sopra),
  // quindi ogni run successivo lo trova già esistente e lo scenario non può
  // più testare una vera creazione (bug di fixture scambiato per bug di
  // Ladia in M05, AUDIT.md 2026-08-08). "Via Tiburtina 45" non è un cantiere
  // fixture intenzionale come Aurelia/Ostia/Ponza — è sicuro hard-deletarlo
  // (mai usato per timbrature) prima di ogni run di questo scenario.
  if (forScenarioId === 'M05') {
    const { data: stale } = await supabase.from('sites')
      .select('id').eq('company_id', companyId).eq('name', 'Via Tiburtina 45').maybeSingle();
    if (stale) {
      await supabase.from('worksite_workers').delete().eq('site_id', stale.id);
      await supabase.from('ladia_action_history').delete().eq('record_id', stale.id);
      await supabase.from('sites').delete().eq('id', stale.id);
    }
  }

  const result = { companyId, sites, workers, subs };
  console.log('\n=== Fixture pronte ===');
  console.log(JSON.stringify(result, null, 2));

  require('fs').writeFileSync(
    require('path').join(__dirname, '.fixture_ids.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}

module.exports = { resetFixtures };

if (require.main === module) {
  resetFixtures().catch(e => { console.error('Errore fatale:', e.message); process.exit(1); });
}
