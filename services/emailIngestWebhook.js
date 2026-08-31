'use strict';

/**
 * services/emailIngestWebhook.js
 * Gestore del webhook per il canale fatture via inoltro email. Chiamato da
 * routes/v1/emailIngest.js (rotta pubblica, autenticata via header segreto condiviso).
 *
 * MTA reale: Cloudflare Email Routing (non Mailgun — Mailgun e Resend sono risultati
 * bloccati in fase di attivazione account, vedi milestone 7 rivista). Un Cloudflare
 * Worker (worker/emailIngestWorker.js) riceve l'email grezza sulla zona palladia.net
 * (catch-all — nessun sottodominio dedicato, per evitare provisioning DNS aggiuntivo
 * su una zona già attiva), la fa passare per postal-mime e la ripubblica qui come
 * multipart/form-data nello STESSO formato campo-per-campo già usato per Mailgun
 * (sender, recipient, subject, message-headers) — così tutta la logica sotto (parsing,
 * allowlist, dedup, estrazione) resta identica e testata; cambia solo il meccanismo di
 * autenticazione del webhook (header X-Ingest-Secret invece di firma HMAC nel body).
 *
 * Sequenza (vedi anche il piano approvato per questa milestone):
 *  1. Verifica header segreto condiviso — unico caso di rifiuto non-200, è un confine
 *     di sicurezza vero (stesso trattamento di Stripe in server.js).
 *  2. Risolve la company dal token nel destinatario.
 *  3. Limite dimensione.
 *  4. Allowlist mittente (sconosciuto/bloccato/SPF-DKIM falliti → quarantena, mai
 *     scarto silenzioso: ogni ramo scrive una riga in email_ingest_log).
 *  5. Estrazione candidati (lib/fatturaPaEnvelopeParser.js) da tutti gli allegati.
 *  6. Per ogni candidato: sovrapposizione con spesa OCR manuale, poi ingest
 *     condiviso (services/sdiInvoices.js::ingestMappedExpense, dedupExtra).
 *  7. PDF isolato senza XML/p7m companion → fallback OCR esistente (lib/expenseOcr.js),
 *     sempre con pending_review perché nessun umano è presente a confermare
 *     l'estrazione al momento dell'arrivo (a differenza di /expenses/scan manuale).
 *
 * Nota di onestà tecnica: SPF/DKIM sono verificati da Cloudflare stessa a monte del
 * Worker e stampati come header MIME standard (Authentication-Results) dentro
 * message-headers, che il Worker ripubblica invariati. parseAuthResults() legge
 * quegli header col parsing più tollerante possibile — verificato con un'email reale
 * in Milestone 8: se il formato osservato differisce, va aggiornata di conseguenza.
 */

const crypto   = require('crypto');
const supabase = require('../lib/supabase');
const { extractInvoiceCandidates } = require('../lib/fatturaPaEnvelopeParser');
const { extractExpenseFromDocument } = require('../lib/expenseOcr');
const { toInvoiceShapeForAi, mapCandidateToExpenseRow, checkOcrOverlap } = require('../lib/fatturaCandidateMapper');
const { ingestMappedExpense } = require('./sdiInvoices');
const { resolveCompanyByToken, getSenderRule, logIngestEvent, consumeTestNonce, checkRetiredToken } = require('./emailIngestConfig');

const MAX_MESSAGE_SIZE_BYTES = 22 * 1024 * 1024; // sotto i 25MB di Mailgun, margine per gli header multipart
const ALLOWED_EXTENSIONS = ['.xml', '.p7m', '.zip', '.pdf'];

// Bucket DEDICATO (non 'site-documents', quello condiviso da expenses.js/
// companyDocuments.js): il suo allowlist MIME copre solo pdf/immagini/word,
// non xml/p7m/zip — i formati REALI di una fattura elettronica. Allargare
// l'allowlist del bucket condiviso avrebbe aperto quei tipi anche a upload
// non correlati (ricevute, documenti cantiere); un bucket a parte, privato,
// con l'allowlist minima per questo solo scopo, non tocca nessun'altra rotta.
const QUARANTINE_BUCKET = 'email-ingest-quarantine';

