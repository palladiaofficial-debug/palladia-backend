require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { generatePdf } = require('./pdf-generator');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['https://palladia-kappa.vercel.app', 'https://palladia-site-master.lovable.app', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());

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
      model: 'claude-sonnet-4-5-20250929',
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

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
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

// --- PDF Export ---
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

    // Fetch site name for header
    let siteName = 'Cantiere';
    if (pos.site_id) {
      const { data: site } = await supabase
        .from('sites')
        .select('name, site_name, address')
        .eq('id', pos.site_id)
        .single();
      if (site) {
        siteName = site.site_name || site.name || site.address || 'Cantiere';
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="POS-Rev${pos.revision}-${siteName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`);

    const pdfStream = generatePdf(pos.content, {
      siteName,
      revision: pos.revision,
      posData: pos.pos_data
    });

    pdfStream.pipe(res);
    pdfStream.end();

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
