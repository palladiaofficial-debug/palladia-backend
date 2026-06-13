'use strict';
/**
 * routes/authHook.js — Supabase "Send Email" Auth Hook
 *
 * Standard Webhooks spec (https://www.standardwebhooks.com/):
 *   webhook-id:        <message-id>
 *   webhook-timestamp: <unix-seconds>
 *   webhook-signature: v1,<base64-hmac-sha256>
 *
 * HMAC input: "<webhook-id>.<webhook-timestamp>.<raw-body>"
 * Key:        base64-decode(whsec_part) da SUPABASE_HOOK_SECRET=v1,whsec_<base64>
 *
 * Supabase Dashboard:
 *   Authentication → Hooks → Send Email → HTTPS
 *   URL:    https://palladia-backend-production.up.railway.app/api/auth/hook/send-email
 *   Secret: copiare da "Generate secret" → stesso valore in Railway SUPABASE_HOOK_SECRET
 */

const crypto = require('crypto');
const {
  sendConfirmEmail,
  sendPasswordResetEmail,
  sendMagicLinkEmail,
  sendEmailChangeEmail,
} = require('../services/email');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
const HOOK_SECRET  = process.env.SUPABASE_HOOK_SECRET || '';

// ── Standard Webhooks verification ───────────────────────────────────────────
function verifyStandardWebhook(rawBody, headers, secret) {
  if (!secret) {
    console.error('[auth-hook] SUPABASE_HOOK_SECRET non configurato — richiesta rifiutata');
    return false;
  }

  const msgId        = headers['webhook-id'];
  const msgTimestamp = headers['webhook-timestamp'];
  const msgSig       = headers['webhook-signature'];

  if (!msgId || !msgTimestamp || !msgSig) {
    console.warn('[auth-hook] header Standard Webhooks mancanti', { msgId: !!msgId, msgTimestamp: !!msgTimestamp, msgSig: !!msgSig });
    // Log tutti gli header ricevuti per debug
    console.warn('[auth-hook] header ricevuti:', JSON.stringify(Object.keys(headers)));
    return false;
  }

  // Anti-replay: rifiuta messaggi più vecchi di 5 minuti
  const ts  = parseInt(msgTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) {
    console.warn('[auth-hook] timestamp fuori finestra (replay attack?):', ts, 'now:', now);
    return false;
  }

  // Estrai chiave raw da v1,whsec_<base64>
  const match = secret.match(/^v1,whsec_(.+)$/);
  if (!match) {
    console.warn('[auth-hook] SUPABASE_HOOK_SECRET non nel formato v1,whsec_<base64>');
    return false;
  }
  const keyBytes = Buffer.from(match[1], 'base64');

  // HMAC input: "<id>.<timestamp>.<raw-body>"
  const toSign  = `${msgId}.${msgTimestamp}.${rawBody.toString('utf8')}`;
  const computed = crypto.createHmac('sha256', keyBytes).update(toSign).digest('base64');

  // webhook-signature può contenere più firme separate da spazio: "v1,sig1 v1,sig2"
  const receivedSigs = msgSig.split(' ').map(s => s.replace(/^v1,/, ''));
  const match2 = receivedSigs.some(sig => {
    try {
      const a = Buffer.from(computed, 'base64');
      const b = Buffer.from(sig, 'base64');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  });

  if (!match2) {
    console.warn('[auth-hook] firma non valida. computed:', computed, 'received:', receivedSigs);
  }
  return match2;
}

// ── URL di verifica Supabase ──────────────────────────────────────────────────
function buildVerifyUrl(tokenHash, type, redirectTo) {
  const dest = redirectTo || `${FRONTEND_URL}/login`;
  return `${SUPABASE_URL}/auth/v1/verify?token=${tokenHash}&type=${type}&redirect_to=${encodeURIComponent(dest)}`;
}

// ── Handler principale ────────────────────────────────────────────────────────
module.exports = async function authHookHandler(req, res) {
  const rawBody = req.body; // Buffer (express.raw applicato in server.js)

  if (!verifyStandardWebhook(rawBody, req.headers, HOOK_SECRET)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'INVALID_JSON' });
  }

  const { user, email_data } = payload || {};
  if (!user?.email || !email_data?.email_action_type) {
    console.error('[auth-hook] payload malformato:', JSON.stringify(payload).slice(0, 300));
    return res.status(400).json({ error: 'INVALID_PAYLOAD' });
  }

  const { token_hash, token_hash_new, redirect_to, email_action_type } = email_data;
  const to   = user.email;
  const name = user.user_metadata?.full_name || user.user_metadata?.name || null;

  console.log(`[auth-hook] ✓ type=${email_action_type} to=${to}`);

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