function contentTypeForFilename(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.p7m')) return 'application/pkcs7-mime';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/xml'; // .xml, e fallback per estensioni già filtrate a monte da hasAllowedExtension
}

// Il Worker Cloudflare è first-party (lo scriviamo e deployiamo noi): un segreto
// statico condiviso in header è equivalente in sicurezza a una firma HMAC qui, dato
// che entrambi gli estremi sono sotto il nostro controllo (a differenza di Mailgun,
// dove la firma provava che il chiamante fosse davvero Mailgun).
function verifyIngestSecret(headers) {
  const configured = process.env.CLOUDFLARE_EMAIL_INGEST_SECRET;
  if (!configured) return false; // fail-safe: nessun segreto configurato → nessuna richiesta accettata
  const given = headers?.['x-ingest-secret'];
  if (!given) return false;

  const expectedBuf = Buffer.from(configured);
  const givenBuf = Buffer.from(String(given));
  if (expectedBuf.length !== givenBuf.length) return false; // timingSafeEqual richiede stessa lunghezza
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

function extractSenderAddress(body) {
  const raw = body?.sender || body?.from || '';
  const match = String(raw).match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

function extractRecipientToken(body) {
  const recipient = String(body?.recipient || '').trim().toLowerCase();
  const at = recipient.indexOf('@');
  return at > 0 ? recipient.slice(0, at) : null;
}

function parseMessageHeaders(body) {
  try {
    const parsed = JSON.parse(body?.['message-headers'] || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findHeader(headers, name) {
  const hit = headers.find((h) => Array.isArray(h) && String(h[0]).toLowerCase() === name);
  return hit ? String(hit[1]) : '';
}

function parseAuthResults(body) {
  const headers = parseMessageHeaders(body);
  const authResults = findHeader(headers, 'authentication-results') || findHeader(headers, 'received-spf');
  const spf = /spf=pass/i.test(authResults) ? 'pass'
    : (/spf=(fail|softfail|neutral)/i.test(authResults) ? 'fail' : 'unknown');
  const dkim = /dkim=pass/i.test(authResults) ? 'pass'
    : (/dkim=fail/i.test(authResults) ? 'fail' : 'unknown');
  return { spf, dkim };
}

function extractMessageId(body) {
  const headers = parseMessageHeaders(body);
  return findHeader(headers, 'message-id') || null;
}

function totalSize(files) {
  return files.reduce((sum, f) => sum + (f.size || f.buffer?.length || 0), 0);
}

function hasAllowedExtension(filename) {
  const lower = String(filename || '').toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// PDF di cortesia isolato (nessun XML/p7m nella stessa email): nessun dato
// strutturato disponibile, unica via è l'estrazione AI già usata per lo scan manuale
// — ma qui nessun umano conferma in tempo reale, quindi la riga nasce sempre in
// pending_review, mai auto-confermata.
async function importFromCourtesyPdfOnly(companyId, pdfFile, fromAddress, messageId) {
  const extracted = await extractExpenseFromDocument(pdfFile.buffer, 'application/pdf', {
    companyId, userId: null, callSite: 'email_ingest_ocr_fallback',
  });
  if (!extracted.amount || !extracted.expense_date) return null;

  const expenseRow = {
    company_id:      companyId,
    amount:          extracted.amount,
    description:     extracted.description || `Fattura — ${extracted.supplier || 'fornitore sconosciuto'}`,
    category:        extracted.category || 'altro',
    payment_method:  extracted.payment_method || 'bonifico',
    supplier:        extracted.supplier || null,
    expense_date:    extracted.expense_date,
    invoice_number:  extracted.invoice_number || null,
    is_deductible:   true,
    notes:           "Estratta automaticamente da un PDF di cortesia senza file XML/p7m allegato — verifica i dati.",
    source:          'email',
    source_email:    fromAddress,
    source_message_id: messageId,
    content_hash:    crypto.createHash('sha256').update(pdfFile.buffer).digest('hex'),
    pending_review:  true,
    pending_review_reason: 'estratta via OCR da un PDF senza file tecnico XML — verifica i dati prima di confermarla',
  };

  return ingestMappedExpense(
    companyId, expenseRow,
    { sender: { name: expenseRow.supplier || 'sconosciuto' }, invoice_lines: [] },
    { configTable: 'email_ingest_configurations', dedupExtra: true },
  );
}

// F-104 (AUDIT.md): un mittente sconosciuto la cui email viene poi approvata
// (Account → Fatture via Email) non recuperava mai il messaggio che l'aveva
// fatto comparire in quarantena — solo gli invii successivi venivano
// importati. Per renderlo recuperabile, un'email quarantined_unknown_sender
// con almeno un allegato di estensione ammessa ora conserva quegli allegati
// in Storage (vedi storeQuarantinedAttachments) PRIMA di scartare il
// messaggio; quando il mittente viene poi autorizzato, recoverQuarantinedForSender
// li scarica e li fa passare per la STESSA identica funzione di estrazione/
// import usata dal webhook in tempo reale — stesso codice, stesso dedup,
// stessa logica pending_review, nessuna scorciatoia parallela.
async function extractAndImport(companyId, files, fromAddress, messageId) {
  const validAttachments = files.filter((f) => hasAllowedExtension(f.originalname));
  if (files.length > 0 && validAttachments.length === 0) {
    return { outcome: 'rejected_type', rejectReason: 'nessun allegato con estensione ammessa (xml, p7m, zip, pdf)', createdExpenseIds: [] };
  }

  // Vedi commento originale su handleInboundWebhook: un'eccezione imprevista qui
  // non deve mai risultare in un esito silenzioso — sempre un outcome esplicito.
  try {
    const allResults = [];
    for (const file of validAttachments) {
      allResults.push(...extractInvoiceCandidates(file.originalname, file.buffer));
    }

    const invoiceCandidates = allResults.filter((r) => r.xml);
    const courtesyPdfs      = allResults.filter((r) => r.courtesyPdf);
    const skipped            = allResults.filter((r) => r.skip);

    let anyPendingReview = false;
    let anyImported = false;
    const createdExpenseIds = [];

    if (invoiceCandidates.length === 0 && courtesyPdfs.length > 0) {
      for (const pdf of courtesyPdfs) {
        const result = await importFromCourtesyPdfOnly(companyId, pdf, fromAddress, messageId).catch((err) => {
          console.error('[email-ingest] OCR fallback error:', err.message);
          return null;
        });
        if (result?.ok && !result.skipped) {
          anyImported = true;
          anyPendingReview = true;
          createdExpenseIds.push(result.expense.id);
        }
      }
    } else {
      for (const candidate of invoiceCandidates) {
        const expenseRow = mapCandidateToExpenseRow(companyId, candidate);
        expenseRow.source_email = fromAddress;
        expenseRow.source_message_id = messageId;

        const overlap = await checkOcrOverlap(companyId, candidate.parsed).catch(() => null);
        if (overlap) {
          expenseRow.pending_review = true;
          expenseRow.pending_review_reason = `sembra già presente come spesa caricata il ${overlap.expense_date} (${overlap.supplier}, ${overlap.amount}€) — verifica prima di tenerle entrambe`;
        }

        const result = await ingestMappedExpense(
          companyId, expenseRow, toInvoiceShapeForAi(candidate.parsed),
          { configTable: 'email_ingest_configurations', dedupExtra: true },
        );

        if (result.ok && !result.skipped) {
          anyImported = true;
          createdExpenseIds.push(result.expense.id);
          if (expenseRow.pending_review) anyPendingReview = true;
        }
      }
    }

    let outcome;
    let rejectReason = null;
    if (anyPendingReview) outcome = 'pending_review';
    else if (anyImported) outcome = 'accepted';
    else if (invoiceCandidates.length > 0) { outcome = 'duplicate'; rejectReason = 'fattura già presente (stesso contenuto o stessa identità fiscale — P.IVA, numero e data)'; }
    else if (skipped.length > 0 && skipped.every((s) => s.reason === 'sdi_metadata')) { outcome = 'sdi_metadata_skipped'; rejectReason = 'conteneva solo una notifica/ricevuta SdI, non una fattura'; }
    else { outcome = 'rejected_type'; rejectReason = files.length === 0 ? 'nessun allegato nell\'email' : 'nessun contenuto fattura riconosciuto negli allegati (xml non valido, zip non apribile o senza fatture dentro)'; }

    return { outcome, rejectReason, createdExpenseIds };
  } catch (err) {
    console.error('[email-ingest] errore imprevisto in fase di estrazione/importazione:', err.message, err.stack);
    return { outcome: 'processing_error', rejectReason: `errore interno durante l'elaborazione: ${err.message}`, createdExpenseIds: [] };
  }
}

// Conserva SOLO gli allegati di estensione ammessa (mai file arbitrari) di un
// messaggio che sta per essere quarantenato — se l'upload fallisce (Storage
// giù, ecc.) il messaggio resta comunque quarantenato normalmente, semplicemente
// senza possibilità di recupero futuro: mai far fallire il webhook per questo.
async function storeQuarantinedAttachments(companyId, files) {
  const validAttachments = files.filter((f) => hasAllowedExtension(f.originalname));
  if (validAttachments.length === 0) return null;

  const stored = [];
  for (const [i, f] of validAttachments.entries()) {
    const safeName = String(f.originalname || `allegato-${i}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `email-ingest-quarantine/${companyId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName}`;
    const { error } = await supabase.storage.from(QUARANTINE_BUCKET).upload(storagePath, f.buffer, { contentType: contentTypeForFilename(f.originalname) });
    if (error) throw error;
    stored.push({ filename: f.originalname, storage_path: storagePath, size_bytes: f.buffer?.length || 0 });
  }
  return stored;
}

// Chiamata da routes/v1/emailIngest.js quando un mittente viene autorizzato
// (action: 'allow') — recupera TUTTI i messaggi ancora recuperabili da quel
// mittente per questa azienda, non solo l'ultimo, in caso ne fossero arrivati
// più d'uno prima dell'approvazione.
async function recoverQuarantinedForSender(companyId, emailAddress) {
  const normalized = String(emailAddress || '').trim().toLowerCase();
  const { data: rows, error } = await supabase
    .from('email_ingest_log')
    .select('id, from_address, message_id, quarantined_attachments')
    .eq('company_id', companyId)
    .eq('from_address', normalized)
    .eq('outcome', 'quarantined_unknown_sender')
    .is('recovered_at', null)
    .not('quarantined_attachments', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  if (!rows || rows.length === 0) return { recoveredMessages: 0, importedExpenseIds: [] };

  const importedExpenseIds = [];
  let recoveredMessages = 0;

  for (const row of rows) {
    const attachments = Array.isArray(row.quarantined_attachments) ? row.quarantined_attachments : [];
    if (attachments.length === 0) continue;

    const files = [];
    for (const att of attachments) {
      const { data: blob, error: dlErr } = await supabase.storage.from(QUARANTINE_BUCKET).download(att.storage_path);
      if (dlErr || !blob) {
        console.error('[email-ingest] recupero quarantena: download fallito per', att.storage_path, dlErr?.message);
        continue;
      }
      files.push({ originalname: att.filename, buffer: Buffer.from(await blob.arrayBuffer()) });
    }
    if (files.length === 0) continue;

    const result = await extractAndImport(companyId, files, row.from_address, row.message_id);
    recoveredMessages += 1;
    importedExpenseIds.push(...result.createdExpenseIds);

    await supabase
      .from('email_ingest_log')
      .update({
        recovered_at: new Date().toISOString(),
        recovered_outcome: result.outcome,
        recovered_expense_ids: result.createdExpenseIds,
      })
      .eq('id', row.id);
  }

  return { recoveredMessages, importedExpenseIds };
}

async function handleInboundWebhook(body, files, headers) {
  if (!verifyIngestSecret(headers)) {
    return { httpStatus: 401, body: { error: 'INVALID_SIGNATURE' } };
  }

  const token       = extractRecipientToken(body);
  const companyId   = await resolveCompanyByToken(token).catch(() => null);
  const fromAddress = extractSenderAddress(body);
  const messageId   = extractMessageId(body);
  const size        = totalSize(files);

  const logBase = {
    company_id:           companyId,
    inbound_token_used:   token,
    from_address:         fromAddress,
    subject:              body?.subject || null,
    message_id:           messageId,
    size_bytes:           size,
    attachment_filenames: files.map((f) => f.originalname),
  };

  if (!companyId) {
    // Prima di dichiararlo "mai esistito", controlla se era un indirizzo valido
    // rigenerato nel frattempo — motivo esplicito e tracciabile per l'azienda a
    // cui apparteneva, non un rifiuto anonimo indistinguibile da uno sconosciuto.
    const retired = await checkRetiredToken(token).catch(() => null);
    if (retired) {
      await logIngestEvent({
        ...logBase, company_id: retired.company_id, outcome: 'token_retired',
        reject_reason: `indirizzo rigenerato il ${new Date(retired.retired_at).toISOString().slice(0, 10)}, non più attivo`,
      });
      return { httpStatus: 200, body: { ok: true, outcome: 'token_retired' } };
    }
    await logIngestEvent({ ...logBase, outcome: 'unknown_token', reject_reason: `token '${token}' non risolto a nessuna azienda` });
    return { httpStatus: 200, body: { ok: true, outcome: 'unknown_token' } };
  }

  // Email di prova (pulsante "Invia email di prova"): il nonce nel subject è la
  // prova di autenticità, non l'identità del mittente — bypassa deliberatamente
  // l'allowlist qui sotto, prima di qualunque altro controllo.
  const testedCompanyId = await consumeTestNonce(token, body?.subject).catch(() => null);
  if (testedCompanyId) {
    await logIngestEvent({ ...logBase, outcome: 'test_ok' });
    return { httpStatus: 200, body: { ok: true, outcome: 'test_ok' } };
  }

  const { spf, dkim } = parseAuthResults(body);

  if (size > MAX_MESSAGE_SIZE_BYTES) {
    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome: 'rejected_size', reject_reason: `${size} byte oltre il limite di ${MAX_MESSAGE_SIZE_BYTES}` });
    return { httpStatus: 200, body: { ok: true, outcome: 'rejected_size' } };
  }

  const senderRule = await getSenderRule(companyId, fromAddress);
  if (senderRule === 'block') {
    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome: 'blocked_sender', reject_reason: 'mittente bloccato esplicitamente dall\'azienda' });
    return { httpStatus: 200, body: { ok: true, outcome: 'blocked_sender' } };
  }
  if (senderRule !== 'allow') {
    // F-104: conserva gli allegati (se presenti e di estensione ammessa) PRIMA
    // di scartare — se l'upload fallisce non deve mai bloccare la risposta al
    // webhook, il messaggio resta comunque quarantenato normalmente.
    const quarantinedAttachments = await storeQuarantinedAttachments(companyId, files).catch((err) => {
      console.error('[email-ingest] impossibile conservare gli allegati in quarantena:', err.message);
      return null;
    });
    await logIngestEvent({
      ...logBase, spf_result: spf, dkim_result: dkim, outcome: 'quarantined_unknown_sender',
      reject_reason: 'mittente mai autorizzato per questa azienda', quarantined_attachments: quarantinedAttachments,
    });
    return { httpStatus: 200, body: { ok: true, outcome: 'quarantined_unknown_sender' } };
  }
  if (spf === 'fail' || dkim === 'fail') {
    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome: 'quarantined_failed_auth', reject_reason: `verifica fallita — SPF=${spf} DKIM=${dkim}` });
    return { httpStatus: 200, body: { ok: true, outcome: 'quarantined_failed_auth' } };
  }

  const result = await extractAndImport(companyId, files, fromAddress, messageId);
  await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome: result.outcome, reject_reason: result.rejectReason, created_expense_ids: result.createdExpenseIds });
  return { httpStatus: 200, body: { ok: true, outcome: result.outcome, imported: result.createdExpenseIds.length } };
}

module.exports = { handleInboundWebhook, verifyIngestSecret, recoverQuarantinedForSender };
