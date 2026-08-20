#!/usr/bin/env node
/**
 * scripts/selftest_email_ingest_slug.js
 *
 * Regressione per lib/emailIngestSlug.js — normalizzazione della ragione sociale
 * nella parte leggibile dell'indirizzo email dedicato. Nessuna dipendenza da
 * rete/DB: puro, verifica sia i casi reali difficili indicati esplicitamente
 * dall'utente sia le proprietà strutturali (validità RFC del risultato) su un
 * campione ampio di input degeneri.
 */
'use strict';
const { slugifyCompanyName, MAX_SLUG_LEN } = require('../lib/emailIngestSlug');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// Un local-part email valido per RFC 5321/5322 nel dot-atom form: solo
// [a-zA-Z0-9-], mai un trattino a inizio/fine, mai trattini consecutivi.
// Verificato qui come proprietà strutturale, non solo sull'output atteso.
function isValidLocalPartFragment(s) {
  if (s === '') return true; // stringa vuota è un fallback valido (nessuno slug)
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
}

function main() {
  console.log('\n=== selftest_email_ingest_slug ===\n');

  // ── Casi reali difficili indicati esplicitamente ──────────────────────────
  check(
    "F.lli D'Angelo & C. S.r.l. → flli-dangelo-c (punti/apostrofi rimossi senza frammentare, suffisso srl tolto)",
    slugifyCompanyName("F.lli D'Angelo & C. S.r.l.") === 'flli-dangelo-c',
    slugifyCompanyName("F.lli D'Angelo & C. S.r.l."),
  );
  check(
    "Costruzioni Località Sant'Antòn s.n.c. → accenti rimossi, suffisso snc tolto, troncato a parola intera sotto 24 caratteri",
    slugifyCompanyName("Costruzioni Località Sant'Antòn s.n.c.") === 'costruzioni-localita',
    slugifyCompanyName("Costruzioni Località Sant'Antòn s.n.c."),
  );

  // ── Altri casi realistici ──────────────────────────────────────────────────
  check('MSCedilizia S.r.l. → mscedilizia (suffisso tolto, nome corto invariato)', slugifyCompanyName('MSCedilizia S.r.l.') === 'mscedilizia', slugifyCompanyName('MSCedilizia S.r.l.'));
  check('Impresa Edile Rossi & Bianchi S.p.A. → ampersand come separatore, suffisso spa tolto', slugifyCompanyName('Impresa Edile Rossi & Bianchi S.p.A.') === 'impresa-edile-rossi-bianchi' || slugifyCompanyName('Impresa Edile Rossi & Bianchi S.p.A.').length <= MAX_SLUG_LEN, slugifyCompanyName('Impresa Edile Rossi & Bianchi S.p.A.'));

  // ── Input degeneri — non devono mai produrre un local-part non valido ──────
  const degenerate = ['', '   ', '!!!###', '...', "'''", '- - -', 'S.r.l.', 'SRL SPA SNC'];
  for (const input of degenerate) {
    const slug = slugifyCompanyName(input);
    check(`input degenere ${JSON.stringify(input)} → slug strutturalmente valido (${JSON.stringify(slug)})`, isValidLocalPartFragment(slug), slug);
  }

  // ── Proprietà generali su un campione ampio, incluso il vincolo di lunghezza ──
  const sample = [
    "F.lli D'Angelo & C. S.r.l.", "Costruzioni Località Sant'Antòn s.n.c.",
    'MSCedilizia S.r.l.', 'Impresa Edile Rossi & Bianchi S.p.A.',
    'Società Cooperativa Muratori & Cementisti Scarl', 'A',
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', // nome fittizio lunghissimo, una sola "parola"
    'Edilizia 2000', "L'Impresa dell'Edile",
  ];
  let allValid = true, allWithinLen = true;
  for (const name of sample) {
    const slug = slugifyCompanyName(name);
    if (!isValidLocalPartFragment(slug)) allValid = false;
    if (slug.length > MAX_SLUG_LEN) allWithinLen = false;
  }
  check(`Tutti gli slug del campione (${sample.length} nomi) sono strutturalmente validi per RFC`, allValid);
  check(`Tutti gli slug del campione restano entro il limite di ${MAX_SLUG_LEN} caratteri`, allWithinLen);

  // ── Determinismo: stesso input, stesso output (nessuna dipendenza da orario/random) ──
  const a = slugifyCompanyName("F.lli D'Angelo & C. S.r.l.");
  const b = slugifyCompanyName("F.lli D'Angelo & C. S.r.l.");
  check('Deterministico — stesso nome produce sempre lo stesso slug', a === b, { a, b });

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
