require('dotenv').config();
// Sentry DEVE essere il primo require — cattura errori di tutti i moduli successivi
const Sentry      = require('./lib/sentry');
const errorBuffer = require('./lib/errorBuffer');
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const { createClient } = require('@supabase/supabase-js');
const { generatePdf } = require('./pdf-generator');
const { buildPosDocument } = require('./pos-template');
const { selectSigns } = require('./sign-selector');
const { generatePosHtml } = require('./pos-html-generator');
const { rendererPool } = require('./pdf-renderer');
const rateLimit = require('express-rate-limit');
const v1Router = require('./routes/v1');
const { startMissingExitCron }      = require('./services/missingExitCron');
const { startDailySummaryCron }     = require('./services/dailySummaryCron');
const { startEveningSummaryCron }   = require('./services/eveningSummaryCron');
const { startExpiryAlertCron }      = require('./services/expiryAlertCron');
const { startWorkerExpiryCron }     = require('./services/workerExpiryCron');
const { startLadiaProactiveCron }   = require('./services/ladiaProactive');

// Prevent Node.js 20 from crashing the process on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[PROCESS] uncaughtException — kept alive:', err.message, err.stack);
  Sentry.captureException(err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] unhandledRejection — kept alive:', reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

const app = express();
app.set('trust proxy', 1); // Railway/Nginx proxy — req.ip corretto per rate limit e logging
const PORT = process.env.PORT || 3001;

// ── Request timeout — evita che richieste bloccate tengano occupato il server ─
// SSE/stream e PDF generazione gestiti separatamente (timeout più lungo / semaforo)
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);
app.use((req, res, next) => {
  const skip =
    req.path.includes('/stream') ||
    req.path.includes('/generate-pos') ||
    req.path.includes('/computo') ||
    req.path.includes('/pdf') ||
    req.path.includes('/verbale') ||
    req.path.includes('/asl');          // report PDF ASL può essere lungo
  if (skip) return next();

  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.warn('[timeout]', req.method, req.path, `— superato ${REQUEST_TIMEOUT_MS}ms`);
      res.status(503).json({ error: 'REQUEST_TIMEOUT', message: 'Richiesta scaduta. Riprova.' });
    }
  }, REQUEST_TIMEOUT_MS);

  res.on('finish', () => clearTimeout(timer));
  res.on('close',  () => clearTimeout(timer));
  next();
});

// ── Health check ─────────────────────────────────────────────────────────────
// Railway usa questo endpoint per capire se il container è sano.
// Configurare su Railway: Health Check Path = /api/health
app.get('/api/health', async (req, res) => {
  const mem    = process.memoryUsage();
  const uptime = Math.round(process.uptime());

  // Ping DB — verifica connettività Supabase
  const supabaseHealth = require('./lib/supabase');
  const { error: dbErr } = await supabaseHealth
    .from('companies')
    .select('id')
    .limit(1)
    .maybeSingle();

  const status = dbErr ? 'degraded' : 'ok';

  res.status(dbErr ? 503 : 200).json({
    status,
    uptime_s:   uptime,
    memory: {
      rss_mb:       Math.round(mem.rss        / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed   / 1024 / 1024),
      heap_total_mb:Math.round(mem.heapTotal  / 1024 / 1024),
    },
    db:        dbErr ? `error: ${dbErr.message}` : 'ok',
    timestamp: new Date().toISOString(),
    version:   process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'local',
  });
});

// GET /api/config — espone solo le chiavi pubbliche al frontend (no secret)
app.get('/api/config', (req, res) => {
  res.json({
    supabase_url:      process.env.SUPABASE_URL      || '',
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || ''
  });
});

