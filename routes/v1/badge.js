'use strict';
// ── Badge Digitale ─────────────────────────────────────────────────────────────
// Endpoint pubblico (no JWT):
//   GET  /api/v1/badge/:code           — verifica badge, ritorna JSON
//
// Endpoint privato (JWT):
//   GET  /api/v1/workers/:workerId/badge-pdf  — PDF badge stampabile
// ──────────────────────────────────────────────────────────────────────────────

const QRCode   = require('qrcode');
const router   = require('express').Router();
const rateLimit = require('express-rate-limit');
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { rendererPool }      = require('../../pdf-renderer');
const { complianceStatus, overallStatus } = require('../../lib/compliance');

// Rate limit specifico per la verifica pubblica del badge
// 60/min per IP — abbastanza generoso per ispezioni multiple
const badgeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
});

// complianceStatus e overallStatus importati da lib/compliance.js

// ── GET /api/v1/badge/:code — verifica badge (PUBBLICO) ──────────────────────
router.get('/badge/:code', badgeLimiter, async (req, res) => {
  const { code } = req.params;

  if (!/^[A-Fa-f0-9]{18}$/.test(code)) {
    return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  }

  const { data: worker, error } = await supabase
    .from('workers')
    .select(`
      id, company_id,
      full_name, photo_url, hire_date, birth_date, qualification, role,
      employer_name, subcontracting_auth, fiscal_code, birth_place,
      safety_training_expiry, health_fitness_expiry,
      badge_code, is_active, created_at,
      company:companies ( name )
    `)
    .eq('badge_code', code.toUpperCase())
    .maybeSingle();

  if (error) {
    console.error('[badge] db error:', error.message);
    return res.status(500).json({ error: 'DB_ERROR' });
  }
  if (!worker) return res.status(404).json({ error: 'BADGE_NOT_FOUND' });

  // Documenti caricati per questo lavoratore
  const { data: workerDocs } = await supabase
    .from('worker_documents')
    .select('id, doc_type, name, expiry_date, file_path')
    .eq('worker_id',  worker.id)
    .eq('company_id', worker.company_id)
    .order('doc_type');

  const safetyStatus = complianceStatus(worker.safety_training_expiry);
  const healthStatus  = complianceStatus(worker.health_fitness_expiry);

  res.json({
    badge_code:   worker.badge_code,
    full_name:    worker.full_name,
    photo_url:    worker.photo_url    || null,
    company_name: worker.company?.name || null,
    safety_training_expiry: worker.safety_training_expiry || null,
    health_fitness_expiry:  worker.health_fitness_expiry  || null,
    issued_at:    worker.created_at   || null,
    employer_name:       worker.employer_name    || null,
    qualification:       worker.qualification    || null,
    role:                worker.role             || null,
    hire_date:           worker.hire_date        || null,
    fiscal_code:         worker.fiscal_code      || null,
    birth_date:          worker.birth_date       || null,
    birth_place:         worker.birth_place      || null,
    subcontracting_auth: worker.subcontracting_auth || false,
    safety_training_status: safetyStatus,
    health_fitness_status:  healthStatus,
    overall_status: overallStatus(worker),
    is_active:    worker.is_active,
    documents: (workerDocs || []).map(d => ({
      id:          d.id,
      doc_type:    d.doc_type,
      name:        d.name,
      expiry_date: d.expiry_date || null,
      has_file:    !!d.file_path,
    })),
  });
});

// ── GET /api/v1/badge/:code/document/:docId — URL firmato documento (PUBBLICO) ─
// Documenti di compliance (formazione, idoneità) restano pubblici per ispezioni.
// Dati personali (payslips, presenze) sono in workerArea.js con auth CF.
router.get('/badge/:code/document/:docId', badgeLimiter, async (req, res) => {
  const { code, docId } = req.params;
  if (!/^[A-Fa-f0-9]{18}$/i.test(code)) return res.status(400).json({ error: 'INVALID_BADGE_CODE' });

  const { data: worker } = await supabase
    .from('workers')
    .select('id, company_id, is_active')
    .eq('badge_code', code.toUpperCase())
    .maybeSingle();

  if (!worker)           return res.status(404).json({ error: 'BADGE_NOT_FOUND' });
  if (!worker.is_active) return res.status(403).json({ error: 'WORKER_INACTIVE' });

  const { data: doc } = await supabase
    .from('worker_documents')
    .select('id, file_path, name, mime_type')
    .eq('id',         docId)
    .eq('worker_id',  worker.id)
    .eq('company_id', worker.company_id)
    .maybeSingle();

  if (!doc || !doc.file_path)
    return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });

  const { data: signed, error: signErr } = await supabase.storage
    .from('site-documents')
    .createSignedUrl(doc.file_path, 3600);

  if (signErr || !signed?.signedUrl)
    return res.status(500).json({ error: 'SIGN_ERROR' });

  res.json({ url: signed.signedUrl, name: doc.name, mime_type: doc.mime_type });
});

