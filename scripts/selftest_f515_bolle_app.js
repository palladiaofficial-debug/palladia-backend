#!/usr/bin/env node
/**
 * scripts/selftest_f515_bolle_app.js
 *
 * Regressione per F-515 (AUDIT.md del frontend, 19/11/2026): l'app «Bolle»
 * degli autisti.
 *
 * 1. Il cantiere: prima quello scritto sulla bolla, poi la timbratura di oggi
 *    SOLO se è un cantiere vero (Daniel e Raffaele timbrano al Magazzino: le
 *    loro bolle finivano lì), se no nessuno (decide l'ufficio).
 * 2. La risposta dice se la foto non è una bolla (l'estratto conto di Daniel
 *    del 17/11 era arrivato come «Mandata»); lettura fallita = non si sa.
 * 3. «Rifai la foto» scarta la bolla sbagliata; «ha un'altra pagina» la
 *    aggiunge alla stessa bolla e la rilegge. Solo le proprie bolle di oggi.
 * 4. Dal vivo: la pagina /timbratura/:code/foto, il suo manifest «Bolle»
 *    (start_url personale), le rotte nuove protette dal badge.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ORIGINE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const PNG = (seme) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.from(String(seme))]);
const foto = (seme) => ({ buffer: PNG(seme), mimetype: 'image/png', originalname: 'bolla.png' });

async function main() {
  console.log('\nPalladia regression — F-515: l\'app «Bolle» degli autisti\n');
  const BA = require('../lib/bolleAutisti');
  const URL_ = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL_ || !SERVICE) { console.log('  – skip: env mancante'); return fine(); }
  const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: co } = await admin.from('companies').insert([{ name: 'TEST-F515-BolleApp' }]).select('id').single();
  const CO = co.id;
  try {
    const sito = async (name, address) => (await admin.from('sites').insert({ company_id: CO, name, address, status: 'attivo' }).select('id').single()).data.id;
    const riboli = await sito('TEST-F515 Via Riboli 4b', 'Via Riboli 4b, Genova');
    const chiodo = await sito('TEST-F515 Via Chiodo 9C', 'Via Chiodo 9C, Genova');
    const magazzino = await sito('Magazzino TEST-F515', 'Via del Magazzino 1, Genova');
    const nuovo = async (nome) => (await admin.from('workers').insert({ company_id: CO, full_name: nome, fiscal_code: `F515${crypto.randomBytes(6).toString('hex').toUpperCase()}`.slice(0, 16), badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(), is_active: true, ddt_upload_enabled: true }).select('id, company_id, badge_code').single()).data;
    const daniel = await nuovo('Daniel Autista');
    const raffaele = await nuovo('Raffaele Autista');
    const timbra = (w, site) => admin.from('presence_logs').insert([{ company_id: CO, site_id: site, worker_id: w.id, event_type: 'ENTRY', timestamp_server: new Date().toISOString(), method: 'worker_self_punch' }]);
    const letto = (o = {}) => async () => ({ tipo: 'bolla', ragioneSociale: 'Edilmac S.r.l.', piva: null, numero: null, dataDocumento: '2026-11-19', righe: [{ descrizione: 'Cemento', quantita: 10, unita: 'sacchi' }], cantiere: null, ...o });
    const riga = async (id) => (await admin.from('bolle').select('*').eq('id', id).single()).data;

    // 1. Il cantiere
    await timbra(daniel, magazzino);
    const wD = { id: daniel.id, company_id: CO }, wR = { id: raffaele.id, company_id: CO };
    let r = await BA.manda(wD, { files: [foto('m1')], clientId: 'f515-1' }, { leggi: letto({ cantiere: 'Via Chiodo 9C Genova' }) });
    let b = await riga(r.id);
    check('timbrato al Magazzino + bolla per Via Chiodo → Via Chiodo (non il Magazzino)', b.site_id === chiodo && b.cantiere_da === 'bolla', { site: b.site_id, da: b.cantiere_da });
    r = await BA.manda(wD, { files: [foto('m2')], clientId: 'f515-2' }, { leggi: letto({ cantiere: null, ragioneSociale: 'Altro fornitore' }) });
    b = await riga(r.id);
    check('timbrato al Magazzino + destinazione non letta → nessun cantiere (decide l\'ufficio), mai il Magazzino', b.site_id === null && b.dubbi.includes('cantiere'), { site: b.site_id, dubbi: b.dubbi });
    await timbra(raffaele, riboli);
    r = await BA.manda(wR, { files: [foto('r1')], clientId: 'f515-3' }, { leggi: letto({ cantiere: null, ragioneSociale: 'Terzo fornitore' }) });
    b = await riga(r.id);
    check('timbrato a Via Riboli + destinazione non letta → Via Riboli (dalla timbratura)', b.site_id === riboli && b.cantiere_da === 'timbratura', { site: b.site_id, da: b.cantiere_da });
    r = await BA.manda(wR, { files: [foto('r2')], clientId: 'f515-4' }, { leggi: letto({ cantiere: 'Via Chiodo 9C', ragioneSociale: 'Quarto fornitore' }) });
    b = await riga(r.id);
    check('timbrato a Via Riboli + bolla per Via Chiodo → Via Chiodo (vince la bolla)', b.site_id === chiodo && b.cantiere_da === 'bolla', { site: b.site_id, da: b.cantiere_da });
    check('la risposta porta fornitore e cantiere per lo schermo «Arrivata»', r.fornitore === 'Quarto fornitore' && /Via Chiodo/.test(r.cantiere || '') && r.nonBolla === false, r);

    // 2. Non è una bolla
    r = await BA.manda(wD, { files: [foto('e1')], clientId: 'f515-5' }, { leggi: letto({ tipo: 'altro', ragioneSociale: 'Esolver Sistemi' }) });
    check('estratto conto (tipo altro) → nonBolla, salvata da controllare', r.nonBolla === true && r.sembra === null && (await riga(r.id)).dubbi.includes('tipo'), r);
    const idSbagliata = r.id;
    r = await BA.manda(wD, { files: [foto('e2')], clientId: 'f515-6' }, { leggi: letto({ tipo: 'fattura', ragioneSociale: 'Fornitore Fattura' }) });
    check('fattura → nonBolla, «sembra una fattura»', r.nonBolla === true && r.sembra === 'fattura', r);
    r = await BA.manda(wD, { files: [foto('e3')], clientId: 'f515-7' }, { leggi: async () => { throw new Error('modello fermo'); } });
    check('lettura fallita → non diciamo che non è una bolla (non si sa)', r.nonBolla === false && r.letta === false, r);

    // 3. Rifai la foto / un'altra pagina
    let errore = null;
    try { await BA.scarta(wR, idSbagliata); } catch (e) { errore = e.code; }
    check('scartare la bolla di un altro autista → NOT_FOUND', errore === 'NOT_FOUND', errore);
    const s = await BA.scarta(wD, idSbagliata);
    check('«Rifai la foto»: la sbagliata è scartata (nascosta, non cancellata)', s.stato === 'scartata' && (await riga(idSbagliata)).stato === 'scartata', s);
    r = await BA.manda(wR, { files: [foto('p1')], clientId: 'f515-8' }, { leggi: letto({ ragioneSociale: 'Quinto fornitore', righe: [] }) });
    const idPagine = r.id;
    const p = await BA.aggiungiPagine(wR, idPagine, [foto('p2')], { leggi: letto({ ragioneSociale: 'Quinto fornitore', numero: '777', righe: [{ descrizione: 'Ferro', quantita: 3, unita: 't' }] }) });
    b = await riga(idPagine);
    check('«ha un\'altra pagina»: 2 pagine sulla stessa bolla, riletta (numero e materiali dalla seconda)', b.pagine.length === 2 && b.numero === '777' && b.righe.length === 1 && p.pagine === 2, { pagine: b.pagine.length, numero: b.numero, righe: b.righe.length, p });
    errore = null;
    try { await BA.aggiungiPagine(wD, idPagine, [foto('p3')], { leggi: letto() }); } catch (e) { errore = e.code; }
    check('aggiungere una pagina alla bolla di un altro → NOT_FOUND', errore === 'NOT_FOUND', errore);
    errore = null;
    try { await BA.aggiungiPagine(wR, idPagine, [1, 2, 3, 4, 5].map(i => foto('q' + i)), { leggi: letto() }); } catch (e) { errore = e.code; }
    check('più di 6 pagine in tutto → TROPPE_PAGINE', errore === 'TROPPE_PAGINE', errore);

    // 4. Dal vivo
    const pag = await fetch(`${ORIGINE}/timbratura/${daniel.badge_code}/foto`);
    const html = await pag.text();
    check('la pagina dell\'app Bolle risponde, con il suo manifest e l\'icona', pag.status === 200 && html.includes('data-testid="bolle-app"') && html.includes('foto.webmanifest') && html.includes('apple-touch-icon'), pag.status);
    const man = await fetch(`${ORIGINE}/timbratura/${daniel.badge_code}/foto.webmanifest`);
    const mj = await man.json().catch(() => ({}));
    check('manifest: nome «Bolle», si apre sul link personale', man.status === 200 && mj.short_name === 'Bolle' && mj.start_url === `/timbratura/${daniel.badge_code}/foto` && mj.display === 'standalone', mj);
    const cattivo = await fetch(`${ORIGINE}/timbratura/NONVALIDO/foto.webmanifest`);
    check('manifest con un codice non valido → 400', cattivo.status === 400, cattivo.status);
    const sc = await fetch(`${ORIGINE}/api/v1/badge/NONESISTE123/bolle/${idPagine}/scarta`, { method: 'POST' });
    const pg = await fetch(`${ORIGINE}/api/v1/badge/NONESISTE123/bolle/${idPagine}/pagine`, { method: 'POST' });
    check('rotte nuove: con un badge sbagliato → 401', sc.status === 401 && pg.status === 401, { scarta: sc.status, pagine: pg.status });
    const vecchia = await fetch(`${ORIGINE}/timbratura/${daniel.badge_code}/bolla`);
    check('il tasto del badge (/bolla) apre la stessa app nuova', vecchia.status === 200 && (await vecchia.text()).includes('data-testid="bolle-app"'), vecchia.status);
  } finally {
    const { data: bs } = await admin.from('bolle').select('pagine, file_path').eq('company_id', CO);
    const files = (bs || []).flatMap(x => (Array.isArray(x.pagine) && x.pagine.length ? x.pagine.map(q => q.path) : [x.file_path])).filter(Boolean);
    if (files.length) await admin.storage.from('site-documents').remove(files);
    await admin.from('bolle').delete().eq('company_id', CO);
    await admin.from('presence_logs').delete().eq('company_id', CO);
    await admin.from('workers').delete().eq('company_id', CO);
    await admin.from('sites').delete().eq('company_id', CO);
    await admin.from('companies').delete().eq('id', CO);
  }
  return fine();
}
function fine() { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = failed > 0 ? 1 : 0; }
main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 300));