const ALLOWED_ORIGINS = [
  // Dominio produzione
  'https://palladia.net',
  'https://www.palladia.net',
  // Backend stesso (scan.html servita da Railway fa fetch allo stesso host)
  process.env.APP_BASE_URL,
  /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/,
  // Preview Vercel e Lovable (match per prefisso)
  /^https:\/\/palladia[a-z0-9-]*\.vercel\.app$/,
  /^https:\/\/palladia[a-z0-9-]*\.lovable\.app$/,
  // Sviluppo locale
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    const allowed = ALLOWED_ORIGINS.some(rule =>
      typeof rule === 'string' ? rule === origin : rule.test(origin)
    );
    if (allowed) return callback(null, true);
    console.warn('[CORS] blocked origin:', origin);
    callback(new Error(`CORS: origin not allowed — ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Company-Id']
}));
// ── Stripe Webhook — DEVE stare prima di express.json() ────────────────────
// Stripe invia il body come raw bytes; la verifica firma richiede il raw body.
app.post('/api/webhooks/stripe',
  require('express').raw({ type: 'application/json' }),
  async (req, res) => {
    const sig     = req.headers['stripe-signature'];
    const secret  = process.env.STRIPE_WEBHOOK_SECRET;
    const supabaseW = require('./lib/supabase');

    if (!secret) {
      console.warn('[stripe-webhook] STRIPE_WEBHOOK_SECRET non configurata — webhook ignorato');
      return res.sendStatus(200);
    }

    let event;
    try {
      const { getStripe } = require('./services/stripe');
      event = getStripe().webhooks.constructEvent(req.body, sig, secret);
    } catch (e) {
      console.error('[stripe-webhook] firma non valida:', e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    console.log(`[stripe-webhook] evento: ${event.type}`);

    try {
      if (event.type === 'checkout.session.completed') {
        const session   = event.data.object;
        const companyId = session.client_reference_id || session.metadata?.company_id;
        const plan      = session.metadata?.plan || 'starter';
        if (companyId) {
          await supabaseW.from('companies').update({
            stripe_customer_id:     session.customer,
            stripe_subscription_id: session.subscription,
            subscription_status:    'active',
            subscription_plan:      plan,
          }).eq('id', companyId);
          console.log(`[stripe-webhook] company ${companyId} attivata — piano ${plan}`);
        }
      }

      if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        const { data: company } = await supabaseW
          .from('companies')
          .select('id')
          .eq('stripe_subscription_id', sub.id)
          .maybeSingle();
        if (company) {
          const statusMap = { active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'past_due' };
          await supabaseW.from('companies').update({
            subscription_status:             statusMap[sub.status] || sub.status,
            subscription_current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          }).eq('id', company.id);
        }
      }

      if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const { data: company } = await supabaseW
          .from('companies')
          .select('id')
          .eq('stripe_subscription_id', sub.id)
          .maybeSingle();
        if (company) {
          await supabaseW.from('companies').update({
            subscription_status:    'canceled',
            stripe_subscription_id: null,
          }).eq('id', company.id);
          console.log(`[stripe-webhook] company ${company.id} abbonamento cancellato`);
        }
      }

      if (event.type === 'invoice.payment_failed') {
        const inv = event.data.object;
        const { data: company } = await supabaseW
          .from('companies')
          .select('id')
          .eq('stripe_customer_id', inv.customer)
          .maybeSingle();
        if (company) {
          await supabaseW.from('companies')
            .update({ subscription_status: 'past_due' })
            .eq('id', company.id);
          console.log(`[stripe-webhook] company ${company.id} pagamento fallito`);
        }
      }
    } catch (e) {
      console.error('[stripe-webhook] errore gestione evento:', e.message);
    }

    res.sendStatus(200);
  }
);

app.use(express.json({ limit: '10mb' }));

// ── Security headers (helmet) ─────────────────────────────────────────────────
// Aggiunge automaticamente: X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Referrer-Policy, ecc.
// Content-Security-Policy disabilitato: l'API non serve HTML (tranne public/)
app.use(helmet({
  contentSecurityPolicy:      false,  // API JSON — CSP non rilevante
  crossOriginEmbedderPolicy:  false,
  crossOriginResourcePolicy:  false,  // CRITICO: senza questo blocca tutte le fetch cross-origin
  crossOriginOpenerPolicy:    false,
}));

// ── Compression (gzip) ────────────────────────────────────────────────────────
// Riduce bandwidth del 60-80% sulle risposte JSON grandi (lista lavoratori, report, ecc.)
// Skippa le risposte già compresse (PDF, immagini)
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  threshold: 1024, // comprimi solo risposte > 1KB
}));

// ── Telegram Bot Webhook ─────────────────────────────────────────────────────
app.use('/api/telegram', require('./routes/telegram'));

// ── Badge / Presenze API v1 (auth-protected) ────────────────────────────────
app.use('/api/v1', v1Router);

// Favicon — evita 404 nei log
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Frontend badge (pagine statiche) ────────────────────────────────────────
// Serve i file in /public (scan.html, setup.html)
// Le route SPA sono dichiarate PRIMA di express.static per sicurezza esplicita.
app.get('/scan/:worksiteId', (req, res) => {
  res.sendFile('scan.html', { root: __dirname + '/public' });
});
app.get('/asl/:token', (req, res) => {
  res.sendFile('asl.html', { root: __dirname + '/public' });
});
app.get('/admin', (req, res) => {
  res.sendFile('admin.html', { root: __dirname + '/public' });
});
app.get('/onboarding', (req, res) => {
  res.sendFile('onboarding.html', { root: __dirname + '/public' });
});
app.get('/setup', (req, res) => {
  res.sendFile('setup.html', { root: __dirname + '/public' });
});
app.get('/badge/:code', (req, res) => {
  res.sendFile('badge.html', { root: __dirname + '/public' });
});
app.get('/coordinator/:token', (req, res) => {
  res.sendFile('coordinator.html', { root: __dirname + '/public' });
});
app.get('/demo', (req, res) => {
  res.sendFile('demo.html', { root: __dirname + '/public' });
});
app.use(express.static(__dirname + '/public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// --- Helper: build the POS mega-prompt ---
function buildPosPrompt(posData, revision) {
  return `Sei il miglior Coordinatore per la Sicurezza in Italia con 30 anni di esperienza. Genera un Piano Operativo di Sicurezza PROFESSIONALE e COMPLETO conforme al D.lgs 81/2008.

REGOLA FONDAMENTALE SUI DATI PERSONALI:
- Usa ESCLUSIVAMENTE i dati forniti di seguito. NON inventare MAI dati anagrafici, codici fiscali, numeri di telefono, email, date di nascita, numeri di polizza, numeri di iscrizione ad albi o qualsiasi altro dato personale.
- Se un dato è indicato come "N/A" o mancante, scrivi esattamente [DA COMPILARE] al suo posto.
- Questa regola è INDEROGABILE: è meglio un documento con segnaposti che un documento con dati falsi.

REVISIONE DOCUMENTO: ${revision}

DATI CANTIERE:
Indirizzo: ${posData.siteAddress || 'N/A'}
Committente: ${posData.client || 'N/A'}
Natura lavori: ${posData.workType || 'N/A'}
Importo: €${posData.budget || '0'}
Periodo: ${posData.startDate || 'N/A'} - ${posData.endDate || 'N/A'}
Numero operai max: ${posData.numWorkers || '0'}

IMPRESA ESECUTRICE:
Ragione sociale: ${posData.companyName || 'N/A'}
P.IVA: ${posData.companyVat || 'N/A'}

FIGURE DI SICUREZZA:
Responsabile Lavori: ${posData.responsabileLavori || 'N/A'}
CSP: ${posData.csp || 'N/A'}
CSE: ${posData.cse || 'N/A'}
RSPP: ${posData.rspp || 'N/A'}
RLS: ${posData.rls || 'N/A'}
Medico Competente: ${posData.medico || 'N/A'}
Addetto Primo Soccorso: ${posData.primoSoccorso || 'N/A'}
Addetto Antincendio: ${posData.antincendio || 'N/A'}

LAVORAZIONI PREVISTE:
${posData.selectedWorks?.join('\n') || 'Da definire'}

LAVORATORI:
${posData.workers?.map(w => w.name + ' - ' + w.qualification + ' (matr. ' + w.matricola + ')').join('\n') || 'Da definire'}

GENERA DOCUMENTO COMPLETO (15.000+ parole) CON QUESTE SEZIONI OBBLIGATORIE:

1. INTESTAZIONE con "Piano Operativo di Sicurezza - Revisione ${revision}"
2. DATI GENERALI DEL LAVORO
3. SOGGETTI CON COMPITI DI SICUREZZA
4. AREA DI CANTIERE E ORGANIZZAZIONE
5. LAVORAZIONI - PER OGNUNA:
   - Descrizione tecnica dettagliata
   - TUTTI i rischi identificati con matrice P×D
   - Misure prevenzione specifiche
   - DPI obbligatori con norme UNI EN
   - Attrezzature e verifiche periodiche
6. SEGNALETICA ISO 7010 completa
7. PROCEDURE EMERGENZA con numeri utili
8. DPI - Schede dettagliate
9. MACCHINE - Verifiche obbligatorie
10. SOSTANZE PERICOLOSE
11. GESTIONE RIFIUTI con codici CER
12. FORMAZIONE LAVORATORI
13. SORVEGLIANZA SANITARIA
14. FIRME

SEZIONE FIRME (obbligatoria alla fine del documento):
Genera una sezione "FIRME" finale con spazi firma per:
- Datore di Lavoro dell'impresa esecutrice: Nome _________________ Firma _________________  Data _________________
- RSPP: Nome _________________ Firma _________________  Data _________________
- RLS: Nome _________________ Firma _________________  Data _________________
- Medico Competente: Nome _________________ Firma _________________  Data _________________
- CSE (per presa visione): Nome _________________ Firma _________________  Data _________________

GENERA TUTTO in formato TESTO STRUTTURATO, DETTAGLIATO, PROFESSIONALE.
Minimo 15.000 parole. Massima completezza tecnica e conformità normativa.`;
}

// --- Helper: get next revision number for a site ---
async function getNextRevision(siteId) {
  const { data } = await supabase
    .from('pos_documents')
    .select('revision')
    .eq('site_id', siteId)
    .order('revision', { ascending: false })
    .limit(1);
  return (data && data.length > 0) ? data[0].revision + 1 : 1;
}

// --- Helper: call Anthropic streaming API, return reader ---
async function callAnthropicStream(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured on server');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      stream: true,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const errData = await response.json();
    const err = new Error('Anthropic API error');
    err.status = 502;
    err.details = errData;
    throw err;
  }

  return response;
}

// --- Helper: collect full text from Anthropic stream ---
async function collectStreamText(response) {
  let fullText = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') continue;
        try {
          const event = JSON.parse(jsonStr);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
          }
        } catch (e) { /* skip non-JSON lines */ }
      }
    }
  }

  return fullText;
}

// --- Helper: build prompt for AI risks only (Haiku) ---
function buildRisksPrompt(posData) {
  const works = posData.selectedWorks?.join('\n- ') || 'Da definire';
  return `Sei un Coordinatore per la Sicurezza esperto. Genera SOLO la sezione "Lavorazioni e Rischi" di un POS per le seguenti lavorazioni di cantiere.

CANTIERE: ${posData.siteAddress || 'N/A'}
NATURA LAVORI: ${posData.workType || 'N/A'}

LAVORAZIONI PREVISTE:
- ${works}

Per OGNI lavorazione genera:

### [Nome Lavorazione]

**Descrizione tecnica:** descrizione dettagliata della lavorazione e delle fasi operative.

**Rischi identificati e valutazione (matrice P x D):**

| Rischio | P (1-4) | D (1-4) | R (PxD) | Livello |
|---------|---------|---------|---------|---------|
(elenca tutti i rischi con probabilita', danno, indice di rischio e livello: Basso/Medio/Alto/Molto Alto)

Legenda: P=Probabilita' (1=Improbabile, 2=Poco probabile, 3=Probabile, 4=Molto probabile), D=Danno (1=Lieve, 2=Medio, 3=Grave, 4=Molto grave), R=PxD

**Misure di prevenzione e protezione:**
- (elenco dettagliato misure specifiche)

**DPI obbligatori:**
| DPI | Norma UNI EN | Note |
|-----|-------------|------|
(tabella DPI specifici con norme di riferimento)

**Attrezzature e verifiche:**
| Attrezzatura | Verifica richiesta | Frequenza |
|-------------|-------------------|-----------|
(tabella attrezzature con verifiche)

---

Rispondi SOLO con il contenuto delle lavorazioni, senza intestazioni di sezione o preamboli. Sii tecnico, preciso e conforme al D.lgs 81/2008.`;
}

// --- Helper: call Anthropic Haiku (non-streaming, for template mode) ---
async function callAnthropicHaiku(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured on server');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const errData = await response.json();
    console.error('Anthropic Haiku error:', JSON.stringify(errData));
    const err = new Error('Anthropic API error');
    err.status = 502;
    err.details = errData;
    throw err;
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: __dirname + '/public' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'palladia', ts: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'palladia', ts: new Date().toISOString() });
});

// --- Sites CRUD ---
app.get('/api/sites', async (req, res) => {
  try {
    const { data, error } = await supabase.from('sites').select('*');
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sites', async (req, res) => {
  try {
    const { data, error } = await supabase.from('sites').insert([req.body]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/sites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('sites').update(req.body).eq('id', id).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/sites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('sites').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Site deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- POS Generation (non-streaming, original endpoint) ---
app.post('/api/sites/:id/generate-pos', async (req, res) => {
  try {
    const { id: siteId } = req.params;
    const posData = req.body;

    const revision = await getNextRevision(siteId);
    const megaPrompt = buildPosPrompt(posData, revision);

    const response = await callAnthropicStream(megaPrompt);
    const fullText = await collectStreamText(response);

    // Save to Supabase
    const { data: saved, error: saveError } = await supabase
      .from('pos_documents')
      .insert([{
        site_id: siteId,
        revision,
        content: fullText,
        pos_data: posData,
        created_by: posData.createdBy || null
      }])
      .select()
      .single();

    if (saveError) {
      console.error('Failed to save POS:', saveError.message);
    }

    res.json({
      content: fullText,
      posData,
      revision,
      posId: saved?.id || null
    });

  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message, details: error.details });
  }
});

// --- POS Generation (SSE streaming) ---
app.post('/api/sites/:id/generate-pos-stream', async (req, res) => {
  try {
    const { id: siteId } = req.params;
    const posData = req.body;

    const revision = await getNextRevision(siteId);
    const megaPrompt = buildPosPrompt(posData, revision);

    // Set up SSE headers (Connection: keep-alive omitted — forbidden in HTTP/2)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send revision info as first event
    res.write(`data: ${JSON.stringify({ type: 'meta', revision })}\n\n`);

    const response = await callAnthropicStream(megaPrompt);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') continue;
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              const text = event.delta.text;
              fullText += text;
              res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
            }
          } catch (e) { /* skip non-JSON lines */ }
        }
      }
    }

    // Save to Supabase
    const { data: saved, error: saveError } = await supabase
      .from('pos_documents')
      .insert([{
        site_id: siteId,
        revision,
        content: fullText,
        pos_data: posData,
        created_by: posData.createdBy || null
      }])
      .select()
      .single();

    if (saveError) {
      console.error('Failed to save POS:', saveError.message);
    }

    // Send final event with save info
    res.write(`data: ${JSON.stringify({ type: 'done', posId: saved?.id || null, revision })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    // If headers already sent, send error as SSE event
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } else {
      const status = error.status || 500;
      res.status(status).json({ error: error.message, details: error.details });
    }
  }
});

// --- Standalone POS Generation (SSE streaming, no siteId required) ---
app.post('/api/generate-pos-stream', async (req, res) => {
  try {
    const posData = req.body;
    const siteId = posData.siteId || null;

    let revision = 1;
    if (siteId) {
      revision = await getNextRevision(siteId);
    }

    const megaPrompt = buildPosPrompt(posData, revision);

    // Set up SSE headers (Connection: keep-alive omitted — forbidden in HTTP/2)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'meta', revision })}\n\n`);

    const response = await callAnthropicStream(megaPrompt);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') continue;
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              const text = event.delta.text;
              fullText += text;
              res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
            }
          } catch (e) { /* skip non-JSON lines */ }
        }
      }
    }

    // Save to Supabase (optional - only if siteId provided)
    let posId = null;
    if (siteId) {
      const { data: saved, error: saveError } = await supabase
        .from('pos_documents')
        .insert([{
          site_id: siteId,
          revision,
          content: fullText,
          pos_data: posData,
          created_by: posData.createdBy || null
        }])
        .select()
        .single();

      if (saveError) {
        console.error('Failed to save POS:', saveError.message);
      } else {
        posId = saved?.id || null;
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', posId, revision })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } else {
      const status = error.status || 500;
      res.status(status).json({ error: error.message, details: error.details });
    }
  }
});

