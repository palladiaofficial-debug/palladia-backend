const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Inizializza Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Middleware
app.use(cors());
app.use(express.json());

// Route di test
app.get('/', (req, res) => {
  res.json({ message: 'Palladia Backend API is running!' });
});

// GET - Ottieni tutti gli esercizi
app.get('/api/sites', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sites')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Crea un nuovo esercizio
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

// PUT - Aggiorna un esercizio
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

// DELETE - Elimina un esercizio
app.delete('/api/sites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('sites')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Exercise deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Avvia il server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});