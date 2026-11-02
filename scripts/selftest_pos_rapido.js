#!/usr/bin/env node
/**
 * scripts/selftest_pos_rapido.js — F-425 (AUDIT.md del frontend).
 *
 * Il POS «Ho già quasi tutto», su un'azienda di prova vera (DB):
 *  - la precompilazione riprende le risposte dell'ultimo POS della stessa impresa (lavorazioni,
 *    quota, mezzi, sostanze, impianti, orari) e dice da quale cantiere vengono;
 *  - un'azienda senza POS non ha niente da riprendere;
 *  - Da fare / Oggi: «Via Balbi parte … e non ha il POS» (parte entro 7 giorni), «A Corso Sardegna si
 *    lavora senza POS» (timbrature recenti); niente per chi ha il POS, per il magazzino dove il POS
 *    non serve, per un cantiere che parte tra 20 giorni; il tocco porta a /pos/rapido.
 */
'use strict';
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabase');
const { buildPosPrefill } = require('../lib/posPrefill');
const { buildDaFare } = require('../lib/daFare');
const { componi } = require('../lib/oggi');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 900)}`); failed++; }
}
const giorno = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });

(async () => {
  console.log('\n\x1b[1mF-425 — il POS «Ho già quasi tutto»\x1b[0m');
  const T = `TEST-F425-${Date.now()}`;
  const stamp = String(Date.now()).slice(-6);
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const co = await ins('companies', { name: T });
  const vuota = await ins('companies', { name: `${T}-vuota` });
  try {
    const sito = (c, nome, extra = {}) => ins('sites', { company_id: c, name: `${T} ${nome}`, address: `${nome}, Genova`, status: 'attivo', ...extra });
    const verdi = await sito(co.id, 'Via Verdi 13', { start_date: giorno(-60) });
    const balbi = await sito(co.id, 'Via Balbi 31', { start_date: giorno(3) });
    const sardegna = await sito(co.id, 'Corso Sardegna 2', { start_date: giorno(-10) });
    const magazzino = await sito(co.id, 'Magazzino', { documenti_non_servono: ['pos'] });
    await sito(co.id, 'Via Lontana 1', { start_date: giorno(20) });
    const vuotoSito = await sito(vuota.id, 'Via Nuova 1');

    await ins('pos_documents', { company_id: co.id, site_id: verdi.id, revision: 1, content: 'x', pos_data: {
      subcontractorId: null, selectedSchede: ['murature', 'intonaci'], lavoriInQuota: 'Sì, dal ponteggio', macchine: ['Gru a torre', 'Betoniera'],
      sostanze: ['Malte, cementi e calce'], impiantiCantiere: ['Impianto elettrico di cantiere'], inizioTurno: '07:30', oreLavorative: '8', pausaPranzo: '60',
    } });
    const w = await ins('workers', { company_id: co.id, full_name: `${T} Marco`, is_active: true, fiscal_code: `F425MAR${stamp}`, badge_code: `F425M${stamp}` });
    const at = (n, h) => new Date(`${giorno(n)}T${h}:00+01:00`).toISOString();
    for (const s of [sardegna, magazzino, verdi]) {
      await ins('presence_logs', { company_id: co.id, site_id: s.id, worker_id: w.id, event_type: 'ENTRY', timestamp_server: at(-2, '07:40'), method: 'worker_self_punch' });
    }

    const p = await buildPosPrefill(co.id, balbi.id, null);
    check('riprende le risposte dell\'ultimo POS della stessa impresa', p.ultimo && p.ultimo.schede.join() === 'murature,intonaci' && p.ultimo.quota === 'Sì, dal ponteggio' && p.ultimo.mezzi.join() === 'Gru a torre,Betoniera' && p.ultimo.sostanze.join() === 'Malte, cementi e calce', p.ultimo);
    check('…e dice da quale cantiere vengono', p.ultimo?.cantiere === `${T} Via Verdi 13` && /^\d{4}-\d{2}-\d{2}$/.test(p.ultimo.data), p.ultimo);
    check('…impianti e orari compresi', p.ultimo?.impianti.join() === 'Impianto elettrico di cantiere' && p.ultimo.inizioTurno === '07:30' && p.ultimo.ore === '8' && p.ultimo.pausa === '60', p.ultimo);
    const pv = await buildPosPrefill(vuota.id, vuotoSito.id, null);
    check('un\'azienda senza POS non ha niente da riprendere', pv.ultimo === null, pv.ultimo);

    const df = await buildDaFare(co.id, null, { role: 'owner' });
    const pos = df.items.filter(i => i.kind === 'pos');
    const per = (s) => pos.find(i => i.entityId === s.id);
    check('Via Balbi: «… parte … e non ha il POS», verso /pos/rapido', /^.+ Via Balbi 31 parte .+ e non ha il POS$/.test(per(balbi)?.title || '') && per(balbi).link === `/pos/rapido?siteId=${balbi.id}`, per(balbi));
    check('Corso Sardegna: «A … si lavora senza POS»', per(sardegna)?.title === `A ${T} Corso Sardegna 2 si lavora senza POS`, per(sardegna));
    check('niente per chi ha il POS, per il magazzino, per chi parte tra 20 giorni', pos.length === 2, pos.map(i => i.title));

    const o = componi({ items: df.items, oggi: df.today });
    const righe = [o.prima, ...o.poi].filter(Boolean);
    const riga = righe.find(r => r.titolo === per(balbi)?.title);
    check('su Oggi la riga di Via Balbi, arancione, «Te lo preparo con quello che so già»', riga && riga.tono === 'arancio' && riga.sotto === 'Te lo preparo con quello che so già' && riga.link === `/pos/rapido?siteId=${balbi.id}`, righe);
  } finally {
    for (const id of [co.id, vuota.id]) {
      await supabase.from('presence_logs').delete().eq('company_id', id);
      await supabase.from('pos_documents').delete().eq('company_id', id);
      await supabase.from('workers').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
