#!/usr/bin/env node
/**
 * scripts/selftest_f501_visura_tipo_impresa.js
 *
 * Regressione per F-501 (AUDIT.md del frontend, 15/11/2026): dalla sola visura Palladia
 * deve capire che impresa è e quindi cosa chiederle per legge (All. XVII D.Lgs. 81/2008).
 * Prima:
 *  - all'impresa familiare non si chiedevano attrezzature e DPI (art. 21, art. 3 c.12,
 *    INL FAQ patente n. 24, interpello 3/2015);
 *  - una ditta individuale con titolare + familiari (2 indipendenti, 0 dipendenti) diventava
 *    «ha operai» (DVR chiesto, attrezzature e DPI no); un'impresa familiare con dipendenti
 *    restava «familiare» (DVR mancante);
 *  - una visura di un'impresa cessata, in liquidazione o fallita «andava bene»;
 *  - l'attività scritta in visura non si guardava mai (oggetto sociale inerente);
 *  - la visura caricata da «Carica documenti delle imprese» e da «+ Aggiungi impresa» non
 *    diceva il tipo;
 *  - se il titolare aveva scelto un tipo diverso da quello della visura, nessuno lo sapeva.
 *
 * 1. Puro: lettura, tipo, giudizio, richieste.  2. Dal vivo (DB di produzione, lettura del
 * modello finta: nessun credito speso): la visura caricata cambia tipo e richieste, una visura
 * di impresa cessata non va, il titolare vince ma la scheda dice cosa dice la visura.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY o SUPABASE_KEY.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '') + '/api/v1';
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const oggi = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

// Una risposta del modello su una visura, come la darebbe davvero (stringhe comprese)
const visura = (x = {}) => ({
  tipo: 'visura', ragione_sociale: 'TEST-F501 Rossi Mario', partita_iva: '01234567890', sede: 'Via Roma 1, Genova',
  data_documento: oggi, scadenza: null, firmato: null, forma_giuridica: 'impresa individuale',
  addetti: '2', addetti_dipendenti: '0', addetti_indipendenti: '2', familiari: true,
  stato_attivita: 'ATTIVA', ateco: ['43.34.00'], attivita_edile: true, ...x,
});

async function main() {
  console.log('\nPalladia regression — F-501: dalla visura che impresa è e cosa chiederle\n');
  const { tipoDaVisura } = require('../lib/impreseTipo');
  const V = require('../lib/visuraLegge');
  const C = require('../lib/impreseControllo');
  const lettura = require('../lib/impreseCarica/lettura');
  const { requirementsFor } = require('../lib/documentiStato');
  const chiavi = (row) => requirementsFor('subappaltatori', row).map(r => r.key).sort().join(',');

  // Il tipo
  const T = (x) => tipoDaVisura({ formaGiuridica: 'impresa individuale', ...x });
  check('SRL unipersonale con 0 dipendenti → ha operai (il socio che lavora è lavoratore, art. 2)', tipoDaVisura({ formaGiuridica: 'società a responsabilità limitata con unico socio', dipendenti: 0, indipendenti: 1 }) === 'con_operai');
  check('«S.R.L.» abbreviato → ha operai', tipoDaVisura({ formaGiuridica: 'S.R.L.' }) === 'con_operai');
  check('SNC → ha operai', tipoDaVisura({ formaGiuridica: 'società in nome collettivo' }) === 'con_operai');
  check('cooperativa → ha operai', tipoDaVisura({ formaGiuridica: 'piccola società cooperativa' }) === 'con_operai');
  check('ditta individuale: 0 dipendenti, 1 indipendente → da solo', T({ dipendenti: 0, indipendenti: 1, addetti: 1 }) === 'da_solo');
  check('ditta individuale: 0 dipendenti, 2 indipendenti → impresa familiare (prima: ha operai)', T({ dipendenti: 0, indipendenti: 2, addetti: 2 }) === 'familiare');
  check('ditta individuale: 0 dipendenti, familiari nominati → impresa familiare', T({ dipendenti: 0, indipendenti: 1, familiari: true }) === 'familiare');
  check('ditta individuale con familiari E 2 dipendenti → ha operai', T({ dipendenti: 2, indipendenti: 2, familiari: true }) === 'con_operai');
  check('«impresa familiare» con 1 dipendente → ha operai (prima: familiare, DVR mancante)', tipoDaVisura({ formaGiuridica: 'impresa familiare', dipendenti: 1 }) === 'con_operai');
  check('addetti 5 di cui 2 indipendenti → 3 dipendenti → ha operai', T({ addetti: 5, indipendenti: 2 }) === 'con_operai');
  check('solo «addetti 1» → da solo', T({ addetti: 1 }) === 'da_solo');
  check('solo «addetti 1» ma con familiari → non decido', T({ addetti: 1, familiari: true }) === null);
  check('ditta individuale senza addetti → non decido (resta «ha operai» finché il titolare non sceglie)', T({}) === null);
  check('forma che non conosco → non decido', tipoDaVisura({ formaGiuridica: 'associazione', dipendenti: 0 }) === null);

  // Lo stato e l'attività
  const S = V.statoDi;
  check('stato: ATTIVA / inattiva / cessata / in liquidazione / liquidazione giudiziale / fallimento / concordato',
    S('ATTIVA') === 'attiva' && S('Impresa inattiva') === 'inattiva' && S('cessata il 12/03/2024') === 'cessata' && S('in liquidazione') === 'liquidazione'
    && S('liquidazione giudiziale') === 'procedura' && S('Fallimento') === 'procedura' && S('concordato preventivo') === null,
    ['ATTIVA', 'Impresa inattiva', 'cessata il 12/03/2024', 'in liquidazione', 'liquidazione giudiziale', 'Fallimento', 'concordato preventivo'].map(S));
  check('ATECO letti anche da un testo', V.atecoDi('Codice: 43.21.01 - installazione impianti; 43.22') .join() === '43.21.01,43.22', V.atecoDi('Codice: 43.21.01 - installazione impianti; 43.22'));

  // Il giudizio sulla visura
  const ctx = { impresa: { nome: 'TEST-F501 Rossi Mario', piva: '01234567890' }, oggi };
  const g = (x) => C.giudica('visura', C.pulisci(visura(x)), ctx);
  check('visura attiva, edile → va bene', g().esito === 'va_bene', g());
  check('impresa cessata → non va (prima: andava bene)', g({ stato_attivita: 'CESSATA' }).esito === 'non_va' && g({ stato_attivita: 'CESSATA' }).motivo.codice === 'impresa_non_attiva', g({ stato_attivita: 'CESSATA' }).motivo);
  check('impresa in liquidazione → non va', g({ stato_attivita: 'in liquidazione' }).motivo?.codice === 'impresa_non_attiva');
  check('impresa fallita → non va', g({ stato_attivita: 'fallimento' }).motivo?.valore === 'procedura');
  check('attività 47.11 (commercio) e il modello dice «non edile» → non va', g({ ateco: ['47.11.40'], attivita_edile: false }).motivo?.codice === 'attivita_non_inerente');
  check('ATECO 47.11 ma il modello non è sicuro → va bene (mai scartare per un dubbio)', g({ ateco: ['47.11.40'], attivita_edile: null }).esito === 'va_bene');
  check('ATECO 71.12 (ingegneria) anche con «non edile» → va bene', g({ ateco: ['71.12.10'], attivita_edile: false }).esito === 'va_bene');
  check('il motivo in italiano per il titolare', /cessata/.test(C.motivoItaliano({ codice: 'impresa_non_attiva', valore: 'cessata' })) && /ATECO 47\.11/.test(C.motivoItaliano({ codice: 'attivita_non_inerente', valore: '47.11' })));

  // La lettura: stessi campi da tutte le strade
  const p = C.pulisci(visura());
  check('link e scheda: la lettura porta dipendenti, indipendenti, familiari, stato, ATECO', p.dipendenti === 0 && p.indipendenti === 2 && p.familiari === true && p.statoAttivita === 'ATTIVA' && p.ateco.join() === '43.34.00' && p.attivitaEdile === true, p);
  const b = lettura.pulisci(visura());
  check('«Carica documenti delle imprese»: la lettura porta gli stessi campi', b.dipendenti === 0 && b.indipendenti === 2 && b.familiari === true && tipoDaVisura(b) === 'familiare', b);
  check('i due prompt chiedono dipendenti, familiari, stato e ATECO', [C.PROMPT, lettura.PROMPT || ''].every(t => !t || (t.includes('addetti_dipendenti') && t.includes('stato_attivita') && t.includes('ateco'))));

  // Le richieste
  check('impresa familiare → attrezzature e DPI, niente DVR (prima: solo visura, DURC, patente)', chiavi({ tipo_impresa: 'familiare' }) === 'assicurazione,attrezzature,dpi,durc,patente,visura', chiavi({ tipo_impresa: 'familiare' }));

  // «+ Aggiungi impresa» dalla foto della visura
  const I = require('../lib/imprese');
  const fintaFoto = { buffer: Buffer.from('x'), mimetype: 'image/jpeg' };
  let r = await I.leggiPerAggiungere('00000000-0000-0000-0000-000000000000', fintaFoto, async () => visura({ partita_iva: null }));
  check('«+ Aggiungi impresa»: la foto della visura dice anche il tipo', r.tipoImpresa === 'familiare' && r.avviso === null, r);
  r = await I.leggiPerAggiungere('00000000-0000-0000-0000-000000000000', fintaFoto, async () => visura({ partita_iva: null, stato_attivita: 'cessata' }));
  check('«+ Aggiungi impresa»: visura di impresa cessata → avviso', r.avviso?.codice === 'impresa_non_attiva' && /cessata/.test(r.avviso.testo), r.avviso);

  const URL_ = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!URL_ || !SERVICE || !ANON) { console.log('  – skip parte dal vivo: env mancante'); return fine(); }
  const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const L = require('../lib/impreseLink');
  const { data: co } = await admin.from('companies').insert([{ name: 'TEST-F501-VisuraTipo' }]).select('id').single();
  const CO = co.id; let userId = null;
  try {
    await admin.from('company_feature_flags').upsert({ company_id: CO, feature: 'subappaltatori', enabled: true }, { onConflict: 'company_id,feature' });
    const email = `test-f501-${crypto.randomUUID()}@example.com`;
    const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
    userId = u.user.id;
    await admin.from('company_users').insert([{ company_id: CO, user_id: userId, role: 'owner' }]);
    const { data: link0 } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const { data: ses } = await anon.auth.verifyOtp({ token_hash: link0.properties.hashed_token, type: 'magiclink' });
    const H = { Authorization: `Bearer ${ses.session.access_token}`, 'X-Company-Id': CO, 'Content-Type': 'application/json' };
    const owner = async (method, path, body) => { const res = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await res.json(); } catch { /* */ } return { status: res.status, body: j }; };
    const keys = (s) => (s?.requisiti || []).map(x => x.key).sort().join(',');

    const { data: sub } = await admin.from('subcontractors').insert({ company_id: CO, company_name: 'TEST-F501 Rossi Mario', piva: '01234567890', is_active: true }).select('id').single();
    const file = { buffer: Buffer.from('%PDF-1.4 finta'), mimetype: 'application/pdf', originalname: 'visura.pdf', size: 14 };
    let esito = await L.caricaDalTitolare(CO, userId, sub.id, { tipo: 'visura', file }, async () => visura());
    let row = (await admin.from('subcontractors').select('tipo_impresa, tipo_da, tipo_visura').eq('id', sub.id).single()).data;
    check('dal vivo: visura di ditta con titolare + familiare → «impresa familiare» dalla visura', esito.esito === 'va_bene' && row.tipo_impresa === 'familiare' && row.tipo_da === 'visura' && row.tipo_visura === 'familiare', { esito, row });
    let s = await owner('GET', `/imprese/${sub.id}/scheda`);
    check('dal vivo: la scheda chiede attrezzature e DPI, niente DVR', s.status === 200 && keys(s.body) === 'assicurazione,attrezzature,dpi,durc,patente,visura' && s.body.tipo?.visura === 'familiare', { status: s.status, keys: keys(s.body), tipo: s.body?.tipo });

    // Il titolare sceglie diversamente: vince, ma la scheda dice cosa dice la visura
    await owner('POST', `/imprese/${sub.id}/tipo`, { tipo: 'da_solo' });
    await L.caricaDalTitolare(CO, userId, sub.id, { tipo: 'visura', file }, async () => visura({ addetti: '4', addetti_dipendenti: '2' }));
    row = (await admin.from('subcontractors').select('tipo_impresa, tipo_da, tipo_visura').eq('id', sub.id).single()).data;
    check('dal vivo: il titolare vince, ma la visura nuova (2 dipendenti) resta scritta', row.tipo_impresa === 'da_solo' && row.tipo_da === 'titolare' && row.tipo_visura === 'con_operai', row);
    s = await owner('GET', `/imprese/${sub.id}/scheda`);
    check('dal vivo: la scheda dà «usato» e «visura» diversi (il titolare viene avvisato)', s.body?.tipo?.usato === 'da_solo' && s.body?.tipo?.visura === 'con_operai', s.body?.tipo);

    // Impresa cessata
    esito = await L.caricaDalTitolare(CO, userId, sub.id, { tipo: 'visura', file }, async () => visura({ stato_attivita: 'CESSATA' }));
    check('dal vivo: visura di impresa cessata → non va, con il motivo', esito.esito === 'non_va' && esito.motivo?.codice === 'impresa_non_attiva', esito);

    // «+ Aggiungi impresa» col tipo letto
    const n = await owner('POST', '/imprese', { nome: 'TEST-F501 Bianchi Luca', piva: '09876543210', tipoImpresa: 'familiare' });
    const nrow = n.body?.id ? (await admin.from('subcontractors').select('tipo_impresa, tipo_da').eq('id', n.body.id).single()).data : null;
    check('dal vivo: «+ Aggiungi impresa» salva il tipo letto dalla visura', n.status === 201 && nrow?.tipo_impresa === 'familiare' && nrow?.tipo_da === 'visura', { n, nrow });
    const m = await owner('POST', '/imprese', { nome: 'TEST-F501 Verdi', piva: '09876543211', tipoImpresa: 'inventato' });
    const mrow = m.body?.id ? (await admin.from('subcontractors').select('tipo_impresa').eq('id', m.body.id).single()).data : null;
    check('dal vivo: un tipo inventato non entra', m.status === 201 && mrow?.tipo_impresa === null, { m, mrow });
  } finally {
    const { data: docs } = await admin.from('subcontractor_documents').select('file_path').eq('company_id', CO);
    const paths = (docs || []).map(d => d.file_path).filter(Boolean);
    if (paths.length) await admin.storage.from(L.BUCKET).remove(paths).catch(() => {});
    await admin.from('subcontractor_documents').delete().eq('company_id', CO);
    await admin.from('sub_doc_promesse').delete().eq('company_id', CO);
    await admin.from('sub_link').delete().eq('company_id', CO);
    await admin.from('subcontractors').delete().eq('company_id', CO);
    await admin.from('company_feature_flags').delete().eq('company_id', CO);
    await admin.from('company_users').delete().eq('company_id', CO);
    await admin.from('companies').delete().eq('id', CO);
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
  return fine();
}
function fine() { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = failed > 0 ? 1 : 0; }
main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 300));
