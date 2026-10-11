#!/usr/bin/env node
/**
 * scripts/selftest_sub_presenze.js — F-337 (AUDIT.md del frontend).
 *
 * Presenze in cantiere degli operai dei subappaltatori, contro il DB vero:
 * rotte montate su un server locale (login dell'ufficio finto, come gli altri
 * test), due aziende di prova.
 *  - QR: imprese del cantiere, registrazione (codice fiscale, impresa assegnata,
 *    non un nostro dipendente), entrata/uscita, doppio tocco, gettone falso;
 *  - INVARIANTE: nessuna riga in workers / presence_logs, niente in "chi non
 *    ha timbrato" né nel foglio ore del mese;
 *  - link della squadra: elenco, aggiungi, segna, tutti fuori, revoca, altra azienda;
 *  - cambio cantiere = uscita automatica dal primo;
 *  - riquadro del titolare: nostri + altre imprese, avvisi rossi/gialli;
 *  - "La mia impresa non c'è" → rosso → assegnata;
 *  - ufficio: appello, ruoli, annulla; modulo spento; RLS chiusa all'anon key.
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const jwtPath = path.join(__dirname, '../middleware/verifyJwt.js');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: {
  verifySupabaseJwt: (req, _res, next) => { req.companyId = req.get('x-test-company'); req.userRole = req.get('x-test-role') || 'owner'; req.user = { id: null }; next(); },
} };
const supabase = require('../lib/supabase');
const { signQrToken } = require('../routes/v1/qr');
const S = require('../lib/subPresenze');
const { missingToday } = require('../lib/presenceMissing');
const { buildOreMese } = require('../lib/oreMese');
const { codiceCognome, codiceNome } = require('../lib/codiceFiscale');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const T = `TEST-F337-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

// Codice fiscale VALIDO costruito da cognome/nome (carattere di controllo calcolato)
const DISP = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };
let seq = Number(String(Date.now()).slice(-3));
function cf(cognome, nome) {
  seq = (seq + 7) % 1000;
  const body = `${codiceCognome(cognome)}${codiceNome(nome)}80A01Z${String(seq).padStart(3, '0')}`;
  let s = 0;
  for (let i = 0; i < 15; i++) s += i % 2 === 0 ? DISP[body[i]] : (/\d/.test(body[i]) ? Number(body[i]) : body.charCodeAt(i) - 65);
  return body + String.fromCharCode(65 + (s % 26));
}

async function main() {
  console.log('\n\x1b[1mF-337 — presenze delle imprese subappaltatrici\x1b[0m');
  const app = express(); app.use(express.json({ limit: '10mb' })); app.set('trust proxy', true);
  app.use('/api/v1', require('../routes/v1/subPresenze'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, url, { body, company, role, token } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (company) headers['x-test-company'] = company;
    if (role) headers['x-test-role'] = role;
    if (token) headers['X-Sub-Token'] = token;
    const r = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const A = await ins('companies', { name: `${T}-A`, orario_inizio: '00:00', orario_fine: '23:30' });
  const B = await ins('companies', { name: `${T}-B` });
  try {
    await ins('company_feature_flags', { company_id: A.id, feature: 'presenze_imprese', enabled: true });
    const site = await ins('sites', { company_id: A.id, name: `${T}-Via Verdi`, address: 'Via Verdi 13', status: 'attivo', latitude: 44.3, longitude: 8.48, geofence_radius_m: 150 });
    const site2 = await ins('sites', { company_id: A.id, name: `${T}-Magazzino`, address: 'Via 2', status: 'attivo' });
    const past = new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 200 * 86400e3).toISOString().slice(0, 10);
    const subX = await ins('subcontractors', { company_id: A.id, company_name: `${T} Termo Bianchi`, durc_expiry: past, insurance_expiry: future });
    const subY = await ins('subcontractors', { company_id: A.id, company_name: `${T} Edil Rossi`, durc_expiry: future, insurance_expiry: future });
    const subZ = await ins('subcontractors', { company_id: A.id, company_name: `${T} Non Assegnata`, durc_expiry: future, insurance_expiry: future });
    for (const [s, sub] of [[site, subX], [site, subY], [site2, subY]]) await ins('site_subcontractors', { company_id: A.id, site_id: s.id, subcontractor_id: sub.id });
    const nostro = await ins('workers', { company_id: A.id, full_name: `${T} Nostro Operaio`, is_active: true, fiscal_code: cf('Operaio', 'Nostro'), badge_code: `F337${String(Date.now()).slice(-10)}` });
    const workersPrima = (await supabase.from('workers').select('id', { count: 'exact', head: true }).eq('company_id', A.id)).count;

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const qr = (s = site) => ({ site: s.id, t: signQrToken(s.id, exp), exp });
    const qs = (s = site) => `site=${s.id}&t=${signQrToken(s.id, exp)}&exp=${exp}`;

    // ── QR: contesto e registrazione ──
    const ctx = await call('GET', `/sub-scan/context?${qs()}`);
    const ids = (ctx.body.imprese || []).map(i => i.id);
    check('QR: imprese = la nostra + i 2 sub assegnati (non quello non assegnato)', ctx.status === 200 && ids.includes('own') && ids.includes(subX.id) && ids.includes(subY.id) && !ids.includes(subZ.id), ctx.body);
    check('QR falso: 401', (await call('GET', `/sub-scan/context?site=${site.id}&t=${'0'.repeat(64)}&exp=${exp}`)).status === 401);

    const cfIon = cf('Popescu', 'Ion');
    check('codice fiscale con carattere di controllo sbagliato: 400', (await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subY.id, full_name: 'Ion Popescu', fiscal_code: cfIon.slice(0, 15) + (cfIon[15] === 'A' ? 'B' : 'A') } })).body.error === 'INVALID_FISCAL_CODE');
    check('impresa non assegnata al cantiere: 409', (await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subZ.id, full_name: 'Ion Popescu', fiscal_code: cfIon } })).body.error === 'IMPRESA_NON_ASSEGNATA');
    check('codice fiscale di un nostro dipendente: 409 GIA_DIPENDENTE', (await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subY.id, full_name: 'Nostro Operaio', fiscal_code: nostro.fiscal_code } })).body.error === 'GIA_DIPENDENTE');
    const reg = await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subY.id, full_name: 'Ion Popescu', fiscal_code: cfIon } });
    check('registrazione: gettone del telefono', reg.status === 200 && /^sw1\./.test(reg.body.deviceToken), reg.body);
    const tokIon = reg.body.deviceToken;
    const { data: ionRow } = await supabase.from('sub_workers').select('*').eq('id', reg.body.subWorkerId).single();
    check('nel DB: persona del sub con informativa registrata', ionRow.subcontractor_id === subY.id && ionRow.fiscal_code === cfIon && !!ionRow.informativa_at && ionRow.added_via === 'qr', ionRow);
    const reg2 = await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subY.id, full_name: 'Ion Popescu', fiscal_code: cfIon } });
    check('stessa persona di nuovo: nessun doppione', reg2.body.subWorkerId === reg.body.subWorkerId);

    // ── QR: entrata e uscita ──
    const st0 = await call('GET', `/sub-scan/stato?${qs()}`, { token: tokIon });
    check('stato: fuori, nome e impresa', st0.status === 200 && st0.body.dentro === false && st0.body.nome === 'Ion Popescu' && st0.body.impresa === subY.company_name, st0.body);
    check('gettone falso: 401', (await call('GET', `/sub-scan/stato?${qs()}`, { token: tokIon.slice(0, -2) + '00' })).status === 401);
    const p1 = await call('POST', '/sub-scan/punch', { token: tokIon, body: { ...qr(), event: 'entrata', client_request_id: 'r1', gps: { latitude: 44.3001, longitude: 8.4801, accuracy: 12 } } });
    check('ENTRO: entrata registrata', p1.status === 200 && p1.body.event === 'entrata' && p1.body.unchanged === false, p1.body);
    const p1b = await call('POST', '/sub-scan/punch', { token: tokIon, body: { ...qr(), event: 'entrata', client_request_id: 'r1' } });
    check('doppio tocco: nessun doppione', p1b.body.unchanged === true);
    const { count: nIon } = await supabase.from('sub_presenze').select('id', { count: 'exact', head: true }).eq('sub_worker_id', ionRow.id);
    check('nel DB: una sola entrata', nIon === 1, nIon);
    check('stato: dentro', (await call('GET', `/sub-scan/stato?${qs()}`, { token: tokIon })).body.dentro === true);

    // ── Cambio cantiere: esce da Via Verdi ──
    const p2 = await call('POST', '/sub-scan/punch', { token: tokIon, body: { ...qr(site2), event: 'entrata', client_request_id: 'r2' } });
    const statoIon = await S.statoDi(ionRow);
    const { data: righeIon } = await supabase.from('sub_presenze').select('site_id, event').eq('sub_worker_id', ionRow.id).order('created_at');
    check('entra al magazzino: uscita automatica da Via Verdi, dentro al magazzino', p2.body.event === 'entrata' && statoIon.dentroSito === site2.id && righeIon.some(r => r.site_id === site.id && r.event === 'uscita'), righeIon);
    await call('POST', '/sub-scan/punch', { token: tokIon, body: { ...qr(site), event: 'entrata', client_request_id: 'r3' } });

    // ── INVARIANTE: nessun dipendente, nessuna timbratura ──
    const workersDopo = (await supabase.from('workers').select('id', { count: 'exact', head: true }).eq('company_id', A.id)).count;
    const { count: logsA } = await supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', A.id);
    check('INVARIANTE: nessun lavoratore creato in workers', workersDopo === workersPrima, { workersPrima, workersDopo });
    check('INVARIANTE: nessuna timbratura in presence_logs', logsA === 0, logsA);
    const missing = await missingToday(A.id);
    check('INVARIANTE: "chi non ha timbrato" non vede le persone dei sub', !JSON.stringify(missing).includes('Popescu'), missing);
    const ore = await buildOreMese(A.id, new Date().toISOString().slice(0, 7));
    check('INVARIANTE: foglio ore del mese senza persone dei sub', !JSON.stringify(ore).includes('Popescu'));

    // ── Link della squadra ──
    const L1 = await call('POST', `/sites/${site.id}/subcontractors/${subY.id}/link-squadra`, { company: A.id });
    const tokSq = (L1.body.url || '').split('/squadra/')[1];
    check('link della squadra creato', L1.status === 201 && !!tokSq, L1.body);
    const d0 = await call('GET', `/squadra/${tokSq}/dati`);
    check('squadra: cantiere, impresa, Ion dentro', d0.status === 200 && d0.body.impresa === subY.company_name && d0.body.persone.some(p => p.nome === 'Ion Popescu' && p.dentro), d0.body);
    check('squadra: nome senza cognome rifiutato', (await call('POST', `/squadra/${tokSq}/persone`, { body: { full_name: 'Mario' } })).status === 400);
    const add = await call('POST', `/squadra/${tokSq}/persone`, { body: { full_name: 'Mario Sanna' } });
    const add2 = await call('POST', `/squadra/${tokSq}/persone`, { body: { full_name: 'mario  sanna' } });
    check('squadra: aggiunge Mario Sanna, una volta sola', add.status === 200 && add2.body.id === add.body.id, { add: add.body, add2: add2.body });
    const s1 = await call('POST', `/squadra/${tokSq}/segna`, { body: { sub_worker_id: add.body.id, event: 'entrata' } });
    check('squadra: Mario segnato dentro', s1.body.event === 'entrata' && !s1.body.unchanged, s1.body);
    const { data: rigaMario } = await supabase.from('sub_presenze').select('source, squad_link_id').eq('sub_worker_id', add.body.id).single();
    check('nel DB: segnato dal caposquadra, col link', rigaMario.source === 'squadra' && !!rigaMario.squad_link_id, rigaMario);

    // Persona aggiunta dal caposquadra poi riconosciuta dal QR (nome in ordine diverso)
    const ahmed = await call('POST', `/squadra/${tokSq}/persone`, { body: { full_name: 'Ahmed Ben Ali' } });
    const regA = await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subY.id, full_name: 'Ben Ali Ahmed', fiscal_code: cf('Ben Ali', 'Ahmed') } });
    check('QR riconosce la persona aggiunta dal caposquadra (stesso nome, altro ordine)', regA.body.subWorkerId === ahmed.body.id, { regA: regA.body, ahmed: ahmed.body });

    // Altra azienda: il suo link non tocca le persone di A
    await ins('company_feature_flags', { company_id: B.id, feature: 'presenze_imprese', enabled: true });
    const siteB = await ins('sites', { company_id: B.id, name: `${T}-B-site`, address: 'Via B', status: 'attivo' });
    const subB = await ins('subcontractors', { company_id: B.id, company_name: `${T} Sub di B` });
    await ins('site_subcontractors', { company_id: B.id, site_id: siteB.id, subcontractor_id: subB.id });
    const LB = await call('POST', `/sites/${siteB.id}/subcontractors/${subB.id}/link-squadra`, { company: B.id });
    const tokB = LB.body.url.split('/squadra/')[1];
    check('link di un\'altra azienda non segna le persone di A: 404', (await call('POST', `/squadra/${tokB}/segna`, { body: { sub_worker_id: ionRow.id, event: 'uscita' } })).status === 404);
    check('ufficio di B non vede il cantiere di A: 404', (await call('GET', `/sites/${site.id}/imprese-oggi`, { company: B.id })).status === 404);
    check('ufficio di B non crea link sul cantiere di A: 404', (await call('POST', `/sites/${site.id}/subcontractors/${subY.id}/link-squadra`, { company: B.id })).status === 404);

    // ── Riquadro del titolare ──
    const regX = await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subX.id, full_name: 'Luca Ferro', fiscal_code: cf('Ferro', 'Luca') } });
    await call('POST', '/sub-scan/punch', { token: regX.body.deviceToken, body: { ...qr(), event: 'entrata', gps: { latitude: 45.46, longitude: 9.19, accuracy: 10 } } });
    await ins('presence_logs', { company_id: A.id, site_id: site.id, worker_id: nostro.id, event_type: 'ENTRY', timestamp_server: new Date().toISOString(), method: 'test' });
    const oggi = await call('GET', `/sites/${site.id}/imprese-oggi`, { company: A.id });
    const b = oggi.body;
    const impX = b.imprese?.find(i => i.id === subX.id), impY = b.imprese?.find(i => i.id === subY.id);
    check('riquadro: 1 nostro, Edil Rossi 2 dentro (Ion, Mario), Termo Bianchi 1', oggi.status === 200 && b.nostri === 1 && impY?.adesso === 2 && impX?.adesso === 1 && b.totaleAdesso === 4, { nostri: b.nostri, y: impY?.adesso, x: impX?.adesso, tot: b.totaleAdesso });
    check('rosso: persone di un\'impresa col DURC scaduto', b.avvisi?.some(a => a.livello === 'rosso' && a.tipo === 'documenti_scaduti' && a.subcontractorId === subX.id && /DURC/.test(a.testo)), b.avvisi);
    check('giallo: prima volta qui', b.avvisi?.some(a => a.livello === 'giallo' && a.tipo === 'prima_volta' && /Luca Ferro/.test(a.testo)), b.avvisi);
    check('giallo: entrata lontano dal cantiere (Milano invece di Savona)', b.avvisi?.some(a => a.tipo === 'lontano' && /Luca Ferro/.test(a.testo)), b.avvisi);
    check('nessun avviso documenti per l\'impresa in regola', !b.avvisi?.some(a => a.subcontractorId === subY.id && a.tipo.startsWith('documenti')), b.avvisi);
    check('il rosso viene prima del giallo', b.avvisi?.[0]?.livello === 'rosso');
    check('link della squadra attivo nel riquadro', impY?.linkSquadra?.attivo === true);

    // ── "La mia impresa non c'è" ──
    const ig = await call('POST', '/sub-scan/ignota', { body: { ...qr(), impresa_nome: 'Ponteggi Verdi', full_name: 'Paolo Neri', fiscal_code: cf('Neri', 'Paolo') } });
    const ig2 = await call('POST', '/sub-scan/ignota', { body: { ...qr(), impresa_nome: 'Ponteggi Verdi', full_name: 'Paolo Neri', fiscal_code: cf('Neri', 'Paolo').slice(0, 0) || 'x' } });
    check('impresa non assegnata: registrata', ig.status === 200 && ig.body.unchanged === false, ig.body);
    check('…con codice fiscale non valido: rifiutata', ig2.status === 400);
    const b2 = (await call('GET', `/sites/${site.id}/imprese-oggi`, { company: A.id })).body;
    const avvIg = b2.avvisi.find(a => a.tipo === 'impresa_non_assegnata');
    check('rosso: persona di un\'impresa non assegnata', avvIg?.livello === 'rosso' && /Ponteggi Verdi/.test(avvIg.testo), b2.avvisi);
    const ch = await call('POST', `/sub-impresa-ignota/${avvIg.ignotaId}/chiudi`, { company: A.id, body: { come: 'assegnata', subcontractor_id: subZ.id } });
    const { data: assZ } = await supabase.from('site_subcontractors').select('id').eq('site_id', site.id).eq('subcontractor_id', subZ.id);
    const b3 = (await call('GET', `/sites/${site.id}/imprese-oggi`, { company: A.id })).body;
    check('"Assegna": impresa assegnata al cantiere e avviso chiuso', ch.status === 200 && assZ.length === 1 && !b3.avvisi.some(a => a.tipo === 'impresa_non_assegnata'), { ch: ch.body, assZ });

    // ── Ufficio: appello, ruoli, annulla ──
    check('appello da un ruolo senza permesso: 403', (await call('POST', `/sites/${site.id}/sub-presenze`, { company: A.id, role: 'worker', body: { sub_worker_id: ahmed.body.id, event: 'entrata' } })).status === 403);
    const ap = await call('POST', `/sites/${site.id}/sub-presenze`, { company: A.id, body: { sub_worker_id: ahmed.body.id, event: 'entrata' } });
    check('appello del preposto: Ahmed dentro', ap.status === 200 && ap.body.event === 'entrata' && !!ap.body.id, ap.body);
    const an = await call('POST', `/sub-presenze/${ap.body.id}/annulla`, { company: A.id });
    const stA = await S.statoDi({ id: ahmed.body.id, company_id: A.id });
    check('annulla: la presenza resta nel DB ma non conta più', an.status === 200 && stA.dentroSito === null, stA);
    const { data: annullata } = await supabase.from('sub_presenze').select('annullata_at').eq('id', ap.body.id).single();
    check('nel DB: segnata come annullata, non cancellata', !!annullata?.annullata_at);

    // ── Tutti fuori e revoca ──
    const tf = await call('POST', `/squadra/${tokSq}/tutti-fuori`);
    const d1 = await call('GET', `/squadra/${tokSq}/dati`);
    check('tutti fuori: nessuno di Edil Rossi dentro qui', tf.body.usciti === 2 && d1.body.persone.every(p => !p.dentro), { tf: tf.body, persone: d1.body.persone });
    await call('DELETE', `/sites/${site.id}/subcontractors/${subY.id}/link-squadra`, { company: A.id });
    check('link revocato: 401', (await call('GET', `/squadra/${tokSq}/dati`)).status === 401);

    // ── Modulo spento ──
    await supabase.from('company_feature_flags').update({ enabled: false }).eq('company_id', A.id).eq('feature', 'presenze_imprese');
    const ctxOff = await call('GET', `/sub-scan/context?${qs()}`);
    check('modulo spento: si sceglie solo la nostra impresa', ctxOff.body.imprese?.length === 1 && ctxOff.body.imprese[0].id === 'own', ctxOff.body);
    check('modulo spento: registrazione rifiutata', (await call('POST', '/sub-scan/register', { body: { ...qr(), impresa: subY.id, full_name: 'Ion Popescu', fiscal_code: cfIon } })).status === 403);
    check('modulo spento: riquadro del titolare 404', (await call('GET', `/sites/${site.id}/imprese-oggi`, { company: A.id })).status === 404);

    // ── Regole pure ──
    const fine = 18 * 60;
    const at = (h, m) => new Date(`2026-10-12T${String(h - 2).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`).toISOString(); // ora legale: Roma = UTC+2
    const pres = [{ sub_worker_id: 'a', site_id: 's', event: 'entrata', at: at(7, 40), source: 'qr' }, { sub_worker_id: 'b', site_id: 's', event: 'entrata', at: at(19, 0), source: 'qr' }];
    const sera = S.statoPersone(pres, { nowIso: at(20, 0), fineMin: fine });
    check('dopo la fine della giornata: chi è entrato al mattino ha l\'uscita non segnata', sera.get('a').dentroSito === null && sera.get('a').uscitaNonSegnata === 's');
    check('turno di sera (entrato dopo la fine): resta dentro', sera.get('b').dentroSito === 's');
    check('documenti: DURC scaduto → scaduti', S.documentiImpresa({ durc_expiry: past, insurance_expiry: future }).stato === 'scaduti');
    check('documenti: nessuna data → mancanti', S.documentiImpresa({}).stato === 'mancanti');

    // ── RLS: chiusa a chi non è il backend ──
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    for (const t of ['sub_workers', 'sub_presenze', 'sub_squad_links', 'sub_impresa_ignota']) {
      const { data, error } = await anon.from(t).select('id').eq('company_id', A.id);
      check(`RLS: ${t} invisibile con la chiave pubblica`, !!error || (data || []).length === 0, { error: error?.message, n: data?.length });
    }
  } finally {
    server.close();
    for (const c of [A, B]) {
      for (const t of ['sub_presenze', 'sub_squad_links', 'sub_impresa_ignota', 'sub_workers', 'presence_logs', 'company_feature_flags', 'site_subcontractors', 'workers', 'subcontractors', 'sites']) {
        await supabase.from(t).delete().eq('company_id', c.id);
      }
      await supabase.from('companies').delete().eq('id', c.id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