// --- PDF Export (direct, from content in request body) — HTML+Puppeteer pipeline ---
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { content, siteName, revision, posData } = req.body;
    if (!posData) {
      return res.status(400).json({ error: 'posData is required' });
    }

    const rev      = revision || 1;
    const name     = siteName || posData.siteAddress || 'Cantiere';
    const fileName = `POS-Rev${rev}-${name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const docTitle = `POS – ${name} – Rev. ${rev}`;

    const signs     = selectSigns(posData);
    const html      = await generatePosHtml(posData, rev, content || '', signs);
    const pdfBuffer = await rendererPool.render(html, { docTitle, revision: rev });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('PDF generation error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// --- POS Documents: list by site ---
app.get('/api/sites/:id/pos', async (req, res) => {
  try {
    const { id: siteId } = req.params;
    const { data, error } = await supabase
      .from('pos_documents')
      .select('id, site_id, revision, created_at, created_by')
      .eq('site_id', siteId)
      .order('revision', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- POS Documents: get single ---
app.get('/api/pos/:posId', async (req, res) => {
  try {
    const { posId } = req.params;
    const { data, error } = await supabase
      .from('pos_documents')
      .select('*')
      .eq('id', posId)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PDF Export da posId — HTML+Puppeteer pipeline ---
app.get('/api/pos/:posId/pdf', async (req, res) => {
  try {
    const { posId } = req.params;
    const { data: pos, error } = await supabase
      .from('pos_documents')
      .select('*')
      .eq('id', posId)
      .single();
    if (error) throw error;
    if (!pos) return res.status(404).json({ error: 'POS not found' });

    let siteName = 'Cantiere';
    if (pos.site_id) {
      const { data: site } = await supabase
        .from('sites')
        .select('name, site_name, address')
        .eq('id', pos.site_id)
        .single();
      if (site) siteName = site.site_name || site.name || site.address || 'Cantiere';
    }

    const signs     = selectSigns(pos.pos_data || {});
    const html      = await generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', signs);
    const docTitle  = `POS – ${siteName} – Rev. ${pos.revision}`;
    const fileName  = `POS-Rev${pos.revision}-${siteName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const pdfBuffer = await rendererPool.render(html, { docTitle, revision: pos.revision });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('PDF generation error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// --- POS Template Generation (non-streaming, hybrid mode) ---
app.post('/api/generate-pos-template', async (req, res) => {
  try {
    const posData = req.body;
    const siteId = posData.siteId || null;

    let revision = 1;
    if (siteId) {
      revision = await getNextRevision(siteId);
    }

    // Step 1: Generate only the risks section with Haiku
    const risksPrompt = buildRisksPrompt(posData);
    const aiRisks = await callAnthropicHaiku(risksPrompt);

    // Step 2: Assemble the full document with template + AI risks
    const signs = selectSigns(posData);
    const fullText = buildPosDocument(posData, revision, aiRisks, signs);

    // Step 3: Save to Supabase
    let posId = null;
    if (siteId) {
      const { data: saved, error: saveError } = await supabase
        .from('pos_documents')
        .insert([{
          site_id: siteId,
          revision,
          content: fullText,
          pos_data: posData,
          created_by: posData.createdBy || null
        }])
        .select()
        .single();

      if (saveError) {
        console.error('Failed to save POS:', saveError.message);
      } else {
        posId = saved?.id || null;
      }
    }

    res.json({
      content: fullText,
      posData,
      revision,
      posId,
      mode: 'template'
    });

  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message, details: error.details });
  }
});

