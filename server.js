require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

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

app.get('/', (req, res) => {
  res.json({ message: 'Palladia Backend API is running!' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

app.post('/api/sites/:id/generate-pos', async (req, res) => {
  try {
    const posData = req.body;
    
    const megaPrompt = `Sei il miglior Coordinatore per la Sicurezza in Italia con 30 anni di esperienza. Genera un Piano Operativo di Sicurezza PROFESSIONALE e COMPLETO conforme al D.lgs 81/2008.

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

1. DATI GENERALI DEL LAVORO
2. SOGGETTI CON COMPITI DI SICUREZZA
3. AREA DI CANTIERE E ORGANIZZAZIONE
4. LAVORAZIONI - PER OGNUNA:
   - Descrizione tecnica dettagliata
   - TUTTI i rischi identificati con matrice P×D
   - Misure prevenzione specifiche
   - DPI obbligatori con norme UNI EN
   - Attrezzature e verifiche periodiche
5. SEGNALETICA ISO 7010 completa
6. PROCEDURE EMERGENZA con numeri utili
7. DPI - Schede dettagliate
8. MACCHINE - Verifiche obbligatorie
9. SOSTANZE PERICOLOSE
10. GESTIONE RIFIUTI con codici CER
11. FORMAZIONE LAVORATORI
12. SORVEGLIANZA SANITARIA

GENERA TUTTO in formato TESTO STRUTTURATO, DETTAGLIATO, PROFESSIONALE.
Minimo 15.000 parole. Massima completezza tecnica e conformità normativa.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 16000,
        messages: [{ role: 'user', content: megaPrompt }]
      })
    });
    
    const data = await response.json();
    res.json({ content: data.content[0].text, posData });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});