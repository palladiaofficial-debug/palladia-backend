#!/usr/bin/env node
/**
 * scripts/selftest_email_grafica_f356.js — F-356 (AUDIT.md del frontend).
 *
 * Nuova grafica delle email (modello approvato il 13/10/2026). Niente rete,
 * niente DB: costruisce le email con i builder di services/email.js.
 *
 *  - riepilogo del mattino: titolo = somma dei riquadri, una riga per operaio
 *    (due documenti scaduti = una riga «2 scaduti»), documenti dell'impresa
 *    con il tipo e non il nome del file, link a /documenti e /scadenze;
 *  - uscite mancanti: niente codice fiscale, l'avviso del cron dice che
 *    l'uscita è stata registrata in automatico, entrata di un altro giorno
 *    con la data;
 *  - cornice: un solo <h1> anche per le email che aprono il corpo con il
 *    proprio titolo; testi dell'azienda con escape.
 */
'use strict';
// Resend finto: registra le email invece di spedirle
const inviate = [];
process.env.RESEND_API_KEY = 'finta';
require.cache[require.resolve('resend')] = { exports: { Resend: class { constructor() { this.emails = { send: async o => { inviate.push(o); return { id: 'finta' }; } }; } } } };
const {
  buildDailyAlertDigest, buildMissingExitEmail, buildWelcomeEmail, sendPlainLayoutEmail,
} = require('../services/email');

let fail = 0;
const check = (ok, msg, got) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) { fail++; if (got !== undefined) console.log(`    got: ${JSON.stringify(got).slice(0, 400)}`); }
};
const testo = html => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const iso = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  // ── Riepilogo del mattino ────────────────────────────────────────────────
  const sections = {
    missingDocs: [{ id: 'w1', full_name: 'Catalano Arianna', missingTypes: ['Visita medica', 'Corso sicurezza'] }],
    workerExpiry: [
      { worker_id: 'w2', worker: { full_name: 'Binozi Armand' }, typeLabel: 'Visita medica', expiry_date: iso(-14), days: -14 },
      { worker_id: 'w2', worker: { full_name: 'Binozi Armand' }, typeLabel: 'Corso sicurezza', expiry_date: iso(-1), days: -1 },
      { worker_id: 'w3', worker: { full_name: 'Rossi Mario' }, typeLabel: 'Visita medica', expiry_date: iso(10), days: 10 },
    ],
    companyExpiry: [{ name: 'DURC.pdf', catLabel: 'DURC', ai_expiry_date: iso(-3), days: -3 }],
    equipmentExpiry: [{ type: 'Autocarro', model: 'Nissan Cabstar', plate_or_serial: 'BX120CW', issues: [{ label: 'Assicurazione', date: iso(-59), days: -59 }] }],
  };
  const d = buildDailyAlertDigest({ companyName: 'Edile <Prova> S.r.l.', sections });
  const t = testo(d.html);
  check(d.conteggi.totale === 6 && d.conteggi.mancano === 1 && d.conteggi.scaduti === 4 && d.conteggi.inScadenza === 1, 'conteggi: 1 manca, 4 scaduti, 1 in scadenza', d.conteggi);
  check(/6 cose da sistemare/.test(t) && /^6 cose da sistemare/.test(d.subject), 'titolo e oggetto = somma dei riquadri', d.subject);
  check(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(d.subject), 'oggetto senza emoji', d.subject);
  check((t.match(/Binozi Armand/g) || []).length === 1 && /2 scaduti/.test(t), 'Binozi: una riga con «2 scaduti»');
  check(/Visita medica · scaduta il/.test(t) && /Corso sicurezza · scaduto il/.test(t), 'scaduta/scaduto secondo il documento');
  check(/Scade tra 10 giorni/.test(t), 'in scadenza: «Scade tra 10 giorni»');
  check(/Scaduta da 59 giorni/.test(t), 'mezzo: «Scaduta da 59 giorni» (assicurazione)');
  check(/>DURC</.test(d.html) && !/DURC\.pdf/.test(d.html), 'impresa: il tipo, non il nome del file');
  check(t.indexOf('Catalano Arianna') < t.indexOf('Binozi Armand'), 'prima chi non ha i documenti');
  check(/href="[^"]*\/documenti"/.test(d.html) && /href="[^"]*\/scadenze"/.test(d.html), 'pulsanti: /documenti e Da fare');
  check(d.html.includes('Edile &lt;Prova&gt; S.r.l.') && !d.html.includes('<Prova>'), 'nome azienda con escape');
  check((d.html.match(/<h1/g) || []).length === 1, 'un solo titolo');
  check(buildDailyAlertDigest({ companyName: 'X', sections: { missingDocs: [], workerExpiry: [], companyExpiry: [], equipmentExpiry: [] } }) === null, 'niente da sistemare → nessuna email');

  // ── Uscite mancanti ──────────────────────────────────────────────────────
  const oggi = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const missingList = [
    { worker_name: 'Petriccione Raffaele', fiscal_code: 'PTRRFL80A01H501Z', site_name: 'Magazzino', last_entry_time: `${oggi}T05:44:00Z` },
    { worker_name: 'Rossi Mario', fiscal_code: 'RSSMRA80A01H501Z', site_name: 'Via Roma', last_entry_time: new Date(Date.now() - 2 * 864e5).toISOString() },
  ];
  const ex = await buildMissingExitEmail({ companyName: 'Prova', date: oggi, missingList, chiusuraAutomatica: true });
  const te = testo(ex.html);
  check(!/PTRRFL80A01H501Z|RSSMRA80A01H501Z/.test(ex.html), 'niente codici fiscali');
  check(/^2 operai non hanno timbrato l'uscita/.test(ex.subject), 'oggetto con il numero di operai', ex.subject);
  check(/uscita automatica/.test(te), 'dal cron: dice che l\'uscita è registrata in automatico');
  // L'ora italiana di 05:44Z: 07:44 con l'ora legale, 06:44 d'inverno (il test era fisso su 07:44)
  const oraEntrata = new Date(`${oggi}T05:44:00Z`).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  check(new RegExp(`entrato alle ${oraEntrata}`).test(te),'entrata di oggi: solo l\'ora');
  check(/entrato \S+ \d+ \S+ alle/.test(te), 'entrata di un altro giorno: con la data');
  check(/\/persone\?tab=presenze/.test(ex.html), 'pulsante alle presenze');
  const ex1 = await buildMissingExitEmail({ companyName: 'Prova', date: oggi, missingList: missingList.slice(0, 1) });
  check(/^1 operaio non ha timbrato/.test(ex1.subject) && !/uscita automatica/.test(testo(ex1.html)), 'controllo a mano: singolare e niente «automatica»');

  // ── Benvenuto ────────────────────────────────────────────────────────────
  const w = buildWelcomeEmail({ name: 'Mario Rossi', companyName: 'Edilizia Rossi' });
  check(/Benvenuto in Palladia, Mario/.test(testo(w.html)) && (w.html.match(/<h1/g) || []).length === 1, 'benvenuto: titolo col nome, uno solo');
  check(!/Rispondi a questa email/i.test(w.html), 'benvenuto: non promette risposte a noreply');

  // ── Cornice: chi apre il corpo con il proprio <h1> non ne riceve un secondo ──
  await sendPlainLayoutEmail({ to: 'x@example.com', subject: 's', title: 'Titolo', bodyHtml: '<h1>Titolo</h1><p>ciao</p>' });
  check(inviate[0] && (inviate[0].html.match(/<h1/g) || []).length === 1, 'corpo con <h1>: un titolo solo');

  console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passati');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
