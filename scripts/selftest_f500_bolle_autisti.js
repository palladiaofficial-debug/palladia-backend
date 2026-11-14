#!/usr/bin/env node
/**
 * scripts/selftest_f500_bolle_autisti.js
 *
 * Regressione per F-500 (AUDIT.md del frontend, 14/11/2026): le bolle
 * fotografate dal badge degli autisti finivano in site_costs e non arrivavano
 * mai nelle Bolle del cantiere né al confronto con la fattura. Ora vanno nella
 * tabella `bolle` (origine badge), col cantiere capito da sole.
 *
 * 1. Logica (lib/bolleAutisti, lettura finta): il cantiere dalla timbratura di
 *    oggi, dalla destinazione scritta, o scelto dall'autista; «da controllare»
 *    con i dubbi; doppioni (stesso invio senza rete, stessa foto, stesso
 *    fornitore e numero); la foto non si perde se la lettura fallisce.
 * 2. Dal vivo (API di produzione): il badge senza DDT abilitati → 403, codice
 *    sbagliato → 401, info dell'autista; l'ufficio vede le bolle da
 *    controllare, le corregge, «Non è una bolla» le nasconde; Bolle del
 *    cantiere mostra la bolla dell'autista; la riga su Oggi.
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
const PNG = (seme) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.from(String(seme))]);
const foto = (seme) => ({ buffer: PNG(seme), mimetype: 'image/png', originalname: 'bolla.png' });

async function main() {
  console.log('\nPalladia regression — F-500: le bolle dei nostri autisti\n');
  const BA = require('../lib/bolleAutisti');
  check('dubbi: tutto letto e cantiere → nessuno', BA.dubbiDi({ tipo: 'bolla', ragioneSociale: 'Edilmac', numero: '1', dataDocumento: '2026-11-14', righe: [{}] }, 'x').length === 0);
  check('dubbi: numero e cantiere mancanti', BA.dubbiDi({ tipo: 'bolla', ragioneSociale: 'Edilmac', numero: null, dataDocumento: '2026-11-14', righe: [{}] }, null).join(',') === 'numero,cantiere');
  check('dubbi: lettura fallita', BA.dubbiDi(null, 'x').join(',') === 'lettura');

  const URL_ = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!URL_ || !SERVICE || !ANON) { console.log('  – skip parte con il DB: env mancante'); return fine(); }
  const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: co } = await admin.from('companies').insert([{ name: 'TEST-F500-BolleAutisti' }]).select('id').single();
  const CO = co.id; let userId = null; const workers = [];
  try {
    const { data: s1 } = await admin.from('sites').insert({ company_id: CO, name: 'TEST-F500 Via Riboli 4b', address: 'Via Riboli 4b, Genova', status: 'attivo' }).select('id').single();
    const { data: s2 } = await admin.from('sites').insert({ company_id: CO, name: 'TEST-F500 Via Chiodo 9C', address: 'Via Chiodo 9C, Genova', status: 'attivo' }).select('id').single();
    const nuovo = async (nome, ddt) => {
      const { data } = await admin.from('workers').insert({ company_id: CO, full_name: nome, fiscal_code: `F500${crypto.randomBytes(6).toString('hex').toUpperCase()}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), is_active: true, ddt_upload_enabled: ddt }).select('id, company_id, badge_code').single();
      workers.push(data.id); return data;
    };
    const marco = await nuovo('Marco Autista', true);
    const luca = await nuovo('Luca Muratore', false);
    const w = { id: marco.id, company_id: CO };

    // 1. Logica con la lettura finta
    const letto = (o = {}) => async () => ({ tipo: 'bolla', ragioneSociale: 'Edilmac S.r.l.', piva: '01234567890', numero: '4512', dataDocumento: '2026-11-14', righe: [{ descrizione: 'Cemento 32,5', quantita: 20, unita: 'sacchi' }], cantiere: null, ...o });
    let r = await BA.manda(w, { files: [foto('a')], clientId: 'c-1' }, { leggi: letto({ cantiere: 'Via Chiodo 9C Genova' }) });
    let b = (await admin.from('bolle').select('*').eq('id', r.id).single()).data;
    check('senza timbratura: il cantiere dalla destinazione scritta (Via Chiodo)', b.site_id === s2.id && b.cantiere_da === 'bolla' && b.origine === 'badge' && b.worker_id === marco.id, { site: b.site_id, da: b.cantiere_da });
    check('tutto letto → a posto, nessun dubbio', b.stato === 'a_posto' && b.dubbi.length === 0, { stato: b.stato, dubbi: b.dubbi });
    r = await BA.manda(w, { files: [foto('a')], clientId: 'c-1' }, { leggi: letto() });
    check('stesso invio ripetuto (senza rete) → la stessa bolla, non due', r.stessoInvio === true && r.id === b.id, r);
    r = await BA.manda(w, { files: [foto('a')], clientId: 'c-2' }, { leggi: letto() });
    check('stessa foto mandata di nuovo → «c\'è già»', r.doppione === true && r.id === b.id, r);
    r = await BA.manda(w, { files: [foto('b')], clientId: 'c-3' }, { leggi: letto() });
    check('stesso fornitore e numero → «c\'è già»', r.doppione === true && r.id === b.id, r);

    await admin.from('presence_logs').insert([{ company_id: CO, site_id: s1.id, worker_id: marco.id, event_type: 'ENTRY', timestamp_server: new Date().toISOString(), method: 'worker_self_punch' }]);
    r = await BA.manda(w, { files: [foto('c'), foto('c2')], clientId: 'c-4' }, { leggi: letto({ numero: null, ragioneSociale: 'Ferramenta Ligure', piva: null, cantiere: 'Via Chiodo 9C' }) });
    b = (await admin.from('bolle').select('*').eq('id', r.id).single()).data;
    check('ha timbrato oggi a Via Riboli → la bolla va lì (vince sulla destinazione)', b.site_id === s1.id && b.cantiere_da === 'timbratura', { site: b.site_id, da: b.cantiere_da });
    check('numero non letto → da controllare, dubbio «numero»; 2 pagine salvate', b.stato === 'da_controllare' && b.dubbi.includes('numero') && b.pagine.length === 2, { stato: b.stato, dubbi: b.dubbi, pagine: b.pagine.length });
    const idDubbio = b.id;
    r = await BA.manda(w, { files: [foto('d')], siteId: s2.id, clientId: 'c-5' }, { leggi: letto({ numero: '900' }) });
    b = (await admin.from('bolle').select('site_id, cantiere_da').eq('id', r.id).single()).data;
    check('cantiere scelto dall\'autista → vince lui', b.site_id === s2.id && b.cantiere_da === 'autista', b);
    r = await BA.manda(w, { files: [foto('e')], clientId: 'c-6' }, { leggi: async () => { throw new Error('modello fermo'); } });
    b = (await admin.from('bolle').select('stato, dubbi, file_path').eq('id', r.id).single()).data;
    check('lettura fallita → la foto è salvata, da controllare («lettura»)', b.stato === 'da_controllare' && b.dubbi.includes('lettura') && !!b.file_path, b);
    let errore = null; try { await BA.manda(w, { files: [{ buffer: Buffer.from('x'), mimetype: 'text/plain' }] }, { leggi: letto() }); } catch (e) { errore = e.code; }
    check('file che non è foto né PDF → rifiutato', errore === 'FILE_NON_VALIDO', errore);
    const info = await BA.info(w);
    check('info: nome, cantiere di oggi Via Riboli, bolle mandate oggi', info.nome === 'Marco Autista' && info.cantiereOggi?.id === s1.id && info.oggi.length >= 4 && info.cantieri.length === 2, { oggi: info.oggi.length, cantiere: info.cantiereOggi });

    // 2. Dal vivo
    const api = async (method, path, body, headers = {}) => { const res = await fetch(BASE + path, { method, headers, body }); let j = null; try { j = await res.json(); } catch { /* */ } return { status: res.status, body: j }; };
    let x = await api('GET', `/badge/${luca.badge_code}/bolle`);
    check('badge senza DDT abilitati → 403 DDT_NOT_ENABLED', x.status === 403 && x.body?.error === 'DDT_NOT_ENABLED', x);
    x = await api('GET', '/badge/NONESISTE123/bolle');
    check('codice badge sbagliato → 401', x.status === 401, x.status);
    x = await api('GET', `/badge/${marco.badge_code}/bolle`);
    check('autista: info dal vivo con il cantiere di oggi', x.status === 200 && x.body?.cantiereOggi?.id === s1.id && x.body?.nome === 'Marco Autista', x.body);
    const fd = new FormData();
    fd.append('pagine', new Blob([Buffer.from('ciao')], { type: 'text/plain' }), 'x.txt');
    x = await api('POST', `/badge/${marco.badge_code}/bolle`, fd);
    check('autista: un file di testo → 400, nessuna bolla', x.status === 400, x);

    const email = `test-f500-${crypto.randomUUID()}@example.com`;
    const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
    userId = u.user.id;
    await admin.from('company_users').insert([{ company_id: CO, user_id: userId, role: 'owner' }]);
    const { data: lk } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const { data: ses } = await anon.auth.verifyOtp({ token_hash: lk.properties.hashed_token, type: 'magiclink' });
    const H = { Authorization: `Bearer ${ses.session.access_token}`, 'X-Company-Id': CO };
    x = await api('GET', '/bolle/da-controllare', undefined, H);
    check('ufficio: 2 bolle da controllare, con autista e dubbi', x.status === 200 && x.body?.bolle?.length === 2 && x.body.bolle.every(b => b.autista === 'Marco Autista') && x.body.bolle.some(b => b.dubbi.includes('numero')), x.body?.bolle?.map(b => ({ dubbi: b.dubbi, autista: b.autista })));
    x = await api('GET', `/bolle/${idDubbio}`, undefined, H);
    check('ufficio: il dettaglio ha le 2 pagine con il link', x.status === 200 && x.body?.foto?.length === 2 && x.body.foto.every(f => /^https?:/.test(f.url || '')), x.body?.foto);
    x = await api('PATCH', `/bolle/${idDubbio}`, JSON.stringify({ numero: '88', stato: 'a_posto' }), { ...H, 'Content-Type': 'application/json' });
    check('ufficio: corregge il numero e dice «Va bene» → a posto, senza dubbi', x.status === 200 && x.body?.numero === '88' && x.body?.stato === 'a_posto' && x.body?.dubbi.length === 0, x.body);
    const altra = (await admin.from('bolle').select('id').eq('company_id', CO).eq('stato', 'da_controllare').single()).data;
    x = await api('PATCH', `/bolle/${altra.id}`, JSON.stringify({ stato: 'scartata' }), { ...H, 'Content-Type': 'application/json' });
    const ancora = (await admin.from('bolle').select('id, stato').eq('id', altra.id).single()).data;
    check('«Non è una bolla» → nascosta, non cancellata', x.status === 200 && ancora?.stato === 'scartata', ancora);
    x = await api('GET', `/cantieri/${s1.id}/bolle`, undefined, H);
    check('Bolle del cantiere: c\'è la bolla di Marco, dal badge, 2 pagine', x.status === 200 && x.body?.bolle?.some(b => b.autista === 'Marco Autista' && b.origine === 'badge' && b.pagine === 2), x.body?.bolle);
    x = await api('GET', '/bolle/da-controllare', undefined, H);
    check('ufficio: non ne resta nessuna da controllare', x.body?.bolle?.length === 0, x.body?.bolle?.length);
  } finally {
    const { data: bs } = await admin.from('bolle').select('pagine, file_path').eq('company_id', CO);
    const files = (bs || []).flatMap(b => (Array.isArray(b.pagine) && b.pagine.length ? b.pagine.map(p => p.path) : [b.file_path])).filter(Boolean);
    if (files.length) await admin.storage.from('site-documents').remove(files);
    await admin.from('bolle').delete().eq('company_id', CO);
    await admin.from('presence_logs').delete().eq('company_id', CO);
    await admin.from('workers').delete().eq('company_id', CO);
    await admin.from('sites').delete().eq('company_id', CO);
    await admin.from('company_users').delete().eq('company_id', CO);
    await admin.from('companies').delete().eq('id', CO);
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
  return fine();
}
function fine() { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = failed > 0 ? 1 : 0; }
main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 300));
