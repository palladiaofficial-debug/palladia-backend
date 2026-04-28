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

// Rate limit specifico per la verifica pubblica del badge
// 60/min per IP — abbastanza generoso per ispezioni multiple
const badgeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
});

// ── Logica compliance ─────────────────────────────────────────────────────────

/**
 * Ritorna lo stato di conformità di un documento con scadenza.
 * - not_set  → scadenza non impostata
 * - ok       → valida, scade tra più di 30 giorni
 * - expiring → valida, scade entro 30 giorni
 * - expired  → scaduta
 */
function complianceStatus(expiryDate) {
  if (!expiryDate) return 'not_set';
  const daysLeft = Math.floor((new Date(expiryDate) - Date.now()) / 86_400_000);
  if (daysLeft < 0)   return 'expired';
  if (daysLeft <= 30) return 'expiring';
  return 'ok';
}

/**
 * Stato globale del lavoratore basato su is_active + compliance.
 * - inactive      → lavoratore disattivato
 * - non_compliant → almeno un documento scaduto
 * - expiring      → almeno un documento in scadenza (<=30gg)
 * - incomplete    → almeno un documento non impostato
 * - compliant     → tutto OK
 */
function overallStatus(worker) {
  if (!worker.is_active) return 'inactive';
  const statuses = [
    complianceStatus(worker.safety_training_expiry),
    complianceStatus(worker.health_fitness_expiry),
  ];
  if (statuses.includes('expired'))  return 'non_compliant';
  if (statuses.includes('expiring')) return 'expiring';
  if (statuses.includes('not_set'))  return 'incomplete';
  return 'compliant';
}

