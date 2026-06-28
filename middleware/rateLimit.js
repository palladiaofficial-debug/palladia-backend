'use strict';
/**
 * middleware/rateLimit.js
 *
 * Rate limiting con store Redis opzionale.
 * - Se REDIS_URL è configurata → contatori persistenti su Redis
 *   (funziona anche con più istanze parallele su Railway)
 * - Se non configurata → fallback a memoria in-process (default attuale)
 *
 * Per attivare Redis: aggiungi un servizio Redis su Railway e setta
 * la variabile REDIS_URL = redis://default:<password>@<host>:<port>
 */
const rateLimit = require('express-rate-limit');

// ── Store Redis opzionale ─────────────────────────────────────────────────────
let redisStore = null;

if (process.env.REDIS_URL) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const Redis          = require('ioredis');
    const client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck:     false,
      lazyConnect:          true,
    });
    client.on('connect',  () => console.log('[Redis] connesso — rate limit distribuito attivo'));
    client.on('error',    (e) => console.warn('[Redis] errore connessione:', e.message));

    // rate-limit-redis richiede un sendCommand helper
    redisStore = new RedisStore({
      sendCommand: (...args) => client.call(...args),
    });
    console.log('[rateLimit] store Redis configurato');
  } catch (e) {
    console.warn('[rateLimit] Redis non disponibile — fallback a memoria:', e.message);
  }
} else {
  console.log('[rateLimit] store in-memory (configura REDIS_URL per store distribuito)');
}

function makeStore() {
  return redisStore ? { store: redisStore } : {};
}

// ── Rate limiter per POST /api/v1/scan/punch ──────────────────────────────────
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore(),
});

// ── Rate limiter per POST /api/v1/scan/identify ───────────────────────────────
// Key: IP + worksite_id — evita flooding su un singolo cantiere
// Usa validate:false per disabilitare il check IPv6 (il proxy Railway
// restituisce già IPv4 grazie a "trust proxy: 1" in server.js)
const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const raw = req.ip || '';
    const ip  = raw.startsWith('::ffff:') ? raw.slice(7) : (raw || 'unknown');
    const wid = (req.body && req.body.worksite_id) || 'unknown';
    return `identify:${ip}:${wid}`;
  },
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore(),
});

// ── Rate limiter generico per tutte le route /api/v1/ ─────────────────────────
// Key: company_id quando disponibile (dopo JWT), altrimenti IP.
// NOTA: questo limiter gira prima di verifySupabaseJwt, quindi req.companyId
// non è ancora impostato → usa sempre IP. Limite generoso per evitare falsi positivi
// su pagine che fanno molte call in parallelo (dashboard, conversations, ecc.).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    // req.companyId è impostato da verifySupabaseJwt
    if (req.companyId) return `company:${req.companyId}`;
    const ip = req.ip || '';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip || 'unknown';
  },
  message: { error: 'TOO_MANY_REQUESTS' },
  ...makeStore(),
});

// ── Rate limiter per GET /api/v1/asl/:token ───────────────────────────────────
const aslLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 ora
  max: 30,                   // 30 verifiche/ora per IP — sufficiente per un'ispezione reale
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore(),
});

// ── Rate limiter per endpoint pubblici coordinatore CSE ───────────────────────
const coordinatorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore(),
});

// ── Rate limiter per POST /api/v1/chat — assistente IA ───────────────────────
// Limite per company_id (non per IP) — evita che una singola azienda
// monopolizzi il budget Anthropic o faccia abuso tramite più utenti/IP.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    if (req.companyId) return `chat:company:${req.companyId}`;
    const ip = req.ip || '';
    return `chat:ip:${ip.startsWith('::ffff:') ? ip.slice(7) : ip || 'unknown'}`;
  },
  message: { error: 'CHAT_RATE_LIMIT' },
  ...makeStore(),
});

// ── Rate limiter AI: 10 chiamate/minuto per company ──────────────────────────
// Applicato a tutti gli endpoint che chiamano Anthropic (OCR, parse-offerta, ecc.)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    if (req.companyId) return `ai:company:${req.companyId}`;
    const ip = req.ip || '';
    return `ai:${ip.startsWith('::ffff:') ? ip.slice(7) : ip || 'unknown'}`;
  },
  message: { error: 'AI_RATE_LIMIT' },
  ...makeStore(),
});

// ── Rate limiter per scan/verify-qr e scan/worksites (endpoint pubblici) ─────
const publicScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore(),
});

module.exports = { scanLimiter, identifyLimiter, apiLimiter, aslLimiter, coordinatorLimiter, chatLimiter, aiLimiter, publicScanLimiter };
