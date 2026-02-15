require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// GET - Test
app.get('/', (req, res) => {
  res.json({ message: 'Palladia Backend API is running!' });
});

// GET - Lista cantieri
app.get('/api/sites', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sites')
      .select('*');
    
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Crea cantiere
app.post('/api/sites', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sites')
      .insert([req.body])
      .select();
    
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT - Aggiorna cantiere
app.put('/api/sites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('sites')
      .update(req.body)
      .eq('id', id)
      .select();
    
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE - Elimina cantiere
app.delete('/api/sites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('sites')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ message: 'Site deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Genera POS con AI
app.post('/api/sites/:id/generate-pos', async (req, res) => {
  try {
    const { id } = req.params;
    const posData = req.body;
    
    const prompt = `Genera Piano Operativo di Sicurezza conforme D.lgs 81/2008:

CANTIERE: ${posData.siteAddress || 'N/A'}
COMMITTENTE: ${posData.client || 'N/A'}
LAVORI: ${posData.workType || 'N/A'}
IMPORTO: €${posData.budget || '0'}
OPERAI: ${posData.numWorkers || '0'}
DATE: ${posData.startDate || 'N/A'} - ${posData.endDate || 'N/A'}

IMPRESA: ${posData.companyName || 'N/A'} (P.IVA ${posData.companyVat || 'N/A'})

FIGURE SICUREZZA:
- Responsabile Lavori: ${posData.responsabileLavori || 'N/A'}
- CSP: ${posData.csp || 'N/A'}
- CSE: ${posData.cse || 'N/A'}
- RSPP: ${posData.rspp || 'N/A'}
- RLS: ${posData.rls || 'N/A'}
- Medico Competente: ${posData.medico || 'N/A'}
- Primo Soccorso: ${posData.primoSoccorso || 'N/A'}
- Antincendio: ${posData.antincendio || 'N/A'}

LAVORAZIONI PREVISTE:
${posData.selectedWorks?.join(', ') || 'Da definire'}

LAVORATORI:
${posData.workers?.map(w => `- ${w.name} (${w.qualification})`).join('\n') || 'Da definire'}

Genera documento professionale completo con: rischi specifici per ogni lavorazione, DPI obbligatori, misure di prevenzione, procedure di emergenza, segnaletica di sicurezza.`;
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    
    const data = await response.json();
    res.json({ content: data.content[0].text, posData });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Avvia il server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});