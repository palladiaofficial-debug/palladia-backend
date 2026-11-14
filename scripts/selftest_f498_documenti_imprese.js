#!/usr/bin/env node
/**
 * scripts/selftest_f498_documenti_imprese.js
 *
 * Regressione per F-498 (AUDIT.md del frontend, 14/11/2026): la pagina che
 * riceve l'impresa chiedeva «DVR o autocertificazione» (superata dal 2013), non
 * distingueva il tipo d'impresa se non con una casella, non permetteva di dire
 * «non ce l'ho / lo faccio entro…», e il link non scadeva mai.
 *
 * 1. Puro: cosa si chiede a chi (con operai, da solo, impresa familiare) e il
 *    tipo letto dalla visura.
 * 2. Dal vivo (API di produzione): il titolare cambia il tipo e la pagina
 *    dell'impresa cambia le richieste; «Lo faccio entro una settimana» e
 *    «non lo so ancora» arrivano al titolare; il link fermo da 61 giorni dà
 *    410 e se ne fa uno nuovo; il link ritirato dà 404; la visura decide il
 *    tipo solo se il titolare non l'ha scelto.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY o SUPABASE_KEY, PIN_SIGNING_SECRET.
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
const romaGiorno = (n = 0) => { const d = new Date(`${new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function main() {
  console.log('\nPalladia regression — F-498: documenti delle imprese chiesti giusti\n');

  // 1. Puro
  const { requirementsFor, REQUIREMENTS } = require('../lib/documentiStato');
  const { tipoDaVisura } = require('../lib/impreseTipo');
  const chiavi = (row) => requirementsFor('subappaltatori', row).map(r => r.key).sort().join(',');
  check('con operai: visura, DURC, patente, DVR, dichiarazione (+ assicurazione facoltativa)', chiavi({ tipo_impresa: 'con_operai' }) === 'assicurazione,dichiarazione,durc,dvr,patente,visura', chiavi({ tipo_impresa: 'con_operai' }));
  check('da solo: niente DVR né dichiarazione; attrezzature e DPI', chiavi({ tipo_impresa: 'da_solo' }) === 'assicurazione,attrezzature,dpi,durc,patente,visura', chiavi({ tipo_impresa: 'da_solo' }));
  check('impresa familiare: solo visura, DURC, patente (attrezzature e DPI aspettano il consulente)', chiavi({ tipo_impresa: 'familiare' }) === 'assicurazione,durc,patente,visura', chiavi({ tipo_impresa: 'familiare' }));
  check('tipo non noto: come con operai (come prima)', chiavi({}) === chiavi({ tipo_impresa: 'con_operai' }));
  check('il vecchio flag autonomo vale ancora «da solo»', chiavi({ autonomo: true }) === chiavi({ tipo_impresa: 'da_solo' }));
  const dvr = REQUIREMENTS.subappaltatori.find(r => r.key === 'dvr');
  check('si chiede «DVR», non più «DVR o autocertificazione»', dvr.label === 'DVR' && !dvr.cats('autocertificazione_dvr'), dvr.label);
  check('visura SRLS → con operai', tipoDaVisura({ formaGiuridica: 'società a responsabilità limitata semplificata', addetti: 0 }) === 'con_operai');
  check('visura ditta individuale con 0 addetti → da solo', tipoDaVisura({ formaGiuridica: 'impresa individuale', addetti: 0 }) === 'da_solo');
  check('visura ditta individuale con 3 addetti → con operai', tipoDaVisura({ formaGiuridica: 'impresa individuale', addetti: 3 }) === 'con_operai');
  check('visura ditta individuale senza addetti scritti → non decido', tipoDaVisura({ formaGiuridica: 'impresa individuale', addetti: null }) === null);
  check('visura impresa familiare → familiare', tipoDaVisura({ formaGiuridica: 'impresa familiare', addetti: 2 }) === 'familiare');

  const URL_ = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!URL_ || !SERVICE || !ANON || !process.env.PIN_SIGNING_SECRET) { console.log('  – skip parte dal vivo: env mancante'); return fine(); }
  const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const L = require('../lib/impreseLink');
  const { data: co } = await admin.from('companies').insert([{ name: 'TEST-F498-DocumentiImprese' }]).select('id').single();
  const CO = co.id; let userId = null;
  try {
    await admin.from('company_feature_flags').upsert({ company_id: CO, feature: 'subappaltatori', enabled: true }, { onConflict: 'company_id,feature' });
    const email = `test-f498-${crypto.randomUUID()}@example.com`;
    const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
    userId = u.user.id;
    await admin.from('company_users').insert([{ company_id: CO, user_id: userId, role: 'owner' }]);
    const { data: link0 } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const { data: ses } = await anon.auth.verifyOtp({ token_hash: link0.properties.hashed_token, type: 'magiclink' });
    const H = { Authorization: `Bearer ${ses.session.access_token}`, 'X-Company-Id': CO, 'Content-Type': 'application/json' };
    const { data: sub } = await admin.from('subcontractors').insert({ company_id: CO, company_name: 'TEST-F498 Massetti SRLS', is_active: true }).select('id').single();
    let { url } = await L.linkImpresa(CO, sub.id, userId);
    let token = url.split('/impresa/')[1];
    const pub = async (path = '', init) => { const r = await fetch(`${BASE}/impresa-link/${token}${path}`, init); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b }; };
    const owner = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b }; };
    const keys = (b) => (b?.richieste || []).map(r => r.key).sort().join(',');

    let r = await pub();
    check('link: impresa nuova → richieste come con operai, con «DVR»', r.status === 200 && keys(r.body) === 'assicurazione,dichiarazione,durc,dvr,patente,visura' && r.body.richieste.find(x => x.key === 'dvr').label === 'DVR', r.body && keys(r.body));
    check('link: dice quanti giorni dura senza uso (60)', r.body?.giorniLink === 60, r.body?.giorniLink);

    r = await owner('POST', `/imprese/${sub.id}/tipo`, { tipo: 'da_solo' });
    check('il titolare dice «lavora da solo» → ok', r.status === 200, r);
    r = await pub();
    check('link: ora chiede attrezzature e DPI, niente DVR né dichiarazione', keys(r.body) === 'assicurazione,attrezzature,dpi,durc,patente,visura' && r.body.tipo === 'da_solo', keys(r.body));
    r = await owner('POST', `/imprese/${sub.id}/tipo`, { tipo: 'estero' });
    check('tipo non previsto → 400', r.status === 400, r);
    r = await owner('POST', `/imprese/${sub.id}/tipo`, { tipo: 'familiare' });
    r = await pub();
    check('impresa familiare → visura, DURC, patente', keys(r.body) === 'assicurazione,durc,patente,visura', keys(r.body));
    await owner('POST', `/imprese/${sub.id}/tipo`, { tipo: 'con_operai' });

    // La visura decide solo se il titolare non ha scelto
    await L.tipoDallaVisura(sub.id, { formaGiuridica: 'impresa individuale', addetti: 0 });
    let row = (await admin.from('subcontractors').select('tipo_impresa, tipo_da').eq('id', sub.id).single()).data;
    check('la visura non cambia il tipo scelto dal titolare', row.tipo_impresa === 'con_operai' && row.tipo_da === 'titolare', row);
    await admin.from('subcontractors').update({ tipo_impresa: null, tipo_da: null }).eq('id', sub.id);
    await L.tipoDallaVisura(sub.id, { formaGiuridica: 'impresa individuale', addetti: 0 });
    row = (await admin.from('subcontractors').select('tipo_impresa, tipo_da, autonomo').eq('id', sub.id).single()).data;
    check('senza scelta del titolare, la visura dice «da solo»', row.tipo_impresa === 'da_solo' && row.tipo_da === 'visura' && row.autonomo === true, row);
    await owner('POST', `/imprese/${sub.id}/tipo`, { tipo: 'con_operai' });

    // Promesse
    r = await pub('/promessa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'patente', quando: '1w' }) });
    check('«Non ce l\'ho» patente → «entro una settimana»', r.status === 200 && r.body?.entro === romaGiorno(7), r);
    r = await pub('/promessa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'dvr', quando: 'nonso' }) });
    check('DVR → «non lo so ancora» (entro vuoto)', r.status === 200 && r.body?.entro === null, r);
    r = await pub('/promessa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'patente', quando: 'domani' }) });
    check('quando non previsto → 400', r.status === 400, r);
    r = await pub('/promessa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'stipendi', quando: '1w' }) });
    check('documento non previsto → 400', r.status === 400, r);
    r = await pub();
    const pp = r.body?.richieste?.find(x => x.key === 'patente'), pd = r.body?.richieste?.find(x => x.key === 'dvr');
    check('link: la patente porta la promessa (entro +7), il DVR «non lo so»', pp?.promessa?.entro === romaGiorno(7) && pd?.promessa && pd.promessa.entro === null, { pp: pp?.promessa, pd: pd?.promessa });
    r = await owner('GET', `/imprese/${sub.id}/scheda`);
    const sp = r.body?.requisiti?.find(x => x.key === 'patente');
    check('scheda del titolare: vede la promessa della patente e il tipo', sp?.promessa?.entro === romaGiorno(7) && r.body?.tipo?.usato === 'con_operai' && r.body?.tipo?.da === 'titolare', { promessa: sp?.promessa, tipo: r.body?.tipo });
    check('scheda del titolare: il link ha l\'ultimo uso e i 60 giorni', r.body?.link?.giorni === 60 && !!r.body?.link?.usatoAt, r.body?.link);

    // Link fermo da 61 giorni
    const vecchio = new Date(Date.now() - 61 * 86400000).toISOString();
    await admin.from('sub_link').update({ created_at: vecchio, usato_at: vecchio, aperto_at: vecchio, inviato_at: vecchio }).eq('subcontractor_id', sub.id).is('revoked_at', null);
    r = await pub();
    check('link fermo da 61 giorni → 410 LINK_SCADUTO', r.status === 410 && r.body?.error === 'LINK_SCADUTO', r);
    const nuovo = await L.linkImpresa(CO, sub.id, userId);
    check('rimandandolo se ne fa uno nuovo (URL diverso)', nuovo.url !== url, nuovo.url === url);
    url = nuovo.url; token = url.split('/impresa/')[1];
    r = await pub();
    check('il link nuovo funziona', r.status === 200, r.status);

    // Ritira
    r = await owner('POST', `/imprese/${sub.id}/link/ritira`);
    check('il titolare ritira il link → ok', r.status === 200 && r.body?.ritirato === true, r);
    r = await pub();
    check('link ritirato → 404', r.status === 404, r.status);
  } finally {
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