// Endpoint /badge/:code/presence-history RIMOSSO — ora in workerArea.js con auth CF

// ── GET /api/v1/workers/:workerId/badge-pdf — PDF badge stampabile (JWT) ──────
router.get('/workers/:workerId/badge-pdf', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;

  const { data: worker, error } = await supabase
    .from('workers')
    .select(`
      id, full_name, photo_url, fiscal_code, hire_date, birth_date, birth_place,
      employer_name, badge_code, is_active, created_at,
      company:companies ( name )
    `)
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  const appBase        = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const timbrataUrl    = `${appBase}/timbratura/${worker.badge_code}`;
  const verifyUrl      = `${appBase}/badge/${worker.badge_code}`;

  let qrTimbrataUrl, qrVerifyDataUrl;
  try {
    [qrTimbrataUrl, qrVerifyDataUrl] = await Promise.all([
      QRCode.toDataURL(timbrataUrl, { width: 200, margin: 1 }),
      QRCode.toDataURL(verifyUrl,   { width: 260, margin: 1 }),
    ]);
  } catch (e) {
    return res.status(500).json({ error: 'QR_GENERATION_FAILED', message: e.message });
  }

  const companyName = worker.company?.name || '';
  const employerLabel = (worker.employer_name && worker.employer_name !== companyName)
    ? worker.employer_name : companyName;

  const hireDateStr = worker.hire_date
    ? new Date(worker.hire_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })
    : null;

  // Preferisce birth_date dal DB; fallback al CF solo se assente
  const dobStr = worker.birth_date
    ? new Date(worker.birth_date).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : parseDobFromCf(worker.fiscal_code);
  const sexStr    = parseSexFromCf(worker.fiscal_code);
  const birthPlace = worker.birth_place || null;

  const html = buildBadgePdfHtml({
    worker, companyName, employerLabel, hireDateStr, dobStr, sexStr, birthPlace,
    qrTimbrataUrl, qrVerifyDataUrl,
  });

  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, {
      docTitle: `Badge — ${worker.full_name}`,
      rev:      1,
    });
  } catch (e) {
    console.error('[badge-pdf] render error:', e.message);
    return res.status(500).json({ error: 'PDF_RENDER_FAILED', message: e.message });
  }

  const safeName = worker.full_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="badge-${safeName}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.end(pdfBuffer);
});

// ── HTML builder per badge PDF ────────────────────────────────────────────────
// Formato ISO ID-1: 85.6mm × 54mm (identico a patente / codice fiscale)
// Fronte + retro sulla stessa pagina A4 — si ritaglia, si mette schiena a schiena, si plastifica

// Estrae data di nascita dal codice fiscale italiano (encoding standard)
function parseDobFromCf(cf) {
  if (!cf || cf.length < 11) return null;
  try {
    const MONTHS = { A:1,B:2,C:3,D:4,E:5,H:6,L:7,M:8,P:9,R:10,S:11,T:12 };
    const yy    = parseInt(cf.substring(6, 8), 10);
    const month = MONTHS[cf.charAt(8).toUpperCase()];
    let   day   = parseInt(cf.substring(9, 11), 10);
    if (!month || isNaN(day) || isNaN(yy)) return null;
    if (day > 40) day -= 40;
    const currentYY = new Date().getFullYear() % 100;
    const fullYear  = yy > currentYY ? 1900 + yy : 2000 + yy;
    return new Date(fullYear, month - 1, day)
      .toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return null; }
}

// Deriva sesso dal codice fiscale: giorno > 40 → Femmina
function parseSexFromCf(cf) {
  if (!cf || cf.length < 11) return null;
  try {
    const day = parseInt(cf.substring(9, 11), 10);
    if (isNaN(day)) return null;
    return day > 40 ? 'F' : 'M';
  } catch { return null; }
}


