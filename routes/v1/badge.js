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

function statusDot(status) {
  const map = {
    ok:       { color: '#22c55e', label: 'Valida'         },
    expiring: { color: '#f59e0b', label: 'In scadenza'    },
    expired:  { color: '#ef4444', label: 'SCADUTA'        },
    not_set:  { color: '#94a3b8', label: 'Non impostata'  },
  };
  const { color, label } = map[status] || map.not_set;
  return `<span style="display:inline-flex;align-items:center;gap:5px;">
    <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};flex-shrink:0;"></span>
    <span style="color:${color};font-weight:600;">${label}</span>
  </span>`;
}

function overallBadge(overall) {
  const map = {
    compliant:     { bg: '#22c55e', text: '#ffffff', label: 'ATTIVO — CONFORME'    },
    expiring:      { bg: '#f59e0b', text: '#ffffff', label: 'ATTENZIONE — SCADENZE VICINE' },
    non_compliant: { bg: '#ef4444', text: '#ffffff', label: 'DOCUMENTI SCADUTI'    },
    incomplete:    { bg: '#64748b', text: '#ffffff', label: 'DATI INCOMPLETI'      },
    inactive:      { bg: '#1e293b', text: '#94a3b8', label: 'INATTIVO'             },
  };
  const { bg, text, label } = map[overall] || map.inactive;
  return `<div style="background:${bg};color:${text};font-size:10px;font-weight:700;
    letter-spacing:0.12em;text-transform:uppercase;text-align:center;
    padding:7px 16px;border-radius:4px;display:inline-block;">${label}</div>`;
}

