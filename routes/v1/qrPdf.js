'use strict';
const router   = require('express').Router();
const QRCode   = require('qrcode');
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { rendererPool }      = require('../../pdf-renderer');
const { signQrToken }       = require('./qr');

const QR_TTL_SECS_DEFAULT = parseInt(process.env.QR_TOKEN_TTL_SECS || String(30 * 86400), 10);

// GET /api/v1/sites/:siteId/qr-pdf — genera PDF stampabile con QR code (JWT protetto)
router.get('/sites/:siteId/qr-pdf', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const rawDays = parseInt(req.query.ttl_days, 10);
  const QR_TTL_SECS = (!req.query.ttl_days || isNaN(rawDays) || rawDays <= 0)
    ? QR_TTL_SECS_DEFAULT
    : Math.min(rawDays, 365) * 86400;

  // 1. Verifica ownership cantiere
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, address, company_id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (siteErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!site)   return res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' });

  // 2. Fetch nome company
  const { data: company, error: compErr } = await supabase
    .from('companies')
    .select('name')
    .eq('id', req.companyId)
    .maybeSingle();

  if (compErr) return res.status(500).json({ error: 'DB_ERROR' });
  const companyName = company?.name || '';

  // 3. Genera QR URL firmato
  const exp = Math.floor(Date.now() / 1000) + QR_TTL_SECS;
  let token;
  try {
    token = signQrToken(siteId, exp);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const appBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const qrUrl   = `${appBase}/scan/${encodeURIComponent(siteId)}?t=${token}&exp=${exp}`;

  // 4. Genera immagine QR come data URL base64
  let qrDataUrl;
  try {
    qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 400, margin: 2 });
  } catch (e) {
    return res.status(500).json({ error: 'QR_GENERATION_FAILED', message: e.message });
  }

  // 5. Data scadenza leggibile
  const expiresDate = new Date(exp * 1000).toLocaleDateString('it-IT', {
    day: '2-digit', month: 'long', year: 'numeric'
  });

  // 6. Costruisce HTML della pagina stampabile A4
  const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 22mm 20mm 20mm 20mm; }
    html, body {
      width: 210mm;
      font-family: Arial, Helvetica, sans-serif;
      background: #ffffff;
      color: #111827;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .page {
      width: 100%;
      min-height: 255mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 0;
    }

    /* ── Top bar ── */
    .topbar {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 2px solid #111827;
      padding-bottom: 12px;
      margin-bottom: 36px;
    }
    .brand {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.22em;
      color: #111827;
      text-transform: uppercase;
    }
    .company-name {
      font-size: 11px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    /* ── Title block ── */
    .section-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: #9ca3af;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .site-name {
      font-size: 30px;
      font-weight: 700;
      color: #111827;
      line-height: 1.15;
      margin-bottom: 6px;
      letter-spacing: -0.01em;
    }
    .site-address {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 40px;
    }

    /* ── QR block ── */
    .qr-wrap {
      background: #ffffff;
      border: 2px solid #111827;
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 32px;
      display: inline-block;
    }
    .qr-wrap img {
      display: block;
      width: 270px;
      height: 270px;
    }

    /* ── Instruction ── */
    .instruction-title {
      font-size: 16px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 10px;
      line-height: 1.3;
    }
    .instruction-sub {
      font-size: 12px;
      color: #6b7280;
      max-width: 340px;
      margin: 0 auto 28px;
      line-height: 1.5;
    }

    /* ── Steps row ── */
    .steps {
      display: flex;
      align-items: stretch;
      justify-content: center;
      gap: 0;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      overflow: hidden;
      margin-bottom: 36px;
      width: 340px;
    }
    .step {
      flex: 1;
      padding: 10px 8px;
      text-align: center;
      border-right: 1px solid #e5e7eb;
    }
    .step:last-child { border-right: none; }
    .step-num {
      font-size: 10px;
      font-weight: 700;
      color: #9ca3af;
      display: block;
      margin-bottom: 3px;
    }
    .step-label {
      font-size: 10px;
      font-weight: 600;
      color: #374151;
      line-height: 1.3;
    }

    /* ── Validity ── */
    .validity {
      font-size: 10px;
      color: #9ca3af;
      margin-bottom: 0;
    }

    /* ── Footer ── */
    .footer {
      margin-top: auto;
      width: 100%;
      padding-top: 14px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .footer-left {
      font-size: 9px;
      color: #d1d5db;
      text-align: left;
    }
    .footer-right {
      font-size: 9px;
      color: #d1d5db;
      text-align: right;
    }
  </style>
</head>
<body>
  <div class="page">

    <!-- Top bar -->
    <div class="topbar">
      <div class="brand">PALLADIA</div>
      ${companyName ? `<div class="company-name">${escapeHtml(companyName)}</div>` : ''}
    </div>

    <!-- Site title -->
    <div class="section-label">Timbratura Presenze Cantiere</div>
    <div class="site-name">${escapeHtml(site.name)}</div>
    ${site.address
      ? `<div class="site-address">${escapeHtml(site.address)}</div>`
      : '<div style="margin-bottom:40px"></div>'
    }

    <!-- QR Code -->
    <div class="qr-wrap">
      <img src="${qrDataUrl}" alt="QR Code timbratura cantiere" width="270" height="270">
    </div>

    <!-- Instruction -->
    <div class="instruction-title">Inquadra il QR con il telefono</div>
    <div class="instruction-sub">
      Inserisci il codice fiscale al primo accesso e registra entrata o uscita.
      Nessuna app da installare — funziona dal browser dello smartphone.
    </div>

    <!-- Steps -->
    <div class="steps">
      <div class="step">
        <span class="step-num">01</span>
        <span class="step-label">Inquadra il QR</span>
      </div>
      <div class="step">
        <span class="step-num">02</span>
        <span class="step-label">Inserisci codice fiscale</span>
      </div>
      <div class="step">
        <span class="step-num">03</span>
        <span class="step-label">Timbra entrata / uscita</span>
      </div>
    </div>

    <!-- Validity -->
    <div class="validity">QR valido fino al ${expiresDate}</div>

    <!-- Footer -->
    <div class="footer">
      <div class="footer-left">Registro presenze digitale tramite Palladia &bull; D.Lgs. 81/2008</div>
      <div class="footer-right">${escapeHtml(site.name)}</div>
    </div>

  </div>
</body>
</html>`;

  // 7. Render PDF tramite rendererPool
  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, {
      docTitle: `QR Cantiere — ${site.name}`,
      rev: 1
    });
  } catch (e) {
    console.error('[qrPdf] render error:', e.message);
    return res.status(500).json({ error: 'PDF_RENDER_FAILED', message: e.message });
  }

  const safeName = site.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="qr-${safeName}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.end(pdfBuffer);
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = router;
