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
const { extractInvoiceCandidates } = require('../lib/fatturaPaEnvelopeParser');
const { extractExpenseFromDocument } = require('../lib/expenseOcr');
const { toInvoiceShapeForAi, mapCandidateToExpenseRow, checkOcrOverlap } = require('../lib/fatturaCandidateMapper');
const { ingestMappedExpense } = require('./sdiInvoices');
const { resolveCompanyByToken, getSenderRule, logIngestEvent, consumeTestNonce, checkRetiredToken } = require('./emailIngestConfig');

const MAX_MESSAGE_SIZE_BYTES = 22 * 1024 * 1024; // sotto i 25MB di Mailgun, margine per gli header multipart
const ALLOWED_EXTENSIONS = ['.xml', '.p7m', '.zip', '.pdf'];

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
    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome: 'quarantined_unknown_sender', reject_reason: 'mittente mai autorizzato per questa azienda' });
    return { httpStatus: 200, body: { ok: true, outcome: 'quarantined_unknown_sender' } };
  }
  if (spf === 'fail' || dkim === 'fail') {
    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome: 'quarantined_failed_auth', reject_reason: `verifica fallita — SPF=${spf} DKIM=${dkim}` });
    return { httpStatus: 200, body: { ok: true, outcome: 'quarantined_failed_auth' } };
  }

  const validAttachments = files.filter((f) => hasAllowedExtension(f.originalname));
  if (files.length > 0 && validAttachments.length === 0) {
    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome: 'rejected_type', reject_reason: 'nessun allegato con estensione ammessa (xml, p7m, zip, pdf)' });
    return { httpStatus: 200, body: { ok: true, outcome: 'rejected_type' } };
  }

  // Da qui in poi si tocca codice di estrazione/parsing di contenuto non fidato
  // (zip/p7m/XML costruiti da chiunque scriva all'indirizzo aziendale). Un'eccezione
  // imprevista qui (osservata dal vivo: un bug di libreria su un allegato zip reale,
  // "Cannot create a Buffer larger than N bytes") non deve MAI risultare in un 200
  // senza nessuna riga in email_ingest_log — quel messaggio sparirebbe nel nulla,
  // indistinguibile per l'utente da un'email mai arrivata. Meglio un outcome
  // 'processing_error' esplicito, con il messaggio d'errore come motivo, che un
  // buco silenzioso nel registro.
  let outcome;
  let createdExpenseIds = [];
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

    if (invoiceCandidates.length === 0 && courtesyPdfs.length > 0) {
      // Nessun XML/p7m nella stessa email — unico caso in cui passiamo dall'OCR,
      // sempre in pending_review (nessuna conferma umana sincrona disponibile qui).
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

    let rejectReason = null;
    if (anyPendingReview) outcome = 'pending_review';
    else if (anyImported) outcome = 'accepted';
    else if (invoiceCandidates.length > 0) { outcome = 'duplicate'; rejectReason = 'fattura già presente (stesso contenuto o stessa identità fiscale — P.IVA, numero e data)'; }
    else if (skipped.length > 0 && skipped.every((s) => s.reason === 'sdi_metadata')) { outcome = 'sdi_metadata_skipped'; rejectReason = 'conteneva solo una notifica/ricevuta SdI, non una fattura'; }
    else { outcome = 'rejected_type'; rejectReason = files.length === 0 ? 'nessun allegato nell\'email' : 'nessun contenuto fattura riconosciuto negli allegati (xml non valido, zip non apribile o senza fatture dentro)'; }

    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome, reject_reason: rejectReason, created_expense_ids: createdExpenseIds });
  } catch (err) {
    console.error('[email-ingest] errore imprevisto in fase di estrazione/importazione:', err.message, err.stack);
    outcome = 'processing_error';
    await logIngestEvent({ ...logBase, spf_result: spf, dkim_result: dkim, outcome, reject_reason: `errore interno durante l'elaborazione: ${err.message}`, created_expense_ids: createdExpenseIds });
  }

  return { httpStatus: 200, body: { ok: true, outcome, imported: createdExpenseIds.length } };
}

module.exports = { handleInboundWebhook, verifyIngestSecret };
