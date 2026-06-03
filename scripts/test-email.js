'use strict';
/**
 * Test email Resend — verifica che le email transazionali funzionino.
 * Invia 2 email reali a ADMIN_EMAIL:
 *   1. Email semplice via Resend API diretta
 *   2. Template digest giornaliero (il template principale di Palladia)
 *
 * Uso: node scripts/test-email.js
 */

require('dotenv').config();
const https = require('https');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM    = process.env.RESEND_FROM || 'Palladia <noreply@palladia.net>';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || 'palladiaofficial@gmail.com';

if (!RESEND_API_KEY) {
  console.error('✗ RESEND_API_KEY non configurato nel .env');
  process.exit(1);
}

function resendSend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  console.log('── Test email Palladia ──────────────────────────────────');
  console.log(`  From:  ${RESEND_FROM}`);
  console.log(`  To:    ${ADMIN_EMAIL}`);
  console.log(`  Key:   ${RESEND_API_KEY.slice(0, 8)}…`);
  console.log('');

  // ── Test 1: email semplice (verifica chiave + dominio) ──────────────────
  console.log('1. Email semplice...');
  const r1 = await resendSend({
    from:    RESEND_FROM,
    to:      [ADMIN_EMAIL],
    subject: '✅ Palladia — Test email funzionante',
    html:    `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
        <h2 style="color:#111;margin-bottom:8px;">Email di test Palladia</h2>
        <p style="color:#6b7280;">Il sistema email è configurato correttamente.<br>
        Questa email è stata inviata dal backend in produzione.</p>
        <p style="color:#9ca3af;font-size:12px;margin-top:32px;">
          From: ${RESEND_FROM}<br>
          Timestamp: ${new Date().toISOString()}
        </p>
      </div>
    `,
  });

  if (r1.status === 200 || r1.status === 201) {
    console.log(`  ✓ Inviata — ID: ${r1.body.id}`);
  } else {
    console.error(`  ✗ Errore ${r1.status}:`, JSON.stringify(r1.body));
    process.exit(1);
  }

  // ── Test 2: template digest (usa il servizio email di Palladia) ──────────
  console.log('2. Template digest giornaliero...');
  try {
    const { sendDailyAlertDigest } = require('../services/email');
    await sendDailyAlertDigest({
      to:           [ADMIN_EMAIL],
      companyName:  'MSCedilizia S.r.l. (TEST)',
      dashboardUrl: 'https://palladia.net/risorse',
      sections: {
        missingDocs: [
          { full_name: 'Di Leonardo Giuseppe', company_id: 'test', missingTypes: ['Idoneità medica'] },
        ],
        workerExpiry: [
          { full_name: 'Raksasoi Suriya', typeLabel: 'Formazione sicurezza', expiry_date: '2026-04-15', days: -46, severity: 'critical' },
        ],
        companyExpiry:   [],
        equipmentExpiry: [],
      },
    });
    console.log('  ✓ Digest inviato');
  } catch (e) {
    console.error('  ✗ Errore digest:', e.message);
    process.exit(1);
  }

  console.log('');
  console.log('── PASS — controlla la casella di posta ─────────────────');
  console.log(`   ${ADMIN_EMAIL}`);
}

run().catch(e => { console.error('Errore imprevisto:', e.message); process.exit(1); });