// Helper: safe SSE write — never throws, logs failures
function sseWrite(res, data) {
  try {
    if (!res.writableEnded) res.write(data);
  } catch (e) {
    console.error('[SSE write error]', e.message);
  }
}

// --- POS Template Generation (SSE streaming for progress feedback) ---
app.post('/api/generate-pos-template-stream', async (req, res) => {
  console.log('[template-stream] request received');

  // Attach error handlers to socket/res so write errors don't crash the process
  res.on('error', (e) => console.error('[template-stream] res error:', e.message));
  if (req.socket) {
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    req.socket.on('error', (e) => console.error('[template-stream] socket error:', e.message));
  }

  let headersFlused = false;
  let heartbeatTimer = null;

  // Outer try/catch: also catches any error thrown inside the inner catch block
  // (Express 5 re-throws catch-block errors onto the async chain — we block that here)
  try {
    const posData = req.body;
    const siteId = posData.siteId || null;

    let revision = 1;
    if (siteId) {
      revision = await getNextRevision(siteId);
    }
    console.log('[template-stream] revision', revision);

    // Set up SSE headers (Connection: keep-alive omitted — forbidden in HTTP/2)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    headersFlused = true;
    console.log('[template-stream] headers flushed');

    sseWrite(res, `data: ${JSON.stringify({ type: 'meta', revision, mode: 'template' })}\n\n`);
    sseWrite(res, `data: ${JSON.stringify({ type: 'status', message: 'Generazione rischi specifici con AI...' })}\n\n`);

    // Heartbeat every 10s to keep Railway proxy alive
    heartbeatTimer = setInterval(() => sseWrite(res, ': keepalive\n\n'), 10000);

    console.log('[template-stream] calling Haiku...');
    let aiRisks = '';
    try {
      const risksPrompt = buildRisksPrompt(posData);
      aiRisks = await callAnthropicHaiku(risksPrompt);
      console.log('[template-stream] Haiku done, length:', aiRisks.length);
    } catch (aiErr) {
      console.error('[template-stream] Haiku error:', aiErr.message);
      // Continue with empty risks rather than aborting the stream
      aiRisks = '[Sezione rischi non disponibile — errore AI]';
    }

    clearInterval(heartbeatTimer);
    heartbeatTimer = null;

    // Emit AI risks content separately so the frontend can make it editable
    sseWrite(res, `data: ${JSON.stringify({ type: 'risks', text: aiRisks })}\n\n`);

    sseWrite(res, `data: ${JSON.stringify({ type: 'status', message: 'Assemblaggio documento completo...' })}\n\n`);

    const signs = selectSigns(posData);
    const fullText = buildPosDocument(posData, revision, aiRisks, signs);
    console.log('[template-stream] document built, length:', fullText.length);

    // Send document in chunks to avoid HTTP/2 frame size issues
    const CHUNK_SIZE = 512;
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      sseWrite(res, `data: ${JSON.stringify({ type: 'text', text: fullText.slice(i, i + CHUNK_SIZE) })}\n\n`);
    }
    console.log('[template-stream] chunks sent');

    // Save to Supabase
    let posId = null;
    if (siteId) {
      try {
        const { data: saved, error: saveError } = await supabase
          .from('pos_documents')
          .insert([{
            site_id: siteId,
            revision,
            content: fullText,
            pos_data: posData,
            created_by: posData.createdBy || null
          }])
          .select()
          .single();

        if (saveError) {
          console.error('[template-stream] Supabase save error:', saveError.message);
        } else {
          posId = saved?.id || null;
          console.log('[template-stream] saved posId:', posId);
        }
      } catch (dbErr) {
        console.error('[template-stream] Supabase exception:', dbErr.message);
      }
    }

    sseWrite(res, `data: ${JSON.stringify({ type: 'done', posId, revision, mode: 'template' })}\n\n`);
    sseWrite(res, 'data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
    console.log('[template-stream] complete');

  } catch (error) {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    console.error('[template-stream] fatal error:', error.message);
    try {
      if (headersFlused) {
        sseWrite(res, `data: ${JSON.stringify({ type: 'error', error: String(error.message) })}\n\n`);
        if (!res.writableEnded) res.end();
      } else {
        const status = error.status || 500;
        res.status(status).json({ error: String(error.message) });
      }
    } catch (innerErr) {
      console.error('[template-stream] error handler threw:', innerErr.message);
    }
  }
});

