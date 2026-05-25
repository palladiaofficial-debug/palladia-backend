'use strict';
/**
 * routes/authHook.js
 * Supabase "Send Email" Auth Hook — Standard Webhooks v1,whsec_<base64>
 *
 * Montato con express.raw() PRIMA di express.json() per preservare il raw body
 * necessario alla verifica HMAC-SHA256.
 *
 * Configurazione Supabase Dashboard:
 *   Authentication → Hooks → Send Email Hook → HTTPS
 *   URL:    https://palladia-backend-production.up.railway.app/api/auth/hook/send-email
 *   Secret: clicca "Generate secret" → copia il valore → incollalo anche su Railway
 *           come SUPABASE_HOOK_SECRET (stesso identico valore, es. v1,whsec_xxx...)
 */

const crypto = require('crypto');
const {
  sendConfirmEmail,
  sendPasswordResetEmail,
  sendMagicLinkEmail,
  sendEmailChangeEmail,
} = require('../services/email');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia-kappa.vercel.app').replace(/\/$/, '');
const HOOK_SECRET  = process.env.SUPABASE_HOOK_SECRET || '';

// ── Verifica firma Standard Webhooks ─────────────────────────────────────────
// Supabase firma il raw body con HMAC-SHA256 usando la chiave decodificata da
// v1,whsec_<base64>. La firma è nell'header Authorization come "Bearer v1=<hex>".
function verifySignature(rawBody, authHeader, secret) {
  if (!secret) return true; // nessun segreto configurato → skip (solo dev)

  // Estrai la chiave raw dalla stringa v1,whsec_<base64>
  const whsecMatch = secret.match(/^v1,whsec_(.+)$/);
  if (!whsecMatch) {
    console.warn('[auth-hook] SUPABASE_HOOK_SECRET non nel formato v1,whsec_<base64> — skip verifica');
    return true;
  }
  const keyBytes = Buffer.from(whsecMatch[1], 'base64');

  // Estrai la firma ricevuta dall'header: "Bearer v1=<hex>"
  const sigMatch = (authHeader || '').match(/Bearer\s+v1=([0-9a-f]+)/i);
  if (!sigMatch) {
    console.warn('[auth-hook] Authorization header assente o non nel formato Bearer v1=<hex>');
    return false;
  }
  const receivedHex = sigMatch[1];

  let computedHex;
  try {
    computedHex = crypto.createHmac('sha256', keyBytes)
      .update(rawBody)
      .digest('hex');
  } catch (e) {
    console.error('[auth-hook] errore HMAC:', e.message);
    return false;
  }

  // timing-safe compare
  const a = Buffer.from(computedHex, 'hex');
  const b = Buffer.from(receivedHex.padEnd(computedHex.length, '0'), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Costruisce URL di verifica Supabase ───────────────────────────────────────
function buildVerifyUrl(tokenHash, type, redirectTo) {
  const dest = redirectTo || `${FRONTEND_URL}/login`;
  return `${SUPABASE_URL}/auth/v1/verify?token=${tokenHash}&type=${type}&redirect_to=${encodeURIComponent(dest)}`;
}

// ── Handler (esportato direttamente — express.raw() è già applicato in server.js) ──
module.exports = async function authHookHandler(req, res) {
  const rawBody = req.body; // Buffer (grazie a express.raw)

  // Verifica firma
  if (!verifySignature(rawBody, req.headers['authorization'], HOOK_SECRET)) {
    console.warn('[auth-hook] firma non valida — IP:', req.ip);
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  // Parsa il body JSON manualmente (raw body = Buffer)
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'INVALID_JSON' });
  }

  const { user, email_data } = payload || {};
  if (!user?.email || !email_data?.email_action_type) {
    console.error('[auth-hook] payload malformato:', JSON.stringify(payload).slice(0, 200));
    return res.status(400).json({ error: 'INVALID_PAYLOAD' });
  }

  const { token_hash, token_hash_new, redirect_to, email_action_type } = email_data;
  const to   = user.email;
  const name = user.user_metadata?.full_name || user.user_metadata?.name || null;

  console.log(`[auth-hook] type=${email_action_type} to=${to}`);

  try {
    switch (email_action_type) {

      case 'signup': {
        const confirmUrl = buildVerifyUrl(token_hash, 'signup', redirect_to);
        await sendConfirmEmail({ to, confirmUrl, name });
        break;
      }

      case 'recovery': {
        const resetLink = buildVerifyUrl(token_hash, 'recovery', redirect_to);
        await sendPasswordResetEmail({ to, resetLink });
        break;
      }

      case 'magiclink': {
        const magicUrl = buildVerifyUrl(token_hash, 'magiclink', redirect_to);
        await sendMagicLinkEmail({ to, magicUrl });
        break;
      }

      case 'email_change': {
        const hash      = token_hash_new || token_hash;
        const changeUrl = buildVerifyUrl(hash, 'email_change', redirect_to);
        await sendEmailChangeEmail({ to, changeUrl });
        break;
      }

      case 'invite':
        // Palladia usa il proprio sistema inviti — ignora silenziosamente
        console.log('[auth-hook] invite ignorato (Palladia usa inviti custom)');
        break;

      default:
        console.warn('[auth-hook] tipo non gestito:', email_action_type);
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[auth-hook] errore invio email:', err.message);
    res.status(500).json({ error: 'EMAIL_SEND_FAILED', detail: err.message });
  }
};