function buildBadgePdfHtml({
  worker, companyName, dobStr, sexStr, birthPlace,
  qrTimbrataUrl, qrVerifyDataUrl,
}) {
  const codeFormatted = (worker.badge_code || '').replace(/(.{6})/g, '$1-').replace(/-$/, '');
  const cfUpper = worker.fiscal_code ? worker.fiscal_code.toUpperCase() : null;
  const sexLabel = sexStr === 'M' ? 'Maschio' : sexStr === 'F' ? 'Femmina' : null;

  // ── FRONTE ────────────────────────────────────────────────────────────────
  // Sinistra (42%): QR timbratura
  // Destra  (58%): nome grande + dati personali leggibili (niente foto)
  const photoHtml = worker.photo_url
    ? `<img src="${esc(worker.photo_url)}" alt="Foto" class="bl-photo-img">`
    : `<div class="bl-photo-placeholder"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`;

  const front = `
<div class="card" id="front">
  <div class="fh">
    <div class="fh-brand">PALLADIA</div>
    <div class="fh-right">
      <div class="fh-company">${esc(companyName)}</div>
      <div class="fh-sub">Badge di Cantiere</div>
    </div>
  </div>
  <div class="front-body">

    <div class="fl-qr-col">
      <div class="fl-timb-lbl">TIMBRATURA</div>
      <img src="${qrTimbrataUrl}" alt="QR" class="fl-qr">
    </div>

    <div class="fl-data-col">
      <div class="fl-name">${esc(worker.full_name)}</div>
      <div class="fl-divider"></div>
      ${dobStr     ? `<div class="fl-row"><span class="fl-lbl">Nato il </span>${esc(dobStr)}</div>`    : ''}
      ${birthPlace ? `<div class="fl-row"><span class="fl-lbl">Luogo </span>${esc(birthPlace)}</div>` : ''}
      ${sexLabel   ? `<div class="fl-row"><span class="fl-lbl">Sesso </span>${esc(sexLabel)}</div>`   : ''}
      ${cfUpper    ? `<div class="fl-row"><span class="fl-lbl">CF </span>${esc(cfUpper)}</div>`       : ''}
    </div>

  </div>
</div>`;

  // ── RETRO ─────────────────────────────────────────────────────────────────
  // Sinistra (42%): foto lavoratore
  // Destra  (58%): VERIFICA + QR + codice anticontraffazione
  const back = `
<div class="card" id="back">
  <div class="fh">
    <div class="fh-brand">PALLADIA</div>
    <div class="fh-right">
      <div class="fh-company">Verifica Identit&agrave;</div>
      <div class="fh-sub">Scansiona per accedere ai dati completi</div>
    </div>
  </div>
  <div class="back-body">

    <div class="bl-photo-col">${photoHtml}</div>

    <div class="bl-verifica-col">
      <div class="bl-verifica-lbl">VERIFICA</div>
      <img src="${qrVerifyDataUrl}" alt="QR verifica" class="bl-qr">
      <div class="bl-code-block">
        <div class="bl-code-lbl">Codice anticontraffazione</div>
        <div class="bl-code-val">${esc(codeFormatted)}</div>
      </div>
    </div>

  </div>
</div>`;

  // ── HTML completo ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800;900&family=Barlow+Condensed:wght@700;800;900&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 26mm 0 24mm 0; }
    html, body {
      width: 210mm;
      font-family: 'Barlow', sans-serif;
      background: #fff;
      color: #1a1a1a;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Pagina ── */
    .page {
      width: 100%;
      padding: 0 16mm;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .hint {
      font-size: 7px;
      font-family: 'Barlow', sans-serif;
      color: #9ca3af;
      text-align: center;
      margin-bottom: 6mm;
      line-height: 1.7;
    }
    .hint strong { color: #6b7280; }
    .face-label {
      font-size: 9px;
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 2mm;
      align-self: flex-start;
      margin-left: calc(50% - 85.6mm / 2);
    }
    .gap { height: 8mm; }

    /* ── Card ISO ID-1: 85.6 × 54mm ── */
    .card {
      width: 85.6mm;
      height: 54mm;
      border: 1.5px dashed #d1d5db;
      border-radius: 3mm;
      overflow: hidden;
      background: #fff;
      display: flex;
      flex-direction: column;
    }

    /* ════════════════════════════════════
       FRONTE — header blu + due colonne
       ════════════════════════════════════ */

    /* Header blu scuro — identico al retro */
    .fh {
      background: #111111;
      padding: 4px 8px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }
    .fh-brand {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 9px;
      font-weight: 900;
      letter-spacing: 0.3em;
      color: #ffffff;
      text-transform: uppercase;
      flex-shrink: 0;
      padding-right: 7px;
      border-right: 1px solid #333333;
    }
    .fh-right { flex: 1; min-width: 0; padding-left: 7px; }
    .fh-company {
      font-family: 'Barlow', sans-serif;
      font-size: 11px;
      font-weight: 700;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fh-sub {
      font-family: 'Barlow', sans-serif;
      font-size: 5.5px;
      font-weight: 500;
      color: rgba(255,255,255,0.55);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-top: 1px;
    }

    /* ════════════════════════════════════
       FRONTE — QR sx + dati personali dx
       ════════════════════════════════════ */
    .front-body {
      width: 100%; flex: 1; display: flex; min-height: 0; overflow: hidden;
    }

    /* Colonna sinistra 40% — QR timbratura */
    .fl-qr-col {
      width: 40%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 5px 3px 5px 5px;
      border-right: 0.5px solid #e5e1d8;
      overflow: hidden;
    }
    .fl-timb-lbl {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #111111;
    }
    .fl-qr { width: 24mm; height: 24mm; display: block; flex-shrink: 0; }

    /* Colonna destra 60% — dati personali */
    .fl-data-col {
      flex: 1;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
      padding: 5px 6px 5px 7px;
      overflow: hidden;
    }
    .fl-name {
      font-family: 'Barlow', sans-serif;
      font-size: 17px;
      font-weight: 900;
      color: #111111;
      line-height: 1.15;
      word-break: break-word;
    }
    .fl-divider {
      width: 100%;
      height: 0.5px;
      background: #d1d5db;
      margin: 3px 0;
      flex-shrink: 0;
    }
    .fl-row {
      font-family: 'Barlow', sans-serif;
      font-size: 10px;
      font-weight: 500;
      color: #1a1a1a;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fl-lbl {
      font-family: 'Barlow', sans-serif;
      font-size: 8px;
      font-weight: 700;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    /* ════════════════════════════════════
       RETRO — foto sx + verifica dx
       ════════════════════════════════════ */
    .back-body {
      width: 100%; flex: 1; display: flex; min-height: 0; overflow: hidden;
    }

    /* Colonna sinistra 42% — foto */
    .bl-photo-col {
      width: 42%;
      height: 100%;
      display: flex;
      align-items: stretch;
      padding: 5px 3px 5px 5px;
      background: #f5f3ee;
      border-right: 0.5px solid #e5e1d8;
      overflow: hidden;
    }
    .bl-photo-img {
      width: 100%; height: 100%; object-fit: cover; border-radius: 2mm; display: block;
    }
    .bl-photo-placeholder {
      width: 100%; height: 100%; background: #ece9e3; border-radius: 2mm;
      display: flex; align-items: center; justify-content: center;
    }

    /* Colonna destra 58% — QR verifica + codice */
    .bl-verifica-col {
      flex: 1;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-evenly;
      padding: 4px 5px;
      overflow: hidden;
    }
    .bl-verifica-lbl {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #111111;
      flex-shrink: 0;
    }
    .bl-qr { width: 24mm; height: 24mm; display: block; flex-shrink: 0; }
    .bl-code-block { text-align: center; flex-shrink: 0; }
    .bl-code-lbl {
      font-family: 'Barlow', sans-serif;
      font-size: 7.5px;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 2px;
    }
    .bl-code-val {
      font-family: 'Barlow Condensed', sans-serif;
      font-size: 8.5px;
      font-weight: 800;
      color: #111111;
      letter-spacing: 0.06em;
    }

    /* ════ Footer (retro) ════ */
    .footer {
      background: #f5f3ee;
      border-top: 0.5px solid #e5e1d8;
      padding: 2px 8px;
      display: flex;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .ft { font-family: 'Barlow', sans-serif; font-size: 5px; font-weight: 500; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="page">

    <div class="hint">
      <strong>1. Stampare</strong> &nbsp;&middot;&nbsp;
      <strong>2. Ritagliare</strong> entrambi i rettangoli &nbsp;&middot;&nbsp;
      <strong>3. Incollare schiena a schiena</strong> &nbsp;&middot;&nbsp;
      <strong>4. Plastificare</strong>
    </div>

    <div class="face-label">&#9650; Fronte</div>
    ${front}

    <div class="gap"></div>

    <div class="face-label">&#9650; Retro</div>
    ${back}

  </div>
</body>
</html>`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = router;