function buildBadgePdfHtml({
  worker, companyName, employerLabel, hireDateStr,
  safetyStatus, healthStatus, overall, qrDataUrl, badgeUrl,
}) {
  const photoBlock = worker.photo_url
    ? `<img src="${esc(worker.photo_url)}" alt="Foto lavoratore"
         style="width:62mm;height:75mm;object-fit:cover;display:block;border-radius:4px;
                border:1px solid #e2e8f0;">`
    : `<div style="width:62mm;height:75mm;background:#f1f5f9;border-radius:4px;
                   border:1px solid #e2e8f0;display:flex;flex-direction:column;
                   align-items:center;justify-content:center;gap:6px;">
         <div style="font-size:28px;color:#94a3b8;">&#128100;</div>
         <div style="font-size:9px;color:#94a3b8;font-weight:600;letter-spacing:0.08em;">NESSUNA FOTO</div>
       </div>`;

  const infoRows = [
    worker.qualification  ? `<div class="info-row"><span class="info-label">Qualifica</span><span class="info-value">${esc(worker.qualification)}</span></div>` : '',
    worker.role           ? `<div class="info-row"><span class="info-label">Mansione</span><span class="info-value">${esc(worker.role)}</span></div>` : '',
    employerLabel         ? `<div class="info-row"><span class="info-label">Impresa</span><span class="info-value">${esc(employerLabel)}</span></div>` : '',
    hireDateStr           ? `<div class="info-row"><span class="info-label">Data assunzione</span><span class="info-value">${esc(hireDateStr)}</span></div>` : '',
    `<div class="info-row"><span class="info-label">Subappalto</span><span class="info-value">${worker.subcontracting_auth ? 'Autorizzato' : 'Non autorizzato'}</span></div>`,
  ].filter(Boolean).join('');

  // Formatta badge_code con trattino ogni 6 char per leggibilità: A3F7K2-09B1E8-D0C5F4
  const codeFormatted = (worker.badge_code || '').replace(/(.{6})/g, '$1-').replace(/-$/, '');

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* Margini CSS devono corrispondere a Puppeteer (26mm top, 24mm bottom) */
    @page { size: A4 portrait; margin: 26mm 0 24mm 0; }

    html, body {
      width: 210mm;
      font-family: Arial, Helvetica, sans-serif;
      background: #ffffff;
      color: #111827;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* Wrapper centrato — usa tutta la zona contenuto (247mm × 210mm) */
    .page {
      width: 100%;
      padding: 0 16mm;          /* allineato ai margini laterali Puppeteer H/F */
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    /* Istruzione di taglio */
    .cut-hint {
      font-size: 8.5px;
      color: #9ca3af;
      text-align: center;
      margin-bottom: 8mm;
      letter-spacing: 0.05em;
    }
    .cut-hint strong { color: #6b7280; }

    /* Scheda badge — dimensione A6 landscape (148mm × 105mm) centrata */
    .badge-card {
      width: 170mm;
      border: 1.5px dashed #cbd5e1;
      border-radius: 8px;
      overflow: hidden;
    }

    /* ── Header scheda ── */
    .card-header {
      background: #0f172a;
      padding: 8px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand-line {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.22em;
      color: #f8fafc;
      text-transform: uppercase;
    }
    .badge-type-line {
      font-size: 8px;
      color: #94a3b8;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .overall-pill {
      font-size: 7.5px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 20px;
    }

    /* ── Corpo scheda ── */
    .card-body {
      display: flex;
      gap: 14px;
      padding: 12px 14px;
      background: #ffffff;
    }

    /* Colonna foto */
    .photo-col {
      flex-shrink: 0;
    }

    /* Colonna dati */
    .info-col {
      flex: 1;
      min-width: 0;
    }
    .worker-name {
      font-size: 17px;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.2;
      margin-bottom: 10px;
      word-break: break-word;
    }
    .info-row {
      display: flex;
      gap: 6px;
      margin-bottom: 5px;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .info-label {
      font-size: 8px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      flex-shrink: 0;
      min-width: 70px;
    }
    .info-value {
      font-size: 9.5px;
      color: #374151;
      font-weight: 500;
      word-break: break-word;
    }

    /* ── Divider ── */
    .divider {
      height: 1px;
      background: #f1f5f9;
      margin: 0 14px;
    }

    /* ── Riga compliance ── */
    .compliance-row {
      display: flex;
      gap: 0;
      padding: 9px 14px;
      background: #f8fafc;
      flex-wrap: wrap;
    }
    .compliance-item {
      flex: 1;
      min-width: 50%;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .comp-label {
      font-size: 7.5px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .comp-status {
      font-size: 9px;
    }

    /* ── Riga QR ── */
    .qr-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      background: #ffffff;
      border-top: 1px solid #f1f5f9;
    }
    .qr-img {
      width: 36mm;
      height: 36mm;
      flex-shrink: 0;
    }
    .qr-info {
      flex: 1;
      min-width: 0;
    }
    .badge-code-label {
      font-size: 7px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 3px;
    }
    .badge-code-value {
      font-family: 'Courier New', monospace;
      font-size: 11px;
      font-weight: 700;
      color: #0f172a;
      letter-spacing: 0.04em;
      word-break: break-all;
      margin-bottom: 6px;
    }
    .badge-verify-hint {
      font-size: 7.5px;
      color: #94a3b8;
      line-height: 1.4;
    }
    .badge-verify-url {
      color: #3b82f6;
      font-size: 7.5px;
    }

    /* ── Footer scheda ── */
    .card-footer {
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      padding: 5px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .footer-left {
      font-size: 7px;
      color: #94a3b8;
    }
    .footer-right {
      font-size: 7px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="page">

    <div class="cut-hint">
      <strong>Stampare</strong> · Ritagliare lungo la linea tratteggiata · <strong>Plastificare</strong> · Consegnare al lavoratore
    </div>

    <div class="badge-card">

      <!-- Header -->
      <div class="card-header">
        <div>
          <div class="brand-line">PALLADIA</div>
          <div class="badge-type-line">Badge Digitale Lavoratore</div>
        </div>
        ${buildOverallPill(overall)}
      </div>

      <!-- Corpo: foto + dati -->
      <div class="card-body">
        <div class="photo-col">${photoBlock}</div>
        <div class="info-col">
          <div class="worker-name">${esc(worker.full_name)}</div>
          ${infoRows}
        </div>
      </div>

      <div class="divider"></div>

      <!-- Compliance -->
      <div class="compliance-row">
        <div class="compliance-item">
          <span class="comp-label">Formazione</span>
          <span class="comp-status">${statusDot(safetyStatus)}</span>
        </div>
        <div class="compliance-item">
          <span class="comp-label">Idoneità Sanitaria</span>
          <span class="comp-status">${statusDot(healthStatus)}</span>
        </div>
      </div>

      <!-- QR + codice -->
      <div class="qr-row">
        <img src="${qrDataUrl}" alt="QR badge" class="qr-img">
        <div class="qr-info">
          <div class="badge-code-label">Codice Badge Univoco</div>
          <div class="badge-code-value">${esc(codeFormatted)}</div>
          <div class="badge-verify-hint">
            Scansiona il QR per verificare<br>
            lo stato del badge in tempo reale
          </div>
        </div>
      </div>

      <!-- Footer scheda -->
      <div class="card-footer">
        <span class="footer-left">D.Lgs. 81/2008 · Badge anticontraffazione Palladia</span>
        <span class="footer-right">${esc(companyName)}</span>
      </div>

    </div><!-- /badge-card -->

  </div><!-- /page -->
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
