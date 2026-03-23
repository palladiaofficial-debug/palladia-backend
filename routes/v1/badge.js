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
      id, full_name, photo_url, hire_date, qualification, role,
      employer_name, subcontracting_auth,
      safety_training_expiry, health_fitness_expiry,
      badge_code, is_active, created_at,
      company:companies ( name )
    `)
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  // URL verifica pubblica
  const appBase  = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const badgeUrl = `${appBase}/badge/${worker.badge_code}`;

  let qrDataUrl;
  try {
    qrDataUrl = await QRCode.toDataURL(badgeUrl, { width: 220, margin: 1 });
  } catch (e) {
    return res.status(500).json({ error: 'QR_GENERATION_FAILED', message: e.message });
  }

  const safetyStatus = complianceStatus(worker.safety_training_expiry);
  const healthStatus  = complianceStatus(worker.health_fitness_expiry);
  const overall       = overallStatus(worker);

  const companyName    = worker.company?.name || '';
  const employerLabel  = (worker.employer_name && worker.employer_name !== companyName)
    ? worker.employer_name
    : companyName;

  const hireDateStr = worker.hire_date
    ? new Date(worker.hire_date).toLocaleDateString('it-IT', {
        day: '2-digit', month: 'long', year: 'numeric',
      })
    : null;

  const html = buildBadgePdfHtml({
    worker, companyName, employerLabel, hireDateStr,
    safetyStatus, healthStatus, overall,
    qrDataUrl, badgeUrl,
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
// Formato: 2 badge affiancati per foglio A4 — 85mm × ~110mm ciascuno
// Dimensione tascabile, compatibile con portabadge/lanyards standard 9×13cm

function complianceDotInline(status) {
  const map = {
    ok:       { color: '#22c55e', label: 'Valida'      },
    expiring: { color: '#f59e0b', label: 'In scadenza' },
    expired:  { color: '#ef4444', label: 'SCADUTA'     },
    not_set:  { color: '#94a3b8', label: 'N/D'         },
  };
  const { color, label } = map[status] || map.not_set;
  return { color, label };
}

function buildBadgePdfHtml({
  worker, companyName, employerLabel, hireDateStr,
  safetyStatus, healthStatus, overall, qrDataUrl,
}) {
  const photoBlock = worker.photo_url
    ? `<img src="${esc(worker.photo_url)}" alt="" class="photo-img">`
    : `<div class="photo-placeholder">
         <span>&#128100;</span>
         <small>Nessuna foto</small>
       </div>`;

  const infoRows = [
    worker.qualification ? `<div class="info-row"><span class="lbl">Qualifica</span><span class="val">${esc(worker.qualification)}</span></div>` : '',
    worker.role          ? `<div class="info-row"><span class="lbl">Mansione</span><span class="val">${esc(worker.role)}</span></div>`          : '',
    employerLabel        ? `<div class="info-row"><span class="lbl">Impresa</span><span class="val">${esc(employerLabel)}</span></div>`          : '',
    hireDateStr          ? `<div class="info-row"><span class="lbl">Assunto il</span><span class="val">${esc(hireDateStr)}</span></div>`         : '',
  ].filter(Boolean).join('');

  const codeFormatted = (worker.badge_code || '').replace(/(.{6})/g, '$1-').replace(/-$/, '');
  const safety = complianceDotInline(safetyStatus);
  const health = complianceDotInline(healthStatus);

  // Singola card — ripetuta 2× sulla pagina
  const card = `
<div class="badge-card">
  <!-- Header -->
  <div class="card-header">
    <div>
      <div class="brand-name">PALLADIA</div>
      <div class="brand-sub">Badge Digitale Lavoratore</div>
    </div>
    ${buildOverallPill(overall)}
  </div>

  <!-- Foto + dati -->
  <div class="card-body">
    <div class="photo-col">${photoBlock}</div>
    <div class="info-col">
      <div class="worker-name">${esc(worker.full_name)}</div>
      ${infoRows}
    </div>
  </div>

  <!-- Compliance -->
  <div class="compliance-bar">
    <div class="comp-item">
      <span class="comp-dot" style="background:${safety.color};"></span>
      <span class="comp-lbl">Formazione</span>
      <span class="comp-val" style="color:${safety.color};">${safety.label}</span>
    </div>
    <div class="comp-sep"></div>
    <div class="comp-item">
      <span class="comp-dot" style="background:${health.color};"></span>
      <span class="comp-lbl">Idoneità</span>
      <span class="comp-val" style="color:${health.color};">${health.label}</span>
    </div>
  </div>

  <!-- QR + codice -->
  <div class="qr-row">
    <img src="${qrDataUrl}" alt="QR" class="qr-img">
    <div class="qr-info">
      <div class="code-lbl">Codice Univoco</div>
      <div class="code-val">${esc(codeFormatted)}</div>
      <div class="code-hint">Scansiona per verificare<br>stato in tempo reale</div>
    </div>
  </div>

  <!-- Footer -->
  <div class="card-footer">
    <span class="ft">D.Lgs. 81/2008</span>
    <span class="ft">${esc(companyName)}</span>
  </div>
