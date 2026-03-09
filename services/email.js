const { Resend } = require('resend');

const FROM = 'PalladIA <noreply@palladia.it>';

// Inizializzazione lazy: evita crash al boot se RESEND_API_KEY non è impostata.
// Il server.js già gestisce il caso RESEND_API_KEY assente con un warning + risposta 200.
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not configured');
  return new Resend(key);
}

// ─── Template helpers ──────────────────────────────────────────────────────

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

      <!-- Header -->
      <tr>
        <td style="background:#0f172a;padding:28px 32px;">
          <span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">PALLADIA</span>
          <span style="color:#94a3b8;font-size:12px;margin-left:12px;">Registro Presenze Digitale</span>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:32px;">
          ${bodyHtml}
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
            PalladIA – Registro Presenze Digitale &middot; info@palladia.it<br />
            Hai ricevuto questa email perché hai un account su PalladIA.
            Se non sei stato tu, ignora questa email o contattaci.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function btn(text, href) {
  return `<a href="${href}" style="display:inline-block;margin-top:24px;padding:12px 28px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">${text}</a>`;
}

// ─── Email: Benvenuto ──────────────────────────────────────────────────────

/**
 * @param {{ to: string, name: string, companyName: string }} opts
 */
async function sendWelcomeEmail({ to, name, companyName }) {
  const firstName = name.split(' ')[0];
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;color:#0f172a;">Benvenuto su PalladIA, ${firstName}!</h1>
    <p style="margin:0 0 16px;color:#64748b;font-size:14px;line-height:1.6;">
      Il tuo account e l'azienda <strong style="color:#0f172a;">${companyName}</strong> sono stati configurati con successo.
      Puoi già iniziare a gestire i tuoi cantieri.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin:20px 0;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#0f172a;">Cosa puoi fare adesso:</p>
          <ul style="margin:0;padding-left:18px;color:#64748b;font-size:13px;line-height:2;">
            <li>Aggiungere i tuoi cantieri attivi</li>
            <li>Inserire i lavoratori con codice fiscale</li>
            <li>Generare i badge QR per le timbrature</li>
            <li>Produrre il POS in PDF</li>
          </ul>
        </td>
      </tr>
    </table>

    ${btn('Vai alla dashboard', 'https://palladia.it/dashboard')}

    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">
      Ricorda: PalladIA supporta la gestione digitale delle presenze ma non sostituisce gli obblighi di legge
      previsti dal D.Lgs.&nbsp;81/2008. L'azienda resta responsabile della corretta applicazione della normativa.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: `Benvenuto su PalladIA — ${companyName} è pronta`,
    html: layout('Benvenuto su PalladIA', body),
  });
}

// ─── Email: Reset password (backup — Supabase la gestisce nativamente) ────

/**
 * Non utilizzata di default: Supabase invia già l'email di reset.
 * Disponibile per override manuale se necessario.
 * @param {{ to: string, resetLink: string }} opts
 */
async function sendPasswordResetEmail({ to, resetLink }) {
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;color:#0f172a;">Reimposta la tua password</h1>
    <p style="margin:0 0 16px;color:#64748b;font-size:14px;line-height:1.6;">
      Hai richiesto il reset della password per il tuo account PalladIA.<br />
      Clicca il pulsante qui sotto per scegliere una nuova password.
      Il link è valido per <strong>60 minuti</strong>.
    </p>
    ${btn('Reimposta password', resetLink)}
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;">
      Se non hai richiesto il reset, ignora questa email. La tua password non verrà modificata.
    </p>
  `;

  return getResend().emails.send({
    from: FROM,
    to,
    subject: 'Reimposta la tua password — PalladIA',
    html: layout('Reimposta password', body),
  });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail };
