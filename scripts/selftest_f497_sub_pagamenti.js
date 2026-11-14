#!/usr/bin/env node
/**
 * scripts/selftest_f497_sub_pagamenti.js
 *
 * Regressione per F-497 (AUDIT.md del frontend, 14/11/2026): Subappaltatori,
 * lavori e pagamenti. Prima non c'era un posto dove segnare quanto si è pagato
 * a un sub, come, quanto manca e quanto gli si deve per il lavoro fatto.
 *
 * 1. I conti (puri): a corpo con i quarti, a ore, a giornata; «gli devi»,
 *    «in pari», «anticipo», «tutto pagato».
 * 2. Dal vivo (API di produzione, sessioni vere, flag conti_sub acceso):
 *    accordo a corpo e a ore, pagamenti con il modo, contanti oltre il limite
 *    rifiutati, lavoro a quarti che chiede la foto, giornate dal QR e a mano
 *    (la mano vince), lavorazioni sintetiche, elenco e totali, scheda impresa,
 *    togli pagamento. Il tecnico riceve 403 ovunque.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY o SUPABASE_KEY.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '') + '/api/v1';
const URL_ = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
// Un PNG di 1×1 pixel: la «foto» del lavoro
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const romaOggi = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const giornoFa = (n) => { const d = new Date(`${romaOggi()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

async function main() {
  console.log('\nPalladia regression — F-497: subappaltatori, lavori e pagamenti\n');

  // 1. I conti
  const { numeri } = require('../lib/subPagamenti');
  const corpo = { tipo: 'corpo', importo: 11000, fatto_quarti: 3, ore_giornata: 8 };
  let n = numeri(corpo, 0, 5500);
  check('a corpo: ¾ di 11.000 € = 8.250 € di lavoro, pagati 5.500 → gli devi 2.750, mancano 5.500', n.lavorato === 8250 && n.adesso === 2750 && n.manca === 5500 && n.stato === 'deve', n);
  n = numeri({ ...corpo, fatto_quarti: 1 }, 0, 5500);
  check('a corpo: pagato più del fatto → anticipo', n.stato === 'anticipo' && n.adesso === -2750, n);
  n = numeri({ ...corpo, fatto_quarti: 4 }, 0, 11000);
  check('a corpo: pagato tutto → «tutto pagato», manca 0', n.stato === 'tutto' && n.manca === 0, n);
  n = numeri({ tipo: 'ore', tariffa: 28, ore_giornata: 8 }, 27, 5000);
  check('a ore: 27 giornate × 8 h × 28 € = 6.048 €, pagati 5.000 → gli devi 1.048, manca null', n.lavorato === 6048 && n.adesso === 1048 && n.manca === null, n);
  n = numeri({ tipo: 'giornata', tariffa: 220, ore_giornata: 8 }, 2.5, 550);
  check('a giornata: 2 giornate e mezza × 220 € = 550 €, pagati 550 → in pari', n.lavorato === 550 && n.stato === 'pari', n);

  if (!URL_ || !SERVICE || !ANON) { console.log('  – skip parte dal vivo: Supabase non configurato'); return fine(); }
  const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: co, error: cErr } = await admin.from('companies').insert([{ name: 'TEST-F497-SubPagamenti' }]).select('id').single();
  if (cErr) throw new Error('company: ' + cErr.message);
  const CO = co.id; const token = {}; const userIds = {};
  try {
    await admin.from('company_feature_flags').upsert({ company_id: CO, feature: 'conti_sub', enabled: true }, { onConflict: 'company_id,feature' });
    for (const role of ['owner', 'tech']) {
      const email = `test-f497-${role}-${crypto.randomUUID()}@example.com`;
      const { data: u, error } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
      if (error) throw new Error('createUser: ' + error.message);
      userIds[role] = u.user.id;
      await admin.from('company_users').insert([{ company_id: CO, user_id: u.user.id, role }]);
      const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      const { data: ses, error: vErr } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
      if (vErr) throw new Error('verifyOtp: ' + vErr.message);
      token[role] = ses.session.access_token;
    }
    const { data: sub } = await admin.from('subcontractors').insert({ company_id: CO, company_name: 'TEST-F497 Massetti SRL' }).select('id').single();
    const { data: s1 } = await admin.from('sites').insert({ company_id: CO, name: 'TEST-F497 Via Uno', address: 'Via Uno 1, Genova', status: 'attivo' }).select('id').single();
    const { data: s2 } = await admin.from('sites').insert({ company_id: CO, name: 'TEST-F497 Via Due', address: 'Via Due 2, Genova', status: 'attivo' }).select('id').single();

    const call = async (role, method, path, body, form) => {
      const headers = { Authorization: `Bearer ${token[role]}`, 'X-Company-Id': CO };
      let b;
      if (form) { b = new FormData(); for (const [k, v] of Object.entries(form)) b.append(k, v); }
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
      const r = await fetch(BASE + path, { method, headers, body: b });
      let j = null; try { j = await r.json(); } catch { /* */ }
      return { status: r.status, body: j };
    };

    // Accordi
    let r = await call('owner', 'POST', '/subappalti', { subcontractorId: sub.id, siteId: s1.id, tipo: 'corpo' });
    check('accordo a corpo senza cifra → 400 MANCA_CIFRA', r.status === 400 && r.body?.error === 'MANCA_CIFRA', r);
    r = await call('owner', 'POST', '/subappalti', { subcontractorId: sub.id, siteId: s1.id, tipo: 'corpo', importo: '11.000', dataAccordo: giornoFa(30) });
    check('accordo a corpo 11.000 € → 201', r.status === 201 && r.body?.id, r);
    const A1 = r.body?.id;
    r = await call('owner', 'POST', '/subappalti', { subcontractorId: sub.id, siteId: s1.id, tipo: 'ore', tariffa: 28 });
    check('secondo accordo stessa impresa e cantiere → 409 ESISTE con l’id', r.status === 409 && r.body?.id === A1, r);
    r = await call('owner', 'POST', '/subappalti', { subcontractorId: sub.id, siteId: s2.id, tipo: 'ore', tariffa: 28 });
    check('accordo a ore 28 €/ora su un altro cantiere → 201', r.status === 201, r);
    const A2 = r.body?.id;

    // Pagamenti
    r = await call('owner', 'POST', `/subappalti/${A1}/pagamenti`, null, { importo: '1.000', modo: 'contanti', data: giornoFa(20), riferimento: 'acconto' });
    check('pagamento 1.000 € in contanti → 201', r.status === 201 && r.body?.importo === 1000, r);
    r = await call('owner', 'POST', `/subappalti/${A1}/pagamenti`, null, { importo: '2.000', modo: 'assegno', riferimento: 'n. 0034561', data: giornoFa(10), prova: new Blob([PNG], { type: 'image/png' }) });
    check('pagamento 2.000 € con assegno e foto → 201', r.status === 201, r);
    r = await call('owner', 'POST', `/subappalti/${A1}/pagamenti`, null, { importo: '5000', modo: 'contanti' });
    check('5.000 € in contanti → 400 CONTANTI_OLTRE_LIMITE', r.status === 400 && r.body?.error === 'CONTANTI_OLTRE_LIMITE', r);
    r = await call('owner', 'POST', `/subappalti/${A1}/pagamenti`, null, { importo: '100', modo: 'bonifico', data: '2099-01-01' });
    check('pagamento con data futura → 400', r.status === 400, r);
    r = await call('owner', 'POST', `/subappalti/${A1}/pagamenti`, null, { importo: '2500', modo: 'bonifico' });
    check('pagamento 2.500 € con bonifico (data di oggi) → 201', r.status === 201 && r.body?.data === romaOggi(), r);

    // Lavoro a quarti
    r = await call('owner', 'POST', `/subappalti/${A1}/lavoro`, null, { quarti: '3' });
    check('lavoro a ¾ senza foto → 400 SERVE_FOTO', r.status === 400 && r.body?.error === 'SERVE_FOTO', r);
    r = await call('owner', 'POST', `/subappalti/${A1}/lavoro`, null, { quarti: '3', foto: new Blob([PNG], { type: 'image/png' }) });
    check('lavoro a ¾ con la foto → ok', r.status === 200 && r.body?.quarti === 3, r);
    r = await call('owner', 'POST', `/subappalti/${A1}/lavori`, { nome: 'Massetti piano 1' });
    check('lavorazione sintetica aggiunta', r.status === 201, r);
    const L1 = r.body?.id;
    r = await call('owner', 'PATCH', `/subappalti/${A1}/lavori/${L1}`, { quarti: 4 });
    check('lavorazione segnata finita', r.status === 200, r);

    r = await call('owner', 'GET', `/subappalti/${A1}`);
    const c1 = r.body;
    check('conto a corpo: lavorato 8.250, pagato 5.500, gli devi 2.750, mancano 5.500', r.status === 200 && c1.lavorato === 8250 && c1.pagato === 5500 && c1.adesso === 2750 && c1.manca === 5500 && c1.stato === 'deve', c1 && { lavorato: c1.lavorato, pagato: c1.pagato, adesso: c1.adesso, manca: c1.manca });
    check('conto: 3 pagamenti, il più recente in cima, la foto dell’assegno firmata', c1?.pagamenti?.length === 3 && c1.pagamenti[0].modo === 'bonifico' && c1.pagamenti.some(p => p.modo === 'assegno' && /^https?:/.test(p.prova || '')), c1?.pagamenti);
    check('conto: la foto del lavoro e la lavorazione finita', c1?.foto?.length === 1 && c1.lavori?.[0]?.quarti === 4, { foto: c1?.foto?.length, lavori: c1?.lavori });

    // Giornate: QR + a mano
    const { data: sw } = await admin.from('sub_workers').insert([{ company_id: CO, subcontractor_id: sub.id, full_name: 'Operaio Uno', added_via: 'ufficio' }, { company_id: CO, subcontractor_id: sub.id, full_name: 'Operaio Due', added_via: 'ufficio' }]).select('id');
    const g1 = giornoFa(2), g2 = giornoFa(1);
    const ins = await admin.from('sub_presenze').insert([
      { company_id: CO, site_id: s2.id, subcontractor_id: sub.id, sub_worker_id: sw[0].id, event: 'entrata', source: 'qr', at: `${g1}T07:00:00+01:00` },
      { company_id: CO, site_id: s2.id, subcontractor_id: sub.id, sub_worker_id: sw[1].id, event: 'entrata', source: 'qr', at: `${g1}T07:10:00+01:00` },
      { company_id: CO, site_id: s2.id, subcontractor_id: sub.id, sub_worker_id: sw[0].id, event: 'entrata', source: 'qr', at: `${g2}T07:00:00+01:00` },
    ]);
    if (ins.error) console.log('    (presenze QR non inserite: ' + ins.error.message + ')');
    r = await call('owner', 'GET', `/subappalti/${A2}`);
    check('a ore: dal QR 2 persone + 1 persona = 3 giornate = 672 €', r.body?.giornate === 3 && r.body?.lavorato === 672, r.body && { giornate: r.body.giornate, lavorato: r.body.lavorato });
    r = await call('owner', 'PUT', `/subappalti/${A2}/giorni/${g2}`, { giornate: 0.5 });
    check('giornata a mano (mezza) sopra il QR → ok', r.status === 200, r);
    r = await call('owner', 'PUT', `/subappalti/${A2}/giorni/${giornoFa(-3)}`, { giornate: 1 });
    check('giorno futuro → 400', r.status === 400, r);
    r = await call('owner', 'GET', `/subappalti/${A2}?mese=${g2.slice(0, 7)}`);
    const dg2 = r.body?.calendario?.righe?.find(x => x.giorno === g2);
    check('la mano vince: quel giorno vale ½ (fonte mano), totale 2,5 giornate = 560 €', dg2?.giornate === 0.5 && dg2?.fonte === 'mano' && r.body?.giornate === 2.5 && r.body?.lavorato === 560, { dg2, giornate: r.body?.giornate, lavorato: r.body?.lavorato });
    r = await call('owner', 'PUT', `/subappalti/${A2}/giorni/${g2}`, {});
    r = await call('owner', 'GET', `/subappalti/${A2}`);
    check('tolta la mano, torna il QR: 3 giornate', r.body?.giornate === 3, r.body?.giornate);

    // Elenco e scheda impresa
    r = await call('owner', 'GET', '/subappalti');
    check('elenco: 2 accordi; da pagare adesso 2.750 + 672 = 3.422 €; pagato quest’anno 5.500; manca 5.500', r.body?.righe?.length === 2 && r.body.totali.adesso === 3422 && r.body.totali.pagatoAnno === 5500 && r.body.totali.manca === 5500 && r.body.totali.contantiAnno === 1, r.body?.totali);
    r = await call('owner', 'GET', `/subappalti/impresa/${sub.id}`);
    check('scheda impresa: i suoi 2 cantieri', Array.isArray(r.body) && r.body.length === 2, r.body);
    r = await call('owner', 'GET', '/subappalti/opzioni');
    check('opzioni: impresa, 2 cantieri, 2 accordi esistenti', r.body?.imprese?.length === 1 && r.body?.cantieri?.length === 2 && r.body?.esistenti?.length === 2, r.body);

    // Togli pagamento
    const ultimo = c1.pagamenti[0].id;
    r = await call('owner', 'DELETE', `/subappalti/${A1}/pagamenti/${ultimo}`);
    r = await call('owner', 'GET', `/subappalti/${A1}`);
    check('tolto il bonifico (sbagliato): pagato 3.000, gli devi 5.250', r.body?.pagato === 3000 && r.body?.adesso === 5250, r.body && { pagato: r.body.pagato, adesso: r.body.adesso });

    // Modifica accordo
    r = await call('owner', 'PATCH', `/subappalti/${A1}`, { importo: 12000 });
    r = await call('owner', 'GET', `/subappalti/${A1}`);
    check('accordo modificato a 12.000 €: ¾ = 9.000 €', r.body?.importo === 12000 && r.body?.lavorato === 9000, r.body && { importo: r.body.importo, lavorato: r.body.lavorato });

    // Il tecnico non vede i soldi
    for (const [m, p] of [['GET', '/subappalti'], ['GET', `/subappalti/${A1}`], ['GET', '/subappalti/opzioni'], ['GET', `/subappalti/impresa/${sub.id}`]]) {
      r = await call('tech', m, p);
      check(`tecnico: ${m} ${p.replace(A1, ':id').replace(sub.id, ':sub')} → 403`, r.status === 403, r);
    }
    r = await call('tech', 'POST', `/subappalti/${A1}/pagamenti`, null, { importo: '10', modo: 'bonifico' });
    check('tecnico: segna pagamento → 403', r.status === 403, r);

    // Flag spento → 404
    await admin.from('company_feature_flags').upsert({ company_id: CO, feature: 'conti_sub', enabled: false }, { onConflict: 'company_id,feature' });
    r = await call('owner', 'GET', '/subappalti');
    check('flag conti_sub spento → 404 NON_ATTIVO', r.status === 404, r);
  } finally {
    const { data: accs } = await admin.from('sub_accordi').select('id').eq('company_id', CO);
    const ids = (accs || []).map(a => a.id);
    if (ids.length) {
      const paths = [];
      for (const t of ['sub_pagamenti', 'sub_foto']) {
        const { data } = await admin.from(t).select(t === 'sub_foto' ? 'path' : 'prova_path').in('accordo_id', ids);
        paths.push(...(data || []).map(d => d.path || d.prova_path).filter(Boolean));
      }
      if (paths.length) await admin.storage.from('site-documents').remove(paths);
      await admin.from('sub_accordi').delete().eq('company_id', CO);
    }
    await admin.from('sub_presenze').delete().eq('company_id', CO);
    await admin.from('sub_workers').delete().eq('company_id', CO);
    await admin.from('subcontractors').delete().eq('company_id', CO);
    await admin.from('sites').delete().eq('company_id', CO);
    await admin.from('company_feature_flags').delete().eq('company_id', CO);
    await admin.from('company_users').delete().eq('company_id', CO);
    await admin.from('companies').delete().eq('id', CO);
    for (const id of Object.values(userIds)) await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  return fine();
}
function fine() {
  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
