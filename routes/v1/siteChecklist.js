'use strict';
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const Anthropic = require('@anthropic-ai/sdk');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── AI generation ─────────────────────────────────────────────────────────────

async function callAiChecklist(posData) {
  const works  = (posData.selectedWorks || []).slice(0, 8).join(', ') || 'Lavorazioni edili generali';
  const numW   = posData.numWorkers || '?';
  const period = posData.startDate && posData.endDate
    ? `${posData.startDate} → ${posData.endDate}`
    : posData.startDate || 'Non specificata';

  const prompt = `Sei un coordinatore per la sicurezza (CSE) esperto in cantieri italiani.
Analizza queste lavorazioni e genera una checklist di preparazione cantiere.

Lavorazioni: ${works}
Numero lavoratori: ${numW}
Periodo: ${period}
Importo lavori: ${posData.budget || 'N.D.'}

Genera un array JSON di voci di checklist pratiche per questo cantiere.
Ogni voce deve avere questo formato esatto:
{
  "category": "logistica" | "burocrazia" | "sicurezza" | "ambiente",
  "title": "Titolo breve e pratico (max 55 caratteri)",
  "description": "Cosa fare concretamente (max 130 caratteri)",
  "priority": "high" | "normal"
}

Includi SEMPRE queste voci con priority "high":
- WC chimico (logistica)
- Baracca/spogliatoio di cantiere (logistica)
- Cartello di cantiere con dati impresa e CSE (burocrazia)
- Notifica preliminare INAIL/ASL — art. 99 D.Lgs 81/2008 (burocrazia)
- POS stampato e affisso in cantiere (sicurezza)
- DPI completi disponibili per tutti i lavoratori (sicurezza)
- Estintore e cassetta primo soccorso (sicurezza)

Aggiungi solo le voci pertinenti alle lavorazioni specifiche (es: analisi chimica terreno per scavi profondi, piano di demolizione per demolizioni, verifica amianto per edifici pre-1992, gestione terre e rocce, codici CER rifiuti, autorizzazione occupazione suolo pubblico, ecc).
Non aggiungere voci generiche non pertinenti.
Rispondi SOLO con il JSON array valido, nessun testo aggiuntivo. Max 15 voci totali.`;

  const resp = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = resp.content[0]?.text || '[]';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI non ha restituito JSON valido');
  return JSON.parse(match[0]);
}

// ── Funzione esportata per auto-trigger da server.js ─────────────────────────

async function generateAndSave(siteId, companyId, posId, posData) {
  // Se esiste già una checklist per questo cantiere, non sovrascrivere
  const { count } = await supabase
    .from('site_setup_checklist')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', siteId);

  if (count > 0) return; // già presente — rispetta il lavoro dell'utente

  const items = await callAiChecklist(posData);
  if (!items.length) return;

  const rows = items.map((item, i) => ({
    site_id:     siteId,
    company_id:  companyId,
    pos_id:      posId || null,
    category:    ['logistica', 'burocrazia', 'sicurezza', 'ambiente'].includes(item.category)
                   ? item.category : 'logistica',
    title:       String(item.title || '').slice(0, 100),
    description: item.description ? String(item.description).slice(0, 200) : null,
    priority:    item.priority === 'high' ? 'high' : 'normal',
    sort_order:  i,
  }));

  await supabase.from('site_setup_checklist').insert(rows);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/v1/sites/:siteId/setup-checklist
router.get('/sites/:siteId/setup-checklist', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(403).json({ error: 'Accesso negato' });

  const { data, error } = await supabase
    .from('site_setup_checklist')
    .select('id, category, title, description, priority, done, done_at, sort_order')
    .eq('site_id', siteId)
    .order('priority', { ascending: true }) // 'high' < 'normal' alfabeticamente → high prima
    .order('sort_order');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/v1/sites/:siteId/setup-checklist/generate
// force=true rigenera cancellando gli item non ancora completati
router.post('/sites/:siteId/setup-checklist/generate', verifySupabaseJwt, async (req, res) => {
  const { siteId }  = req.params;
  const { posData, posId, force } = req.body || {};

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(403).json({ error: 'Accesso negato' });

  if (!force) {
    const { count } = await supabase
      .from('site_setup_checklist').select('id', { count: 'exact', head: true }).eq('site_id', siteId);
    if (count > 0) return res.json({ skipped: true });
  }

  try {
    const items = await callAiChecklist(posData || {});
    if (!items.length) return res.status(500).json({ error: 'Nessun elemento generato' });

    const insertTs = new Date().toISOString();
    const rows = items.map((item, i) => ({
      site_id:     siteId,
      company_id:  req.companyId,
      pos_id:      posId || null,
      category:    ['logistica', 'burocrazia', 'sicurezza', 'ambiente'].includes(item.category)
                     ? item.category : 'logistica',
      title:       String(item.title || '').slice(0, 100),
      description: item.description ? String(item.description).slice(0, 200) : null,
      priority:    item.priority === 'high' ? 'high' : 'normal',
      sort_order:  i,
    }));

    // Insert nuovi item PRIMA di cancellare i vecchi:
    // se insert fallisce, i vecchi item done=false sono ancora intatti.
    const { error: insErr } = await supabase.from('site_setup_checklist').insert(rows);
    if (insErr) return res.status(500).json({ error: insErr.message });

    // Solo ora, a insert riuscito, rimuove i vecchi item done=false
    if (force) {
      await supabase.from('site_setup_checklist').delete()
        .eq('site_id', siteId)
        .eq('done', false)
        .lt('created_at', insertTs);
    }

    const { data: result } = await supabase
      .from('site_setup_checklist')
      .select('id, category, title, description, priority, done, done_at, sort_order')
      .eq('site_id', siteId)
      .order('priority', { ascending: true })
      .order('sort_order');

    res.json(result || []);
  } catch (e) {
    console.error('[setup-checklist] generate error:', e.message);
    res.status(500).json({ error: 'Errore AI: ' + e.message });
  }
});

// PATCH /api/v1/sites/:siteId/setup-checklist/:itemId
router.patch('/sites/:siteId/setup-checklist/:itemId', verifySupabaseJwt, async (req, res) => {
  const { siteId, itemId } = req.params;
  const { done } = req.body;

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(403).json({ error: 'Accesso negato' });

  const { data, error } = await supabase
    .from('site_setup_checklist')
    .update({ done: !!done, done_at: done ? new Date().toISOString() : null })
    .eq('id', itemId)
    .eq('site_id', siteId)
    .select('id, done, done_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
module.exports.generateAndSave = generateAndSave;