// ── PDF HTML v2: da body (content già pronto) ─────────────────────────────────
// Equivalente di /api/generate-pdf ma usa il nuovo pipeline HTML+Puppeteer.
app.post('/api/generate-pdf-html', async (req, res) => {
  try {
    const { content, siteName, revision, posData } = req.body;
    if (!posData) return res.status(400).json({ error: 'posData is required' });

    const signs    = selectSigns(posData);
    const html     = await generatePosHtml(posData, revision || 1, content || '', signs);
    const docTitle = `POS – ${siteName || posData.siteAddress || 'Cantiere'} – Rev. ${revision || 1}`;
    const fileName = `POS-Rev${revision || 1}-${(siteName || 'Cantiere').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

    const pdfBuffer = await rendererPool.render(html, { docTitle, revision: revision || 1 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('generate-pdf-html error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ── PDF HTML v2: da posId salvato su Supabase ─────────────────────────────────
app.get('/api/pos/:posId/pdf-html', async (req, res) => {
  try {
    const { posId } = req.params;
    const { data: pos, error } = await supabase
      .from('pos_documents')
      .select('*')
      .eq('id', posId)
      .single();
    if (error) throw error;
    if (!pos) return res.status(404).json({ error: 'POS not found' });

    let siteName = 'Cantiere';
    if (pos.site_id) {
      const { data: site } = await supabase
        .from('sites')
        .select('name, site_name, address')
        .eq('id', pos.site_id)
        .single();
      if (site) siteName = site.site_name || site.name || site.address || 'Cantiere';
    }

    const signs    = selectSigns(pos.pos_data || {});
    const html     = await generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', signs);
    const docTitle = `POS – ${siteName} – Rev. ${pos.revision}`;
    const fileName = `POS-Rev${pos.revision}-${siteName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

    const pdfBuffer = await rendererPool.render(html, { docTitle, revision: pos.revision });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('pdf-html error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ── PDF HTML v2: genera HTML (debug/preview) ──────────────────────────────────
app.post('/api/generate-pos-html', async (req, res) => {
  try {
    const posData  = req.body;
    const revision = posData.revision || 1;
    const signs    = selectSigns(posData);
    const html     = await generatePosHtml(posData, revision, posData.content || '', signs);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('generate-pos-html error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── HTML Preview: renderizza POS come HTML navigabile (per iframe frontend) ────
app.get('/api/pos/:posId/html', async (req, res) => {
  try {
    const { posId } = req.params;
    const { data: pos, error } = await supabase
      .from('pos_documents')
      .select('*')
      .eq('id', posId)
      .single();
    if (error) throw error;
    if (!pos) return res.status(404).json({ error: 'POS not found' });

    const signs = selectSigns(pos.pos_data || {});
    const html  = await generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', signs);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send(html);
  } catch (error) {
    console.error('pos-html preview error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ── PING ─────────────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    build: `BUILD_${Date.now()}`,
    routes: ['/api/ping', '/api/pdf-diag']
  });
});

// ── DIAGNOSTICA PDF ─────────────────────────────────────────────────────────
// GET /api/pdf-diag?step=1  → Puppeteer margin 18/16mm, displayHeaderFooter:false
// GET /api/pdf-diag?step=2  → Puppeteer margin 0, body padding 18/16mm, displayHeaderFooter:false

function buildDiagHtml(step) {
  const ts = new Date().toISOString();
  const buildLabel = `BUILD_${Date.now()}`;

  // CSS varia per step
  const pageCss = '@page { size:A4; margin:0; }';
  const bodyCss = step === 2
    ? 'margin:0; padding:18mm 16mm; box-sizing:border-box;'
    : 'margin:0; padding:0;';

  // Safe-area dashed (sempre visibile in entrambi gli step)
  const safeArea = `<div style="position:fixed;top:18mm;left:16mm;right:16mm;bottom:18mm;outline:2px dashed #e00;pointer-events:none;z-index:9998;"></div>`;

  // BUILD watermark in basso a destra (dentro pagina, non H/F)
  const buildWatermark = `<div style="position:fixed;bottom:6mm;right:8mm;font-size:7pt;color:#555;font-family:monospace;z-index:9999;">${buildLabel}</div>`;

  const rows = Array.from({length: 30}, (_, i) =>
    `<tr><td>${i+1}</td><td>Contenuto colonna A — riga ${i+1}</td><td>${i*7+3}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>DIAG STEP=${step}</title>
  <style>
    ${pageCss}
    html, body { ${bodyCss} font-family: Arial, sans-serif; font-size:10pt; color:#111; background:#fff; }
    h1 { font-size:18pt; margin:0 0 6pt 0; color:#c00; }
    h2 { font-size:12pt; margin:16pt 0 4pt 0; color:#333; page-break-after:avoid; }
    p  { margin:0 0 5pt 0; line-height:1.5; }
    table { width:100%; border-collapse:collapse; margin:8pt 0; font-size:9pt; }
    th { background:#222; color:#fff; padding:4pt 7pt; text-align:left; }
    td { padding:3pt 7pt; border:0.5pt solid #ccc; }
    tr:nth-child(even) td { background:#f5f5f5; }
    tr { break-inside:avoid; }
    thead { display:table-header-group; }
    .info { background:#fff8e1; border-left:3pt solid #f90; padding:6pt 10pt; margin:8pt 0; font-size:9pt; }
  </style>
</head>
<body>
  ${safeArea}
  ${buildWatermark}

  <h1>DIAG STEP=${step}</h1>
  <div class="info">
    <strong>Timestamp:</strong> ${ts}<br>
    <strong>Step:</strong> ${step}<br>
    <strong>Config:</strong> ${step === 1
      ? 'Puppeteer margin top/bottom:18mm left/right:16mm — displayHeaderFooter:false'
      : 'Puppeteer margin 0 — body padding:18mm 16mm — displayHeaderFooter:false'}
  </div>

  <h2>Testo di prova</h2>
  <p>Il bordo rosso tratteggiato rappresenta la safe area (18mm top/bottom, 16mm left/right). Il contenuto NON deve uscire da quel bordo.</p>
  <p>Se questo testo è visibile con margini su tutti e quattro i lati, la configurazione funziona correttamente per lo step ${step}.</p>

  <h2>Tabella 30 righe</h2>
  <table>
    <thead><tr><th style="width:10%">N.</th><th style="width:65%">Descrizione</th><th>Valore</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Fine documento</h2>
  <p>Documento completo. In basso a destra (dentro la pagina, non in header/footer) è visibile il ${buildLabel}.</p>
</body>
</html>`;
}

app.get('/api/pdf-diag', async (req, res) => {
  const step = parseInt(req.query.step) || 1;
  console.log(`[pdf-diag] step=${step}`);

  const puppeteerOpts = {
    format:              'A4',
    printBackground:     true,
    preferCSSPageSize:   true,
    displayHeaderFooter: false,
    headerTemplate:      '<span></span>',
    footerTemplate:      '<span></span>',
    margin: step === 2
      ? { top: '0', bottom: '0', left: '0', right: '0' }
      : { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' }
  };

  try {
    const puppeteer = require('puppeteer');
    const html = buildDiagHtml(step);
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote']
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 794, height: 1123 });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluateHandle('document.fonts.ready');
      const pdfBuffer = await page.pdf(puppeteerOpts);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="diag-step${step}.pdf"`);
      res.send(pdfBuffer);
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error('[pdf-diag] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SMOKE TEST PDF ────────────────────────────────────────────────────────────
// GET /api/pdf-smoke
// Genera un PDF di test con:
//   - tabella lunga 30 righe
//   - tabella con stringhe lunghissime
//   - contenuto sufficiente per testare salti pagina e numerazione 2-pass
// Usa il template POS reale — nessun endpoint separato di layout.
app.get('/api/pdf-smoke', async (req, res) => {
  try {
    // Worker con nomi lunghi → testano overflow laterale e tabelle spezzate
    const workers = Array.from({ length: 30 }, (_, i) => ({
      name:          `Lavoratore Test ${String(i + 1).padStart(2, '0')} — Cognome Molto Lungo Per Overflow`,
      qualification: `Qualifica Specifica Settore ${i % 4 === 0 ? 'Elettrico' : i % 4 === 1 ? 'Meccanico' : i % 4 === 2 ? 'Edile' : 'Chimico'} Cat. ${i + 1}`,
      matricola:     `MAT${String(i + 1).padStart(6, '0')}`,
    }));

    const smokeData = {
      companyName:        'Impresa Test Smoke SRL — Denominazione Molto Lunga Per Testare Overflow',
      companyVat:         '12345678901',
      siteAddress:        'Via del Collaudo PDF Automatico 123, 20123 Milano (MI) — Indirizzo Lungo',
      client:             'Cliente Committente Test SpA con ragione sociale estesa',
      workType:           'Demolizione, bonifica e ricostruzione di edificio residenziale pluripiano con lavorazioni complesse',
      budget:             '1500000',
      startDate:          '01/03/2026',
      endDate:            '31/12/2027',
      numWorkers:         30,
      rspp:               'Ing. Mario Rossi — Responsabile SPP con qualifica lunga',
      rls:                'Sig. Paolo Verdi',
      medico:             'Dott. Luigi Bianchi — Medico Competente',
      cse:                'Arch. Anna Neri — Coordinatore per la Sicurezza in fase di Esecuzione',
      csp:                'Ing. Marco Gialli',
      responsabileLavori: 'Sig. Giuseppe Rossi',
      primoSoccorso:      'Sig. Antonio Verde',
      antincendio:        'Sig. Francesco Blu',
      preposto:           'Sig. Carlo Arancio',
      direttoreTecnico:   'Ing. Laura Viola',
      workers,
    };

    // Contenuto AI simulato: testo lungo per forzare più pagine e break-inside
    const smokeRisks = `
### [Demolizione strutturale]
**Descrizione:** Attività di demolizione manuale e meccanica di strutture in cemento armato.

**Rischi:**
- Caduta di materiali dall'alto
- Crollo parziale di strutture
- Proiezione di schegge

**Misure preventive:**
- Puntellamento preventivo delle strutture adiacenti
- Utilizzo di DPI categoria III: imbracature, elmetti, guanti antitaglio, occhiali
- Perimetrazione dell'area con rete di sicurezza h=2m

| Rischio | Probabilità | Magnitudo | Livello | R (P×M) |
|---------|-------------|-----------|---------|---------|
| Caduta dall'alto | Alta | Grave | Alto | 12 |
| Schegge | Media | Moderata | Medio | 6 |
| Crollo | Bassa | Gravissima | Alto | 8 |
| Rumore | Alta | Lieve | Basso | 3 |
| Polveri | Alta | Moderata | Medio | 6 |

### [Scavo e movimentazione terra]
**Descrizione:** Scavi a sezione obbligata per fondazioni profonde oltre 1.5m.

**Rischi principali:**
- Franamento delle pareti di scavo
- Investimento da mezzi meccanici
- Presenza di sottoservizi interrati

**Misure preventive:**
- Armature metalliche per pareti di scavo oltre 1.5m
- Segnalazione e segregazione dell'area di lavoro dei mezzi
- Ricerca preventiva sottoservizi (gas, elettricità, acqua)

| Rischio | Probabilità | Magnitudo | Livello | R (P×M) |
|---------|-------------|-----------|---------|---------|
| Franamento | Media | Gravissima | Alto | 12 |
| Investimento | Bassa | Grave | Medio | 6 |
| Gas interrato | Bassa | Gravissima | Alto | 8 |

### [Opere in quota — Ponteggi]
**Descrizione:** Montaggio e utilizzo di ponteggi metallici fissi per lavori in facciata oltre 4m di altezza.

**Rischi:**
- Caduta dall'alto degli operatori
- Caduta di materiali e attrezzature
- Cedimento del ponteggio

**Misure preventive:**
- PIMUS redatto da tecnico abilitato
- Formazione specifica 28h per montaggio/smontaggio (Acc. Stato-Regioni 26/01/2006)
- Ancoraggi ogni 18m² di superficie
- Tavole fermapiede e parapetti a norma UNI EN 12811

| Rischio | Probabilità | Magnitudo | Livello | R (P×M) |
|---------|-------------|-----------|---------|---------|
| Caduta operatori | Media | Gravissima | Molto Alto | 16 |
| Caduta materiali | Alta | Grave | Alto | 12 |
| Cedimento | Bassa | Gravissima | Alto | 8 |
`.trim();

    const html = await generatePosHtml(smokeData, 1, smokeRisks, []);
    const pdfBuf = await rendererPool.render(html);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="smoke-test.pdf"');
    res.send(pdfBuf);
    console.log('[pdf-smoke] OK — PDF generato, size:', pdfBuf.length, 'bytes');
  } catch (err) {
    console.error('[pdf-smoke] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── App-level error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[app-error]', req.method, req.path, err.message);
  // Invia a Sentry solo errori 5xx non previsti (non errori client 4xx)
  if (!err.status || err.status >= 500) {
    Sentry.captureException(err, { extra: { method: req.method, path: req.path } });
    errorBuffer.push(err, req);
  }
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: 'APP_ERROR', detail: err.message });
  }
});

// Ensure Supabase Storage bucket exists (best-effort, non-blocking)
const supabaseAdmin = require('./lib/supabase');
supabaseAdmin.storage.createBucket('site-documents', {
  public: false,
  fileSizeLimit: 10485760, // 10 MB
  allowedMimeTypes: ['application/pdf','image/jpeg','image/png','image/webp','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
}).then(({ error }) => {
  if (error && error.message && error.message.toLowerCase().includes('already exists')) {
    console.log('[storage] Bucket site-documents: already exists ✓');
  } else if (error) {
    console.warn('[storage] Bucket creation warning:', error.message);
  } else {
    console.log('[storage] Bucket site-documents: created ✓');
  }
}).catch((e) => console.warn('[storage] Bucket init error:', e.message));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('ROUTES OK: /api/ping, /api/health, /api/pdf-diag, /api/pdf-smoke');

  // Avvia cron — solo in produzione o se esplicitamente abilitato
  if (process.env.NODE_ENV !== 'test') {
    startMissingExitCron();
    startDailySummaryCron();
    startEveningSummaryCron();
    startExpiryAlertCron();
    startWorkerExpiryCron();
    startLadiaProactiveCron();
  }
});

// ── Graceful shutdown (SIGTERM) ───────────────────────────────────────────────
// Railway invia SIGTERM prima di ogni deploy o restart.
// Chiudiamo il server HTTP (no nuove connessioni) e attendiamo le richieste in corso.
// Puppeteer viene chiuso dopo per liberare la memoria di Chromium.
process.on('SIGTERM', () => {
  console.log('[SIGTERM] ricevuto — avvio graceful shutdown...');

  server.close(async () => {
    console.log('[SIGTERM] server HTTP chiuso — cleanup...');
    try { await rendererPool.close(); } catch { /* ignore */ }
    console.log('[SIGTERM] Puppeteer chiuso — processo terminato.');
    process.exit(0);
  });

  // Se non riusciamo a chiudere entro 30s, forziamo l'uscita
  setTimeout(() => {
    console.error('[SIGTERM] force exit — timeout 30s superato');
    process.exit(1);
  }, 30000);
});
