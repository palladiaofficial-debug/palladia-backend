#!/usr/bin/env node
/**
 * scripts/selftest_welcome_email_account_type.js
 *
 * F-274 (AUDIT.md) — il coordinatore della sicurezza riceveva l'email di
 * benvenuto dell'impresa: "Crea il primo cantiere", "QR per le timbrature",
 * "Apri la dashboard" → /dashboard. Il testo deve dipendere dall'account_type.
 *
 * Controlla il contenuto costruito da buildWelcomeEmail (lo stesso usato da
 * sendWelcomeEmail), senza inviare email: niente rete, niente DB.
 */
'use strict';
const { buildWelcomeEmail } = require('../services/email');

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fail++; };

if (typeof buildWelcomeEmail !== 'function') {
  console.log('✗ buildWelcomeEmail non esportata da services/email.js');
  process.exit(1);
}

const coord = buildWelcomeEmail({ name: 'Amabile Prova', companyName: 'Studio Prova', accountType: 'coordinatore' });
const txt = (coord.subject + ' ' + coord.html).replace(/<[^>]+>/g, ' ');
check(!/timbratur/i.test(txt), 'coordinatore: niente timbrature');
check(!/primo cantiere|Inserisci i lavoratori|Genera il POS/i.test(txt), 'coordinatore: niente passi da impresa');
check(!/\/dashboard/.test(coord.html), 'coordinatore: nessun link a /dashboard');
check(/\/coordinatori/.test(coord.html), 'coordinatore: il pulsante porta a /coordinatori');
check(/PSC/.test(txt), 'coordinatore: parla di PSC');
check(!/L'azienda\s/.test(txt) && !/è pronta/.test(coord.subject), 'coordinatore: non lo chiama "azienda"');

const imp = buildWelcomeEmail({ name: 'Mario Rossi', companyName: 'Edilizia Rossi', accountType: 'impresa' });
check(/primo cantiere/i.test(imp.html) && /\/dashboard/.test(imp.html), 'impresa: email invariata');
const def = buildWelcomeEmail({ name: 'Mario Rossi', companyName: 'Edilizia Rossi' });
check(def.html === imp.html, 'senza account_type: come impresa');

// Il titolo professionale non è il nome: "Arch. Prova Giro" → "Ciao Prova", non "Ciao Arch."
for (const [full, atteso] of [['Arch. Prova Giro', 'Prova'], ['Ing. Mario Rossi', 'Mario'], ['geom. Luca Bianchi', 'Luca'], ['Dott.ssa Anna Neri', 'Anna'], ['Amabile Veiga', 'Amabile']]) {
  const e = buildWelcomeEmail({ name: full, companyName: 'X', accountType: 'coordinatore' });
  check(e.html.includes(`Ciao ${atteso},`) && e.subject.endsWith(atteso), `saluto: "${full}" → Ciao ${atteso}`);
}

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passati');
process.exit(fail ? 1 : 0);
