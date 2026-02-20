require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { generatePdf } = require('./pdf-generator');
const { buildPosDocument } = require('./pos-template');
const { selectSigns } = require('./sign-selector');
const { generatePosHtml } = require('./pos-html-generator');
const { rendererPool } = require('./pdf-renderer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['https://palladia-kappa.vercel.app', 'https://palladia-site-master.lovable.app', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json({ limit: '10mb' }));

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
  res.json({ message: 'Palladia Backend API is running!' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    const html      = generatePosHtml(posData, rev, content || '', signs);
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
    const html      = generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', signs);
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

// --- POS Template Generation (SSE streaming for progress feedback) ---
app.post('/api/generate-pos-template-stream', async (req, res) => {
  try {
    const posData = req.body;
    const siteId = posData.siteId || null;

    let revision = 1;
    if (siteId) {
      revision = await getNextRevision(siteId);
    }

    // Set up SSE headers (Connection: keep-alive omitted — forbidden in HTTP/2)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send meta info
    res.write(`data: ${JSON.stringify({ type: 'meta', revision, mode: 'template' })}\n\n`);

    // Step 1: Notify client that AI is generating risks
    res.write(`data: ${JSON.stringify({ type: 'status', message: 'Generazione rischi specifici con AI...' })}\n\n`);

    // Heartbeat every 15s to prevent Railway HTTP/2 proxy idle-timeout
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch (_) {}
    }, 15000);

    let aiRisks;
    try {
      const risksPrompt = buildRisksPrompt(posData);
      aiRisks = await callAnthropicHaiku(risksPrompt);
    } finally {
      clearInterval(heartbeat);
    }

    // Step 2: Notify client that template is being assembled
    res.write(`data: ${JSON.stringify({ type: 'status', message: 'Assemblaggio documento completo...' })}\n\n`);

    const signs = selectSigns(posData);
    const fullText = buildPosDocument(posData, revision, aiRisks, signs);

    // Send document in chunks to avoid HTTP/2 frame size limits (Railway proxy)
    const CHUNK_SIZE = 512;
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      res.write(`data: ${JSON.stringify({ type: 'text', text: fullText.slice(i, i + CHUNK_SIZE) })}\n\n`);
    }

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

    res.write(`data: ${JSON.stringify({ type: 'done', posId, revision, mode: 'template' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('generate-pos-template-stream error:', error.message, JSON.stringify(error.details));
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message, details: error.details })}\n\n`);
      res.end();
    } else {
      const status = error.status || 500;
      res.status(status).json({ error: error.message, details: error.details });
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
    const html     = generatePosHtml(posData, revision || 1, content || '', signs);
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
    const html     = generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', signs);
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
    const html     = generatePosHtml(posData, revision, posData.content || '', signs);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('generate-pos-html error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