// ── GET /api/v1/badge/:code — verifica badge (PUBBLICO) ──────────────────────
router.get('/badge/:code', badgeLimiter, async (req, res) => {
  const { code } = req.params;

  // Accetta sia uppercase che lowercase; 18 char hex
  if (!/^[A-Fa-f0-9]{18}$/.test(code)) {
    return res.status(400).json({ error: 'INVALID_BADGE_CODE' });
  }

  const { data: worker, error } = await supabase
    .from('workers')
    .select(`
      full_name, photo_url, hire_date, qualification, role,
      employer_name, subcontracting_auth,
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
    // employer_name può essere diverso da company_name per i subappaltatori
    employer_name:       worker.employer_name    || null,
    qualification:       worker.qualification    || null,
    role:                worker.role             || null,
    hire_date:           worker.hire_date        || null,
    subcontracting_auth: worker.subcontracting_auth || false,
    safety_training_status: safetyStatus,
    health_fitness_status:  healthStatus,
    overall_status: overallStatus(worker),
    is_active:    worker.is_active,
    issued_at:    worker.created_at,
  });
});

// ── GET /api/v1/workers/:workerId/badge-pdf — PDF badge stampabile (JWT) ──────
router.get('/workers/:workerId/badge-pdf', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;

  const { data: worker, error } = await supabase
    .from('workers')
    .select(`
      id, full_name, photo_url, fiscal_code, hire_date,
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
      QRCode.toDataURL(timbrataUrl, { width: 180, margin: 1 }),
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

  const dobStr = parseDobFromCf(worker.fiscal_code);

  const html = buildBadgePdfHtml({
    worker, companyName, employerLabel, hireDateStr, dobStr,
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

function complianceDotInline(status) {
  const map = {
    ok:       { color: '#22c55e', label: 'Valida'       },
    expiring: { color: '#f59e0b', label: 'In scadenza'  },
    expired:  { color: '#ef4444', label: 'SCADUTA'      },
    not_set:  { color: '#94a3b8', label: 'Non inserita' },
  };
  return map[status] || map.not_set;
}

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

function buildBadgePdfHtml({
  worker, companyName, employerLabel, hireDateStr, dobStr,
  qrTimbrataUrl, qrVerifyDataUrl,
}) {
  const photoBlock = worker.photo_url
    ? `<img src="${esc(worker.photo_url)}" alt="" class="photo-img">`
    : `<div class="photo-placeholder">&#128100;</div>`;

  const codeFormatted = (worker.badge_code || '').replace(/(.{6})/g, '$1-').replace(/-$/, '');
  const cfUpper = worker.fiscal_code ? worker.fiscal_code.toUpperCase() : null;

  // ── FRONTE ────────────────────────────────────────────────────────────────
  // Layout: header scuro | body (foto piena altezza + colonna dati + QR timbratura) | footer
  const front = `
<div class="card" id="front">

  <div class="ch">
    <div class="brand">PALLADIA</div>
    <div class="ch-sep"></div>
    <div class="ch-right">
      <div class="company-name">${esc(employerLabel || companyName)}</div>
      <div class="brand-sub">Badge Digitale Lavoratore &middot; D.Lgs. 81/2008</div>
    </div>
  </div>

  <div class="body">

    <!-- Foto: piena altezza, allineata al top -->
    <div class="photo-col">${photoBlock}</div>

    <div class="divider-v"></div>

    <!-- Dati anagrafici (top) + QR timbratura (bottom) -->
    <div class="data-col">

      <div class="data-top">
        <div class="wname">${esc(worker.full_name)}</div>
        ${dobStr   ? `<div class="field"><span class="fl">Data di nascita</span><span class="fv">${esc(dobStr)}</span></div>` : ''}
        ${cfUpper  ? `<div class="field"><span class="fl">Codice Fiscale</span><span class="fv fv-cf">${esc(cfUpper)}</span></div>` : ''}
        ${hireDateStr ? `<div class="field"><span class="fl">Data di assunzione</span><span class="fv">${esc(hireDateStr)}</span></div>` : ''}
      </div>

      <div class="timb-row">
        <div class="timb-label">TIMBRATURA</div>
        <img src="${qrTimbrataUrl}" alt="QR timbratura" class="qr-timb">
      </div>

    </div>

  </div>

  <div class="footer">
    <span class="ft">palladia.app</span>
    <span class="ft">${esc(companyName)}</span>
  </div>

</div>`;

  // ── RETRO ─────────────────────────────────────────────────────────────────
  // Layout: header scuro | QR centrato + scritta VERIFICA | footer
  const back = `
<div class="card" id="back">

  <div class="ch">
    <div class="brand">PALLADIA</div>
    <div class="ch-sep"></div>
    <div class="ch-right">
      <div class="company-name">Verifica Identità</div>
      <div class="brand-sub">Scansiona per accedere ai dati completi</div>
    </div>
  </div>

  <div class="body body-center">
    <div class="verifica-label">VERIFICA</div>
    <img src="${qrVerifyDataUrl}" alt="QR verifica" class="qr-back">
    <div class="code-block">
      <div class="code-lbl">Codice anticontraffazione</div>
      <div class="code-val">${esc(codeFormatted)}</div>
    </div>
  </div>

  <div class="footer">
    <span class="ft">palladia.app &middot; Verifica identit&agrave; e documenti</span>
    <span class="ft">${esc(companyName)}</span>
  </div>

</div>`;

  // ── HTML completo ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 26mm 0 24mm 0; }
    html, body {
      width: 210mm;
      font-family: Arial, Helvetica, sans-serif;
      background: #fff;
      color: #111827;
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
      color: #9ca3af;
      text-align: center;
      margin-bottom: 6mm;
      line-height: 1.7;
    }
    .hint strong { color: #6b7280; }
    .face-label {
      font-size: 7px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 2mm;
      align-self: flex-start;
      margin-left: calc(50% - 85.6mm / 2);
    }
    .gap { height: 8mm; }

    /* ── Card ISO ID-1: 85.6 × 54mm ── */
    .card {
      width: 85.6mm;
      height: 54mm;
      border: 1.5px dashed #cbd5e1;
      border-radius: 4mm;
      overflow: hidden;
      background: #fff;
      display: flex;
      flex-direction: column;
    }

    /* ── Header scuro ── */
    .ch {
      background: #0f172a;
      padding: 3.5px 8px;
      display: flex;
      align-items: center;
      gap: 0;
      flex-shrink: 0;
    }
    .brand {
      font-size: 5.5px;
      font-weight: 900;
      letter-spacing: 0.25em;
      color: #475569;
      text-transform: uppercase;
      flex-shrink: 0;
      padding-right: 7px;
    }
    .ch-sep {
      width: 1px;
      height: 10px;
      background: #1e293b;
      flex-shrink: 0;
      margin-right: 7px;
    }
    .ch-right { flex: 1; min-width: 0; }
    .company-name {
      font-size: 7.5px;
      font-weight: 700;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .brand-sub {
      font-size: 3.5px;
      color: #334155;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-top: 1px;
    }

    /* ── Body ── */
    .body {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* ── Foto ── */
    .photo-col {
      flex-shrink: 0;
      width: 19mm;
      align-self: stretch;
      padding: 5px 0 5px 7px;
    }
    .photo-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 2px;
      border: 1px solid #e2e8f0;
      display: block;
    }
    .photo-placeholder {
      width: 100%;
      height: 100%;
      border-radius: 2px;
      border: 1px solid #e8edf2;
      background: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #cbd5e1;
    }

    /* ── Separatore verticale ── */
    .divider-v {
      width: 1px;
      background: #f1f5f9;
      margin: 5px 6px;
      flex-shrink: 0;
    }

    /* ── Colonna dati ── */
    .data-col {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      padding: 5px 7px 5px 0;
    }
    .data-top {
      flex: 1;
    }
    .wname {
      font-size: 8.5px;
      font-weight: 800;
      color: #0f172a;
      line-height: 1.25;
      margin-bottom: 4px;
      word-break: break-word;
    }
    .field {
      display: flex;
      flex-direction: column;
      margin-bottom: 3.5px;
    }
    .fl {
      font-size: 3.8px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      line-height: 1;
      margin-bottom: 1px;
    }
    .fv {
      font-size: 6px;
      color: #1e293b;
      font-weight: 600;
      line-height: 1.2;
    }
    .fv-cf {
      font-family: 'Courier New', monospace;
      font-size: 5.5px;
      letter-spacing: 0.05em;
    }

    /* ── QR timbratura (fondo colonna dati) ── */
    .timb-row {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 3px;
      border-top: 0.75px solid #e8edf2;
      margin-top: 2px;
    }
    .timb-label {
      font-size: 6px;
      font-weight: 900;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #0f172a;
    }
    .qr-timb {
      width: 13mm;
      height: 13mm;
      display: block;
    }

    /* ── Footer card ── */
    .footer {
      background: #f8fafc;
      border-top: 1px solid #e8edf2;
      padding: 2px 8px;
      display: flex;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .ft { font-size: 4px; color: #94a3b8; }

    /* ── RETRO: body centrato ── */
    .body-center {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3.5px;
      padding: 5px 8px;
    }
    .verifica-label {
      font-size: 8.5px;
      font-weight: 900;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: #1d4ed8;
    }
    .qr-back { width: 25mm; height: 25mm; display: block; }
    .code-block { text-align: center; }
    .code-lbl {
      font-size: 3.8px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 1.5px;
    }
    .code-val {
      font-family: 'Courier New', monospace;
      font-size: 5.5px;
      font-weight: 700;
      color: #0f172a;
      letter-spacing: 0.04em;
    }
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

function buildOverallPill(overall) {
  const map = {
    compliant:     { bg: '#22c55e', color: '#ffffff', label: '✓ Conforme'       },
    expiring:      { bg: '#f59e0b', color: '#ffffff', label: '⚠ In scadenza'   },
    non_compliant: { bg: '#ef4444', color: '#ffffff', label: '✗ Non conforme'   },
    incomplete:    { bg: '#64748b', color: '#ffffff', label: '○ Incompleto'     },
    inactive:      { bg: '#374151', color: '#94a3b8', label: '— Inattivo'       },
  };
  const { bg, color, label } = map[overall] || map.inactive;
  return `<div class="overall-pill" style="background:${bg};color:${color};">${esc(label)}</div>`;
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
