#!/usr/bin/env node
/**
 * scripts/selftest_imprese_email.js
 *
 * Test di regressione per F-410 (AUDIT.md del frontend): l'email di un
 * subappaltatore inoltrata a documenti-…@palladia.net diventa un caricamento
 * dei documenti delle imprese (F-401), che il titolare guarda e salva.
 * Usa l'azienda E2E (modulo imprese acceso). Niente lettura AI (senzaLavoro).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

const E2E = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const LOGO = Buffer.alloc(3000, 1); // immagine piccola della firma: non è un documento

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
}

(async () => {
  console.log('\n=== selftest_imprese_email (F-410) ===\n');
  let E;
  try { E = require('../lib/impreseEmail'); } catch (e) { check('lib/impreseEmail esiste', false, e.message); return fine(); }
  const { handleInboundWebhook } = require('../services/emailIngestWebhook');
  const { componi } = require('../lib/oggi');
  const creati = [];
  try {
    const a = await E.indirizzo(E2E, null);
    check('indirizzo documenti-…@palladia.net', /^documenti-[a-z0-9-]+-[a-f0-9]{6}@palladia\.net$/.test(a.indirizzo), a);
    check('sempre lo stesso indirizzo', (await E.indirizzo(E2E, null)).indirizzo === a.indirizzo);

    const r = await E.ricevi({ token: a.indirizzo.split('@')[0], da: 'Edil Prova <ufficio@edilprova.it>', oggetto: 'Documenti cantiere via Roma',
      files: [{ originalname: 'DURC.pdf', mimetype: 'application/pdf', buffer: PDF }, { originalname: 'image001.png', mimetype: 'image/png', buffer: LOGO }, { originalname: 'note.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: PDF }] }, { senzaLavoro: true });
    if (r.caricamentoId) creati.push(r.caricamentoId);
    check('l’email diventa un caricamento', r.esito === 'ricevuto' && !!r.caricamentoId, r);
    const { data: car } = await supabase.from('imprese_caricamenti').select('origine, email_da, email_oggetto, salvato_at').eq('id', r.caricamentoId).maybeSingle();
    check('origine email, mittente e oggetto scritti', car?.origine === 'email' && car?.email_da === 'ufficio@edilprova.it' && car?.email_oggetto === 'Documenti cantiere via Roma', car);
    const { data: file } = await supabase.from('imprese_caricamento_doc').select('nome_file').eq('caricamento_id', r.caricamentoId).eq('livello', 'file');
    check('solo il PDF: niente logo della firma né Word', (file || []).map(f => f.nome_file).join() === 'DURC.pdf', file);

    const el = await E.arrivati(E2E);
    const mio = el.find(x => x.id === r.caricamentoId);
    check('Imprese lo elenca tra gli arrivati per email', mio && mio.da === 'ufficio@edilprova.it' && mio.file === 1, mio);

    const home = componi({ email: [mio] });
    const riga = home.righe.find(x => x.id === `email:${mio.id}`);
    check('Oggi avvisa con il tasto per guardarli', riga && riga.link === `/imprese/carica?car=${mio.id}`, home.righe);

    const nessuno = await E.ricevi({ token: 'documenti-nessuno-000000', da: 'x@y.it', oggetto: '', files: [{ originalname: 'a.pdf', mimetype: 'application/pdf', buffer: PDF }] }, { senzaLavoro: true });
    check('indirizzo sconosciuto: niente caricamento', nessuno.esito === 'sconosciuto' && !nessuno.caricamentoId, nessuno);

    // Il webhook delle email (lo stesso delle fatture) passa i documenti-… a questo canale
    const w = await handleInboundWebhook({ recipient: 'documenti-nessuno-000000@palladia.net', sender: 'x@y.it', subject: 'prova' }, [], { 'x-ingest-secret': process.env.CLOUDFLARE_EMAIL_INGEST_SECRET });
    check('il webhook manda documenti-… al canale imprese', w.body?.canale === 'imprese', w.body);
  } catch (e) {
    check('nessun errore', false, e.message);
  } finally {
    if (creati.length) await supabase.from('imprese_caricamenti').delete().in('id', creati);
  }
  fine();
})();

function fine() {
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
