'use strict';
const router   = require('express').Router();
const QRCode   = require('qrcode');
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { rendererPool }      = require('../../pdf-renderer');
const { signQrToken }       = require('./qr');

const QR_TTL_SECS = parseInt(process.env.QR_TOKEN_TTL_SECS || '604800', 10);

// GET /api/v1/sites/:siteId/qr-pdf — genera PDF stampabile con QR code (JWT protetto)
router.get('/sites/:siteId/qr-pdf', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

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

  // 6. Costruisce HTML della pagina stampabile
  const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 20mm; }
    html, body {
      width: 210mm;
      font-family: Arial, Helvetica, sans-serif;
      background: #ffffff;
      color: #111827;
    }
    .page {
      width: 100%;
      min-height: 257mm; /* 297 - 20 - 20 */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0;
    }
    .brand {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.18em;
      color: #9ca3af;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .company-name {
      font-size: 15px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 32px;
    }
    .site-name {
      font-size: 28px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 8px;
      line-height: 1.2;
    }
    .site-address {
      font-size: 14px;
      color: #6b7280;
      margin-bottom: 40px;
    }
    .qr-wrap {
      background: #ffffff;
      border: 2px solid #e5e7eb;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 28px;
      display: inline-block;
    }
    .qr-wrap img {
      display: block;
      width: 200px;
      height: 200px;
    }
    .cta {
      font-size: 15px;
      font-weight: 600;
      color: #111827;
      margin-bottom: 10px;
    }
    .validity {
      font-size: 12px;
      color: #9ca3af;
      margin-bottom: 48px;
    }
    .footer {
      font-size: 10px;
      color: #d1d5db;
      border-top: 1px solid #f3f4f6;
      padding-top: 12px;
      width: 100%;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="brand">PALLADIA</div>
    <div class="company-name">${escapeHtml(companyName)}</div>
    <div class="site-name">${escapeHtml(site.name)}</div>
    ${site.address ? `<div class="site-address">${escapeHtml(site.address)}</div>` : '<div class="site-address">&nbsp;</div>'}
    <div class="qr-wrap">
      <img src="${qrDataUrl}" alt="QR Code timbratura" width="200" height="200">
    </div>
    <div class="cta">Inquadra il QR con il tuo smartphone per timbrare presenza</div>
    <div class="validity">Valido fino al: ${expiresDate}</div>
    <div class="footer">Registro Presenze Digitale &bull; D.Lgs. 81/2008</div>
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
