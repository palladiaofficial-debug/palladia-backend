'use strict';
/**
 * services/certificateExpiryCron.js
 * Cron giornaliero (08:00 Europe/Rome) — controlla worker_certificates in scadenza
 * e crea notifiche in-app + email per il modulo Formazione.
 * Chiama direttamente l'endpoint POST /api/v1/notifications/check-expiries in-process.
 */

const cron = require('node-cron');
const http = require('http');

function startCertificateExpiryCron() {
  // Ogni giorno alle 08:00 ora di Roma
  cron.schedule('0 8 * * *', async () => {
    const port   = process.env.PORT || 3001;
    const secret = process.env.CRON_SECRET;

    if (!secret) {
      console.warn('[certificateExpiryCron] CRON_SECRET non configurato — skip');
      return;
    }

    const options = {
      hostname: '127.0.0.1',
      port,
      path:     '/api/v1/notifications/check-expiries',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': '0',
        'x-cron-secret':  secret,
      },
    };

    const req = http.request(options, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('[certificateExpiryCron] check-expiries OK:', raw.slice(0, 120));
        } else {
          console.error(`[certificateExpiryCron] check-expiries errore ${res.statusCode}:`, raw.slice(0, 200));
        }
      });
    });
    req.on('error', e => console.error('[certificateExpiryCron] errore richiesta:', e.message));
    req.end();
  }, { timezone: 'Europe/Rome' });

  console.log('[certificateExpiryCron] avviato — 08:00 Europe/Rome');
}

module.exports = { startCertificateExpiryCron };
