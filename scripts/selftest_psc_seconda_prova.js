#!/usr/bin/env node
/**
 * scripts/selftest_psc_seconda_prova.js — F-303→F-315 (AUDIT.md del frontend).
 * Seconda prova della coordinatrice sul PSC (Via Verdi 13, Savona, 08/10/2026).
 *
 * Funzioni pure:
 *  - F-303: Overpass che cade (pagina HTML "too busy", 504) non blocca: si passa
 *    al server successivo; se cadono tutti, l'indirizzo trovato resta (parziale);
 *  - F-304: pronto soccorso di Savona = Ospedale San Paolo (senza emergency=yes),
 *    non la Casa della Comunità (emergency=yes ma niente PS) né Cairo Montenotte;
 *    sempre "da confermare", e il controllo lo ricorda;
 *  - F-305: entità presunta scritta dal coordinatore, non la somma dei predefiniti;
 *  - F-307: scheda "Impianto idrico di cantiere", gruppo dei lavori interni;
 *  - F-308: quarta scelta "Non è un'interferenza";
 *  - F-310: prezzario Liguria 2026 scelto per Savona; costi 2025 aggiornabili;
 *  - F-311/F-315: dati impresa, rischi verso l'area circostante, attrezzature
 *    in un capitolo unico, nel PDF.
 * HTTP vere (PSC_API_URL, default produzione), con un coordinatore temporaneo:
 *  - F-305: una lavorazione nuova non ha più 3 addetti e 30 uomini-giorno;
 *  - F-311: i dati impresa si salvano;
 *  - F-308: "compatibili" si salva (vincolo del DB);
 *  - F-310: aggiorna-prezzario porta il prezzo della recinzione da 7,51 a 8,01.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../lib/supabase');
const Ctx = require('../lib/psc/contesto');
const D = require('../lib/psc/documento');
const P = require('../lib/psc/prezzario');
const I = require('../lib/psc/interferenze');
const L = require('../lib/psc/lavorazioni');
const { controlla } = require('../lib/psc/controllo');

let failed = 0, passed = 0;
const check = (name, ok, info) => { console.log(`${ok ? '✓' : '✗'} ${name}${!ok && info !== undefined ? `  → ${JSON.stringify(info).slice(0, 400)}` : ''}`); ok ? passed++ : failed++; };

const SAVONA = { lat: 44.3163112, lon: 8.4762204 };
const el = (type, id, lat, lon, tags) => ({ type, id, center: { lat, lon }, tags });

async function pure() {
  // ── F-304 ──
  const els = [
    el('node', 1, 44.3170, 8.4770, { amenity: 'hospital', name: 'Casa della Comunità di Savona', emergency: 'yes', healthcare: 'hospital' }),
    el('node', 2, 44.3150, 8.4740, { amenity: 'hospital', name: 'RSA del Santuario' }),
    el('way', 3, 44.3040, 8.4560, { amenity: 'hospital', name: 'Ospedale San Paolo', 'addr:city': 'Savona' }),
    el('way', 4, 44.3960, 8.2440, { amenity: 'hospital', name: 'Ospedale San Giuseppe', emergency: 'yes', 'addr:city': 'Cairo Montenotte' }),
    el('way', 5, 44.3100, 8.4600, { amenity: 'hospital', name: 'Ospedale vecchio chiuso', emergency: 'no' }),
  ];
  const ps = Ctx.sceglieProntoSoccorso(els, SAVONA.lat, SAVONA.lon);
  check('F-304: Savona → Ospedale San Paolo, non la Casa della Comunità né Cairo Montenotte', ps && ps.nome === 'Ospedale San Paolo', ps);
  check('F-304: distanza plausibile (sotto i 5 km) e "da confermare"', ps && ps.distanza_km < 5 && ps.da_confermare === true, ps);
  // Dati veri di OSM a Savona: il punto più vicino è l'ingresso "Emergency Room" del San Paolo
  const er = Ctx.sceglieProntoSoccorso([el('node', 861803093, 44.3045, 8.4585, { amenity: 'hospital', name: 'Emergency Room' }), els[2], els[3]], SAVONA.lat, SAVONA.lon);
  check('F-304: ingresso "Emergency Room" → nel PSC "Ospedale San Paolo · Pronto soccorso"', er && er.nome === 'Ospedale San Paolo · Pronto soccorso' && /Savona/.test(er.indirizzo || ''), er);
  check('F-304: senza ospedali veri nessuna proposta', Ctx.sceglieProntoSoccorso([els[0], els[1]], SAVONA.lat, SAVONA.lon) === null);

  // ── F-303 ──
  const seen = [];
  const fakeFetch = (fail) => async (url, opts) => {
    if (String(url).includes('nominatim')) return { ok: true, json: async () => [{ lat: String(SAVONA.lat), lon: String(SAVONA.lon), display_name: '13, Via Giuseppe Verdi, Savona', address: { city: 'Savona', county: 'Savona' } }] };
    seen.push(url);
    if (fail(url)) {
      if (url.includes('overpass-api.de')) return { ok: true, json: async () => { throw new Error('HTML: server too busy'); } };
      return { ok: false, status: 504, json: async () => ({}) };
    }
    const q = decodeURIComponent(String(opts.body).slice(5));
    return { ok: true, json: async () => ({ elements: /hospital\]/.test(q) && /around:12000/.test(q) ? els : [] }) };
  };
  const ok2 = await Ctx.overpass('[out:json];node(1);out;', fakeFetch(u => !u.includes('private.coffee')), { pausaMs: 1 });
  check('F-303: due server giù (HTML "too busy" e 504) → risponde il terzo', Array.isArray(ok2) && seen.some(u => u.includes('private.coffee')));
  let err = null;
  try { await Ctx.overpass('[out:json];node(1);out;', fakeFetch(() => true), { pausaMs: 1 }); } catch (e) { err = e; }
  check('F-303: tutti giù → errore (dopo due giri)', !!err);
  const parz = await Ctx.analizza('Via Verdi 13, Savona', { fetchImpl: fakeFetch(() => true), prev: { trovati: [{ key: 'strada', titolo: 'Strada' }] } });
  check('F-303: mappa dei dintorni giù ma indirizzo trovato → parziale, coordinate salvate, dintorni di prima conservati', parz.ok && parz.parziale && parz.lat === SAVONA.lat && parz.comune === 'Savona' && parz.contesto.trovati.length === 1, parz);

  // F-303: server che non rispondono mai → la ricerca si ferma entro il budget (la rotta ha un limite di 60 s)
  const lento = async (url, opts) => {
    if (String(url).includes('nominatim')) return { ok: true, json: async () => [{ lat: String(SAVONA.lat), lon: String(SAVONA.lon), display_name: 'Savona', address: { city: 'Savona' } }] };
    // come una connessione vera: tiene vivo il processo finché non scade (AbortSignal.timeout non lo fa)
    return new Promise((_, rej) => { const keep = setTimeout(() => {}, 120000); opts.signal.addEventListener('abort', () => { clearTimeout(keep); rej(new Error('timeout')); }); });
  };
  const t0 = Date.now();
  const lr = await Ctx.analizza('Via Verdi 13, Savona', { fetchImpl: lento, budgetMs: 6000 });
  check('F-303: server bloccati → risposta entro il budget, indirizzo salvato (parziale)', Date.now() - t0 < 9000 && lr.ok && lr.parziale, { ms: Date.now() - t0, parziale: lr.parziale });

  // ── F-305 ──
  const lav = [
    { id: 'a', nome: 'Allestimento e smobilizzo del cantiere', uomini_giorno: 30, rischi: [{ testo: 'Investimento da mezzi in manovra' }], apprestamenti: [{ nome: 'Autogru o gru su autocarro', verifica: 'Verifiche periodiche' }] },
    { id: 'b', nome: 'Spicconatura di intonaci e rivestimenti di facciata', uomini_giorno: 30, rischi: [{ testo: 'Inalazione di polveri' }, { testo: 'Rumore' }], apprestamenti: [{ nome: 'Martello demolitore', verifica: '' }, { nome: 'Autogru o gru su autocarro', verifica: '' }] },
  ];
  check('F-305: entità presunta = quella scritta dal coordinatore', D.entitaPresunta({ uomini_giorno: 45 }, lav).ug === 45 && D.entitaPresunta({ uomini_giorno: 45 }, lav).stima === false);
  check('F-305: senza valore del coordinatore = somma, dichiarata come stima', D.entitaPresunta({}, lav).ug === 60 && D.entitaPresunta({}, lav).stima === true);

  // ── F-315 ──
  const ve = D.rischiVersoEsterno(lav).map(r => r.key);
  check('F-315: rischi verso l\'area circostante dalle lavorazioni (rumore, polveri, caduta, mezzi)', ['rumore', 'polveri', 'caduta', 'mezzi'].every(k => ve.includes(k)), ve);
  const cad = D.rischiVersoEsterno([{ nome: 'Intonaci e rasature', rischi: [{ testo: 'Caduta da ponti su cavalletti, trabattelli o ponteggio' }] }, { nome: 'Montaggio, trasformazione e smontaggio del ponteggio', rischi: [] }]).find(r => r.key === 'caduta');
  check('F-315: caduta di materiali dal ponteggio sì, la caduta del lavoratore "dal ponteggio" negli intonaci no', cad && cad.lavorazioni.length === 1 && /ponteggio/.test(cad.lavorazioni[0]), cad);
  const at = D.attrezzatureDi(lav);
  check('F-315: attrezzature in un elenco unico, senza doppioni, con le lavorazioni che le usano', at.length === 2 && at.find(a => a.nome === 'Autogru o gru su autocarro').lavorazioni.length === 2, at);

  // ── F-311 ──
  const imp = { id: 'i1', ragione_sociale: 'Liguria Coperture Srl', ruolo: 'affidataria', datore_lavoro: 'Jahaj Eldis', indirizzo: 'Via Turati 23R', cap: '17100', citta: 'Savona (SV)', posizione_inps: 'SV - 74062097870', posizione_inail: 'SV - 20875457/85', cassa_edile: 'SV - 9978', codice_fiscale: '01851900090', art97_nome: 'Jahaj Eldis', art97_mansione: 'Datore di lavoro' };
  const html = D.datiImpresa(imp, [{ nome: 'Allestimento', impresa_id: 'i1' }]);
  check('F-311: nel PDF datore di lavoro, sede, INPS, INAIL, Cassa Edile, art. 97', ['Jahaj Eldis', 'Via Turati 23R, 17100 Savona (SV)', 'SV - 74062097870', 'SV - 20875457/85', 'SV - 9978', 'Incaricato art. 97'].every(t => html.includes(t)), html.slice(0, 300));

  // ── F-308 ──
  const lavById = new Map([['x', { id: 'x', nome: 'Allestimento e smobilizzo del cantiere', start_date: '2026-10-15', end_date: '2026-10-16', area: 'Cortile' }], ['y', { id: 'y', nome: 'Impianto elettrico di cantiere', start_date: '2026-10-15', end_date: '2026-10-16', area: 'Cortile' }]]);
  const sol = I.soluzioni({ lav_a: 'x', lav_b: 'y', area: 'Cortile', dal: '2026-10-15', al: '2026-10-16' }, lavById, new Map(), '2026-12-13', {});
  check('F-308: quarta scelta "Non è un\'interferenza"', sol.opzioni.length === 4 && sol.opzioni[3].soluzione === 'compatibili' && /contemporanea/.test(sol.opzioni[3].testo), sol.opzioni.map(o => o.soluzione));

  // ── F-310 ──
  const reg = P.regionalePer({ comune: 'Savona', provincia: 'Savona' });
  check('F-310: per Savona il Prezzario Liguria 2026', reg && reg.anno === 2026, reg && reg.nome);
  const agg = P.aggiornamentiPrezzario([
    { id: 'c1', codice: '95.A10.A10.010', prezzo: 7.51, prezzo_fonte: 'prezzario', prezzario_fonte: 'Prezzario Regione Liguria 2025 · Sicurezza' },
    { id: 'c2', codice: null, prezzo: 35, prezzo_fonte: 'manuale', prezzario_fonte: null },
    { id: 'c3', codice: '95.A10.A10.010', prezzo: 8.01, prezzo_fonte: 'prezzario', prezzario_fonte: 'Prezzario Regione Liguria 2026 · Sicurezza' },
  ], { comune: 'Savona' });
  check('F-310: solo le voci del 2025 si aggiornano, recinzione 7,51 → 8,01', agg.voci.length === 1 && agg.voci[0].id === 'c1' && agg.voci[0].a === 8.01, agg);

  // ── F-307 ──
  const cat = L.catalogo();
  check('F-307: scheda "Impianto idrico di cantiere"', cat.some(s => s.id === 'impianto-idrico-cantiere' && s.categoria === 'allestimento'));
  check('F-307: almeno 20 lavori interni raggruppati', cat.filter(s => s.interno).length >= 20, cat.filter(s => s.interno).length);
  check('F-307: cercando "idrico" si trova anche Allestimento (voce compresa)', /idrico/i.test(cat.find(s => s.id === 'allestimento-cantiere').alias));

  // ── F-304 nel controllo ──
  const ctl = controlla({ project: { title: 'x', emergenze: { pronto_soccorso: { nome: 'Ospedale San Paolo', distanza_km: 2.1, da_confermare: true } }, uomini_giorno: 40 }, lavorazioni: [] });
  check('F-304: il controllo chiede di confermare il pronto soccorso', ctl.osservazioni.some(o => /Conferma il pronto soccorso/.test(o.testo)));
  const ctl2 = controlla({ project: { title: 'x', emergenze: { pronto_soccorso: { nome: 'Ospedale San Paolo', da_confermare: true, confermato: true } } }, lavorazioni: [] });
  check('F-304: confermato → niente avviso', !ctl2.osservazioni.some(o => /Conferma il pronto soccorso/.test(o.testo)));
  check('F-305: il controllo (lettera i) usa l\'entità scritta dal coordinatore', ctl.contenuti.find(c => c.key === 'i').mancanze.every(m => !/uomini-giorno/.test(m)));
}

async function http() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log('SKIP HTTP: mancano le variabili Supabase'); return; }
  const API = (process.env.PSC_API_URL || 'https://palladia-backend-production.up.railway.app/api/v1').replace(/\/$/, '');
  const RUN = `TEST-E2E-PSC2-${Date.now().toString(36)}`;
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[01IO]/g, 'Z');
  const code = `CSE-${part()}-${part()}`;
  const email = `${RUN.toLowerCase()}@palladia-test.it`, pw = 'Prova-Psc2-2026!';
  let userId = null, cid = null;
  try {
    await supabase.from('psc_beta_invites').insert({ code, note: RUN });
    const { data: u, error } = await supabase.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { full_name: 'Arch. Prova' } });
    if (error) throw error;
    userId = u.user.id;
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    const { data: s } = await anon.auth.signInWithPassword({ email, password: pw });
    const jwt = s.session.access_token;
    const call = async (method, path, json) => {
      const headers = { Authorization: `Bearer ${jwt}` };
      if (cid) headers['X-Company-Id'] = cid;
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(`${API}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
      const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch { b = t; }
      return { status: r.status, body: b };
    };
    const setup = await call('POST', '/onboarding/setup', { company_name: `${RUN} Studio`, full_name: 'Arch. Prova', account_type: 'coordinatore', beta_code: code });
    cid = setup.body && setup.body.company_id;
    if (!cid) throw new Error(`onboarding fallito: ${JSON.stringify(setup)}`);
    const p = (await call('POST', '/psc/projects', { title: `${RUN} Via Verdi`, address: 'Via Verdi 13', comune: 'Savona', provincia: 'Savona' })).body.project;
    await call('PATCH', `/psc/projects/${p.id}`, { comune: 'Savona', provincia: 'Savona', start_date: '2026-10-15', end_date: '2026-12-13', uomini_giorno: 48 });

    // Facoltativo (PSC_LIVE_MAP=1): la rotta vera con OpenStreetMap. Fuori da npm test
    // perché dipende da server pubblici che cadono spesso (F-303).
    if (process.env.PSC_LIVE_MAP === '1') {
      await call('PATCH', `/psc/projects/${p.id}`, { address: 'Via Verdi 13' });
      const cx = await call('POST', `/psc/projects/${p.id}/contesto`);
      const psL = cx.body && cx.body.project && cx.body.project.emergenze && cx.body.project.emergenze.pronto_soccorso;
      check('LIVE F-303/F-304: contesto di Via Verdi 13 Savona → pronto soccorso a Savona, non Cairo Montenotte', cx.status === 200 && psL && /San Paolo/.test(psL.nome) && psL.distanza_km < 5 && psL.da_confermare, { status: cx.status, avviso: cx.body && cx.body.avviso, ps: psL });
    }
    const l1 = (await call('POST', `/psc/projects/${p.id}/lavorazioni`, { scheda_id: 'allestimento-cantiere' })).body.lavorazione;
    const l2 = (await call('POST', `/psc/projects/${p.id}/lavorazioni`, { scheda_id: 'impianto-cantiere' })).body.lavorazione;
    check('HTTP F-305: lavorazione nuova senza 3 addetti / 30 uomini-giorno inventati', l1 && l1.addetti == null && l1.uomini_giorno == null, l1 && { addetti: l1.addetti, ug: l1.uomini_giorno });
    const full1 = (await call('GET', `/psc/projects/${p.id}`)).body;
    check('HTTP F-305: entità presunta del coordinatore salvata', Number(full1.project.uomini_giorno) === 48, full1.project && full1.project.uomini_giorno);

    const imp = await call('POST', `/psc/projects/${p.id}/imprese`, { ragione_sociale: `${RUN} Liguria Coperture`, ruolo: 'affidataria', datore_lavoro: 'Jahaj Eldis', indirizzo: 'Via Turati 23R', cap: '17100', citta: 'Savona', codice_fiscale: '01851900090', posizione_inps: 'SV - 74062097870', posizione_inail: 'SV - 20875457/85', cassa_edile: 'SV - 9978', art97_nome: 'Jahaj Eldis', art97_mansione: 'Datore di lavoro' });
    const impRow = imp.body && (imp.body.impresa || imp.body);
    check('HTTP F-311: dati impresa salvati (datore, INPS, INAIL, Cassa Edile, art. 97)', impRow && impRow.datore_lavoro === 'Jahaj Eldis' && impRow.posizione_inail === 'SV - 20875457/85' && impRow.cassa_edile === 'SV - 9978' && impRow.art97_mansione === 'Datore di lavoro', imp);

    // le due lavorazioni nuove partono una dopo l'altra: si mettono sovrapposte nella stessa area
    await call('PATCH', `/psc/lavorazioni/${l1.id}`, { start_date: '2026-10-15', end_date: '2026-10-16', area: 'Cortile interno' });
    await call('PATCH', `/psc/lavorazioni/${l2.id}`, { start_date: '2026-10-15', end_date: '2026-10-16', area: 'Cortile interno' });
    const dec = await call('POST', `/psc/projects/${p.id}/interferenze`, { lav_a: l1.id, lav_b: l2.id, soluzione: 'compatibili' });
    const salvata = dec.status === 200 && (dec.body.decisioni || []).some(d => d.soluzione === 'compatibili');
    check('HTTP F-308: "Non è un\'interferenza" si salva', salvata, { status: dec.status, body: typeof dec.body === 'object' ? dec.body.error || (dec.body.decisioni || []).map(d => d.soluzione) : dec.body });

    const c = await call('POST', `/psc/projects/${p.id}/costi`, { categoria: 'a', codice: '95.A10.A10.010', descrizione: 'Recinzione di cantiere', um: 'm', quantita: 15, prezzo: 7.51 });
    const costoId = c.body && (c.body.costo ? c.body.costo.id : null);
    if (costoId) await supabase.from('psc_costi').update({ prezzo_fonte: 'prezzario', prezzario_fonte: 'Prezzario Regione Liguria 2025 · Sicurezza' }).eq('id', costoId);
    const full2 = (await call('GET', `/psc/projects/${p.id}`)).body;
    check('HTTP F-310: il progetto segnala le voci con prezzi 2025', full2.prezzarioAggiornabile && full2.prezzarioAggiornabile.voci === 1, full2.prezzarioAggiornabile);
    const ag = await call('POST', `/psc/projects/${p.id}/costi/aggiorna-prezzario`, {});
    const dopo = (ag.body.costi || []).find(x => x.id === costoId);
    check('HTTP F-310: aggiorna-prezzario porta la recinzione a 8,01 € (Liguria 2026)', ag.status === 200 && dopo && Number(dopo.prezzo) === 8.01 && /2026/.test(dopo.prezzario_fonte), { status: ag.status, dopo });
  } finally {
    if (cid) {
      for (const t of ['psc_segnalazioni', 'psc_nc', 'psc_verbali', 'psc_pos_checks', 'psc_revisions', 'psc_interferenze', 'psc_costi', 'psc_lavorazioni', 'psc_imprese', 'psc_projects', 'psc_library', 'psc_imports', 'company_feature_flags', 'company_users']) await supabase.from(t).delete().eq('company_id', cid);
      await supabase.from('companies').delete().eq('id', cid);
    }
    if (userId) await supabase.auth.admin.deleteUser(userId).catch(() => {});
    await supabase.from('psc_beta_invites').delete().eq('code', code);
  }
}

let finito = false;
// Se il processo si svuota prima del riepilogo (una promessa mai risolta), è un fallimento, non un successo.
process.on('beforeExit', () => { if (!finito) { console.error('✗ lo script è finito prima del riepilogo'); process.exitCode = 1; } });
(async () => {
  console.log('\nF-303→F-315 — seconda prova della coordinatrice sul PSC');
  await pure();
  await http();
  finito = true;
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
