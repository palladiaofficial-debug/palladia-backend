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
// NOTA: express-rate-limit vieta di condividere una singola istanza di store tra
// più limiter (ERR_ERL_STORE_REUSE) — ogni limiter ora ha il proprio RedisStore
// con prefisso univoco, tutti sulla stessa connessione ioredis sottostante.
let RedisStoreClass = null;
let redisClient      = null;

if (process.env.REDIS_URL) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const Redis          = require('ioredis');
    RedisStoreClass = RedisStore;
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck:     false,
      lazyConnect:          true,
    });
    redisClient.on('connect', () => console.log('[Redis] connesso — rate limit distribuito attivo'));
    redisClient.on('error',   (e) => console.warn('[Redis] errore connessione:', e.message));
    console.log('[rateLimit] store Redis configurato');
  } catch (e) {
    console.warn('[rateLimit] Redis non disponibile — fallback a memoria:', e.message);
  }
} else {
  console.log('[rateLimit] store in-memory (configura REDIS_URL per store distribuito)');
}

function makeStore(prefix) {
  if (!redisClient) return {};
  return {
    store: new RedisStoreClass({
      prefix:      `rl:${prefix}:`,
      sendCommand: (...args) => redisClient.call(...args),
    }),
  };
}

// ── Rate limiter per POST /api/v1/scan/punch ──────────────────────────────────
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore('scan'),
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
  ...makeStore('identify'),
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
  ...makeStore('api'),
});

// ── Rate limiter per GET /api/v1/asl/:token ───────────────────────────────────
const aslLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 ora
  max: 30,                   // 30 verifiche/ora per IP — sufficiente per un'ispezione reale
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore('asl'),
});

// ── Rate limiter per endpoint pubblici coordinatore CSE ───────────────────────
const coordinatorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore('coordinator'),
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
  ...makeStore('chat'),
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
  ...makeStore('ai'),
});

// ── Rate limiter per utente su /chat/stream — in aggiunta a chatLimiter
// (che è per company). Protegge lo scenario in cui una company grande ha
// margine sul limite company-wide ma un singolo utente (script/loop/account
// compromesso) lo consuma da solo. Soglia larga apposta: un umano che scrive
// a Ladia, anche velocissimo, non manda più di qualche messaggio al minuto —
// 30/min è già ben oltre qualunque uso legittimo, solo un loop la raggiunge.
const userChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    if (req.user?.id) return `chat:user:${req.user.id}`;
    const ip = req.ip || '';
    return `chat:ip:${ip.startsWith('::ffff:') ? ip.slice(7) : ip || 'unknown'}`;
  },
  handler: (req, res) => {
    console.warn(`[costGuard] userChatLimiter raggiunto — user=${req.user?.id || 'n/d'} company=${req.companyId || 'n/d'}`);
    res.status(429).json({
      error:   'USER_CHAT_RATE_LIMIT',
      message: 'Stai inviando troppi messaggi in poco tempo. Aspetta qualche secondo e riprova.',
    });
  },
  ...makeStore('userChat'),
});

// ── Rate limiter per utente sugli upload di Importazione Intelligente ───────
// In aggiunta a chatLimiter (per company). Un'importazione è un'azione
// occasionale — anche un onboarding con decine di batch nello stesso giorno
// resta ben sotto questa soglia; solo uno script che rilancia l'endpoint in
// loop la raggiunge.
const userImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 ora
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    if (req.user?.id) return `import:user:${req.user.id}`;
    const ip = req.ip || '';
    return `import:ip:${ip.startsWith('::ffff:') ? ip.slice(7) : ip || 'unknown'}`;
  },
  handler: (req, res) => {
    console.warn(`[costGuard] userImportLimiter raggiunto — user=${req.user?.id || 'n/d'} company=${req.companyId || 'n/d'}`);
    res.status(429).json({
      error:   'USER_IMPORT_RATE_LIMIT',
      message: 'Troppe importazioni in poco tempo. Aspetta qualche minuto e riprova.',
    });
  },
  ...makeStore('userImport'),
});

// ── Rate limiter per POST /chat/confirm-action/:id — separato da chatLimiter,
// non consuma il budget della chat perché è un endpoint REST a parte.
const confirmActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    if (req.companyId) return `confirmAction:company:${req.companyId}`;
    const ip = req.ip || '';
    return `confirmAction:ip:${ip.startsWith('::ffff:') ? ip.slice(7) : ip || 'unknown'}`;
  },
  message: { error: 'CONFIRM_ACTION_RATE_LIMIT' },
  ...makeStore('confirmAction'),
});

// ── Rate limiter per scan/verify-qr e scan/worksites (endpoint pubblici) ─────
const publicScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore('publicScan'),
});

// Webhook fatture SdI: chiamato dal provider (Openapi), non da un browser —
// limite generoso per non perdere fatture reali in un giorno di picco, ma
// comunque presente per non lasciare la rotta senza nessun freno.
const sdiWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore('sdiWebhook'),
});

// Webhook fatture via email (Mailgun): chiamato dal provider, non da un browser —
// stesso limite generoso di sdiWebhookLimiter, per non perdere fatture reali in un
// giorno di picco (uno zip con più fatture arriva comunque come UNA richiesta).
const emailIngestWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore('emailIngestWebhook'),
});

// Limite per mittente reale (non solo per la rotta) — un singolo indirizzo
// compromesso o difettoso non deve poter flooddare una company. Va montato DOPO
// multer nella catena (serve req.body.sender già parsato) — stesso pattern di
// checkChatRateLimit in routes/telegram.js, qui però via express-rate-limit per
// restare coerenti con lo store Redis condiviso.
const emailIngestSenderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const recipient = String(req.body?.recipient || '').toLowerCase();
    const sender    = String(req.body?.sender || req.body?.from || '').toLowerCase();
    return `emailIngestSender:${recipient}:${sender}`;
  },
  message: { error: 'RATE_LIMIT_EXCEEDED' },
  ...makeStore('emailIngestSender'),
});

module.exports = { scanLimiter, identifyLimiter, apiLimiter, aslLimiter, coordinatorLimiter, chatLimiter, userChatLimiter, aiLimiter, userImportLimiter, publicScanLimiter, confirmActionLimiter, sdiWebhookLimiter, emailIngestWebhookLimiter, emailIngestSenderLimiter };
