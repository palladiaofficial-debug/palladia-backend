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

  const appBase      = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const badgeUrl     = `${appBase}/timbratura/${worker.badge_code}`;   // QR timbratura
  const verifyUrl    = `${appBase}/badge/${worker.badge_code}`;        // QR verifica enti

  let qrDataUrl, qrVerifyDataUrl;
  try {
    [qrDataUrl, qrVerifyDataUrl] = await Promise.all([
      QRCode.toDataURL(badgeUrl,  { width: 220, margin: 1 }),
      QRCode.toDataURL(verifyUrl, { width: 160, margin: 1 }),
    ]);
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
    qrDataUrl, qrVerifyDataUrl, badgeUrl,
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

function buildBadgePdfHtml({
  worker, companyName, employerLabel, hireDateStr,
  safetyStatus, healthStatus, overall, qrDataUrl, qrVerifyDataUrl,
}) {
  // ── Fronte ────────────────────────────────────────────────────────────────
  const photoBlock = worker.photo_url
    ? `<img src="${esc(worker.photo_url)}" alt="" class="photo-img">`
    : `<div class="photo-placeholder"><span>&#128100;</span><small>Nessuna foto</small></div>`;

  const infoRows = [
    worker.qualification ? `<div class="r"><span class="rl">Qualifica</span><span class="rv">${esc(worker.qualification)}</span></div>` : '',
    worker.role          ? `<div class="r"><span class="rl">Mansione</span><span class="rv">${esc(worker.role)}</span></div>`           : '',
    employerLabel        ? `<div class="r"><span class="rl">Impresa</span><span class="rv">${esc(employerLabel)}</span></div>`           : '',
    hireDateStr          ? `<div class="r"><span class="rl">Assunto il</span><span class="rv">${esc(hireDateStr)}</span></div>`          : '',
  ].filter(Boolean).join('');

  const front = `
<div class="card" id="front">
  <div class="ch">
    <div><div class="brand">PALLADIA</div><div class="brand-sub">Badge Digitale Lavoratore</div></div>
    ${buildOverallPill(overall)}
  </div>
  <div class="cb">
    <div class="pc">${photoBlock}</div>
    <div class="ic">
      <div class="wname">${esc(worker.full_name)}</div>
      ${infoRows}
    </div>
    <!-- QR verifica identità — per ispettori / enti di controllo -->
    <div class="front-qr">
      <img src="${qrVerifyDataUrl}" alt="QR verifica" class="qr-verify-img">
      <div class="qr-verify-hint">Verifica<br>identità</div>
    </div>
  </div>
  <div class="cf">
    <span class="ft">D.Lgs. 81/2008 · Palladia</span>
    <span class="ft">${esc(companyName)}</span>
  </div>
</div>`;

  // ── Retro ─────────────────────────────────────────────────────────────────
  const codeFormatted = (worker.badge_code || '').replace(/(.{6})/g, '$1-').replace(/-$/, '');
  const safety = complianceDotInline(safetyStatus);
  const health = complianceDotInline(healthStatus);

  const back = `
<div class="card" id="back">
  <div class="ch">
    <div class="brand">PALLADIA</div>
    <div class="brand-sub">Verifica stato documenti</div>
  </div>
  <div class="cb back-body">
    <!-- Compliance sinistra -->
    <div class="back-left">
      <div class="comp-row">
        <span class="cdot" style="background:${safety.color};"></span>
        <span class="clbl">Formazione Sicurezza</span>
        <span class="cval" style="color:${safety.color};">${safety.label}</span>
      </div>
      <div class="comp-row">
        <span class="cdot" style="background:${health.color};"></span>
        <span class="clbl">Idoneità Sanitaria</span>
        <span class="cval" style="color:${health.color};">${health.label}</span>
      </div>
      <div class="sep"></div>
      <div class="code-lbl">Codice univoco anticontraffazione</div>
      <div class="code-val">${esc(codeFormatted)}</div>
    </div>
    <!-- QR timbratura — per il lavoratore -->
    <div class="back-right">
      <img src="${qrDataUrl}" alt="QR timbratura" class="qr-img">
      <div class="qr-hint">Scansiona per<br>timbrare entrata/uscita</div>
    </div>
  </div>
  <div class="cf">
    <span class="ft">palladia.app · Badge anticontraffazione</span>
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
      gap: 0;
    }

    /* ── Istruzioni ── */
    .hint {
      font-size: 7px;
      color: #9ca3af;
      text-align: center;
      margin-bottom: 6mm;
      letter-spacing: 0.03em;
      line-height: 1.6;
    }
    .hint strong { color: #6b7280; }

    /* ── Etichetta fronte/retro ── */
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

    .gap { height: 7mm; }

    /* ── Card ISO ID-1: 85.6mm × 54mm ── */
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

    /* Header */
    .ch {
      background: #0f172a;
      padding: 4px 9px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .brand {
      font-size: 7.5px;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: #f8fafc;
      text-transform: uppercase;
    }
    .brand-sub {
      font-size: 5.5px;
      color: #94a3b8;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-top: 1px;
    }
    .overall-pill {
      font-size: 6px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 5px;
      border-radius: 20px;
      white-space: nowrap;
    }

    /* Body */
    .cb {
      flex: 1;
      display: flex;
      gap: 7px;
      padding: 6px 9px;
      overflow: hidden;
    }

    /* Foto */
    .pc { flex-shrink: 0; }
    .photo-img {
      width: 20mm;
      height: 26mm;
      object-fit: cover;
      border-radius: 2px;
      border: 1px solid #e2e8f0;
      display: block;
    }
    .photo-placeholder {
      width: 20mm;
      height: 26mm;
      border-radius: 2px;
      border: 1px solid #e2e8f0;
      background: #f1f5f9;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
    }
    .photo-placeholder span { font-size: 16px; color: #94a3b8; line-height: 1; }
    .photo-placeholder small { font-size: 5px; color: #94a3b8; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase; }

    /* Info */
    .ic { flex: 1; min-width: 0; }
    .wname {
      font-size: 9.5px;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.2;
      margin-bottom: 5px;
      word-break: break-word;
    }
    .r { display: flex; gap: 3px; margin-bottom: 2.5px; align-items: baseline; }
    .rl {
      font-size: 5.5px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
      width: 40px;
    }
    .rv {
      font-size: 6.5px;
      color: #374151;
      font-weight: 500;
      word-break: break-word;
      flex: 1;
    }

    /* Footer card */
    .cf {
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      padding: 2.5px 9px;
      display: flex;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .ft { font-size: 5px; color: #94a3b8; }

    /* ── Retro ── */
    .back-body { gap: 8px; align-items: center; }

    .back-left { flex: 1; min-width: 0; }
    .comp-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 5px;
    }
    .cdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .clbl { font-size: 6px; font-weight: 700; color: #64748b;
      text-transform: uppercase; letter-spacing: 0.05em; flex: 1; }
    .cval { font-size: 7px; font-weight: 700; white-space: nowrap; }

    .sep { height: 1px; background: #f1f5f9; margin: 5px 0; }

    .code-lbl { font-size: 5.5px; font-weight: 700; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 2px; }
    .code-val { font-family: 'Courier New', monospace; font-size: 7px;
      font-weight: 700; color: #0f172a; word-break: break-all; }

    /* QR verifica — fronte */
    .front-qr {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border-left: 1px solid #e2e8f0;
      padding-left: 5px;
      margin-left: 3px;
    }
    .qr-verify-img { width: 14mm; height: 14mm; display: block; }
    .qr-verify-hint {
      font-size: 4.5px;
      font-weight: 700;
      color: #64748b;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 2px;
      line-height: 1.3;
    }

    /* QR timbratura — retro */
    .back-right { flex-shrink: 0; text-align: center; }
    .qr-img { width: 22mm; height: 22mm; display: block; }
    .qr-hint { font-size: 5px; color: #94a3b8; line-height: 1.4;
      text-align: center; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="page">

    <div class="hint">
      <strong>1. Stampare</strong> · <strong>2. Ritagliare</strong> entrambi i rettangoli ·
      <strong>3. Incollare schiena a schiena</strong> (fronte fuori, retro fuori) · <strong>4. Plastificare</strong>
    </div>

    <div class="face-label">▲ Fronte</div>
    ${front}

    <div class="gap"></div>

    <div class="face-label">▲ Retro</div>
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