</div>`;

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* REGOLA: @page margin DEVE corrispondere a Puppeteer (26mm top, 24mm bottom) */
    @page { size: A4 portrait; margin: 26mm 0 24mm 0; }

    html, body {
      width: 210mm;
      font-family: Arial, Helvetica, sans-serif;
      background: #fff;
      color: #111827;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .page {
      width: 100%;
      padding: 0 16mm;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    /* Istruzione taglio */
    .cut-hint {
      font-size: 7.5px;
      color: #9ca3af;
      text-align: center;
      margin-bottom: 5mm;
      letter-spacing: 0.04em;
    }
    .cut-hint strong { color: #6b7280; }

    /* Due badge affiancati */
    .badges-row {
      display: flex;
      gap: 8mm;
      justify-content: center;
    }

    /* ── Badge card 85mm × auto ── */
    .badge-card {
      width: 85mm;
      border: 1.5px dashed #cbd5e1;
      border-radius: 5px;
      overflow: hidden;
      background: #fff;
    }

    /* Header */
    .card-header {
      background: #0f172a;
      padding: 5px 9px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand-name {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: #f8fafc;
      text-transform: uppercase;
    }
    .brand-sub {
      font-size: 6px;
      color: #94a3b8;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-top: 1px;
    }
    .overall-pill {
      font-size: 6.5px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 20px;
      white-space: nowrap;
    }

    /* Body: foto + info */
    .card-body {
      display: flex;
      gap: 8px;
      padding: 8px 9px;
    }
    .photo-col { flex-shrink: 0; }
    .photo-img {
      width: 28mm;
      height: 36mm;
      object-fit: cover;
      border-radius: 3px;
      border: 1px solid #e2e8f0;
      display: block;
    }
    .photo-placeholder {
      width: 28mm;
      height: 36mm;
      border-radius: 3px;
      border: 1px solid #e2e8f0;
      background: #f1f5f9;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
    }
    .photo-placeholder span { font-size: 20px; color: #94a3b8; line-height: 1; }
    .photo-placeholder small { font-size: 5.5px; color: #94a3b8; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase; }

    .info-col { flex: 1; min-width: 0; }
    .worker-name {
      font-size: 10.5px;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.25;
      margin-bottom: 6px;
      word-break: break-word;
    }
    .info-row {
      display: flex;
      gap: 4px;
      margin-bottom: 3px;
      align-items: baseline;
    }
    .lbl {
      font-size: 6px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      flex-shrink: 0;
      width: 44px;
    }
    .val {
      font-size: 7px;
      color: #374151;
      font-weight: 500;
      word-break: break-word;
      flex: 1;
    }

    /* Compliance */
    .compliance-bar {
      display: flex;
      align-items: center;
      padding: 5px 9px;
      background: #f8fafc;
      border-top: 1px solid #f1f5f9;
      gap: 4px;
    }
    .comp-item { display: flex; align-items: center; gap: 4px; flex: 1; }
    .comp-sep { width: 1px; height: 14px; background: #e2e8f0; flex-shrink: 0; }
    .comp-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .comp-lbl { font-size: 5.5px; font-weight: 700; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.05em; }
    .comp-val { font-size: 6.5px; font-weight: 700; }

    /* QR row */
    .qr-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 9px;
      border-top: 1px solid #f1f5f9;
    }
    .qr-img { width: 24mm; height: 24mm; flex-shrink: 0; }
    .qr-info { flex: 1; min-width: 0; }
    .code-lbl { font-size: 5.5px; font-weight: 700; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 2px; }
    .code-val { font-family: 'Courier New', monospace; font-size: 7px;
      font-weight: 700; color: #0f172a; word-break: break-all; margin-bottom: 3px; }
    .code-hint { font-size: 6px; color: #94a3b8; line-height: 1.4; }

    /* Footer */
    .card-footer {
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      padding: 3px 9px;
      display: flex;
      justify-content: space-between;
    }
    .ft { font-size: 5.5px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="page">
    <div class="cut-hint">
      <strong>Stampare</strong> · Ritagliare lungo la linea tratteggiata · <strong>Plastificare</strong> · Consegnare al lavoratore
    </div>
    <div class="badges-row">
      ${card}
    </div>
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
