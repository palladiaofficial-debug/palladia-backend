'use strict';
/**
 * routes/v1/certificateOcr.js
 * OCR intelligente attestati con Claude Vision.
 *
 * POST /api/v1/workers/:workerId/certificates/upload   — upload file → Supabase Storage → URL
 * POST /api/v1/workers/:workerId/certificates/extract  — OCR via Claude Vision → campi pre-compilati
 */

const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const multer    = require('multer');
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { extractCertificateSchema } = require('../../lib/schemas/certificateOcr');
const { aiLimiter } = require('../../middleware/rateLimit');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

let _anthropic = null;
function getAI() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const OCR_PROMPT = `Sei un sistema di lettura documenti per attestati di formazione sulla sicurezza sul lavoro italiani (D.Lgs 81/08).

Analizza il documento e restituisci SOLO un oggetto JSON con questa struttura esatta, nessun testo aggiuntivo:

{
  "worker_name": "nome e cognome completo",
  "worker_cf": "codice fiscale se presente, altrimenti null",
  "course_name": "nome del corso esatto come scritto nel documento",
  "course_category": "una di: rischio_basso, rischio_medio, rischio_alto, preposto, dirigente, primo_soccorso_a, primo_soccorso_bc, antincendio_basso, antincendio_medio, antincendio_alto, ponteggi, lavori_quota, carrelli, gru, escavatori, badge_patentino, altro",
  "issue_date": "data in formato YYYY-MM-DD",
  "issuing_body": "nome ente formatore",
  "certificate_number": "numero attestato se presente, altrimenti null",
  "legal_reference": "riferimento normativo se presente, altrimenti null",
  "confidence": {
    "worker_name": 0.0,
    "course_name": 0.0,
    "issue_date": 0.0,
    "issuing_body": 0.0
  }
}

Se un campo non è leggibile restituisci null per quel campo e confidence 0.0. Non inventare mai dati. Non aggiungere spiegazioni.`;

// Mappa category → course_type name per il lookup nel DB
const CATEGORY_TO_COURSE_NAME = {
  rischio_basso:     'Formazione lavoratori - Rischio Basso',
  rischio_medio:     'Formazione lavoratori - Rischio Medio',
  rischio_alto:      'Formazione lavoratori - Rischio Alto',
  preposto:          'Formazione Preposto',
  dirigente:         'Formazione Dirigente sicurezza',
  primo_soccorso_a:  'Primo Soccorso - Gruppo A',
  primo_soccorso_bc: 'Primo Soccorso - Gruppo B/C',
  antincendio_basso: 'Antincendio - Rischio Basso',
  antincendio_medio: 'Antincendio - Rischio Medio',
  antincendio_alto:  'Antincendio - Rischio Alto',
  ponteggi:          'Ponteggi - Montaggio e smontaggio',
  lavori_quota:      'Lavori in quota',
  carrelli:          'Carrelli elevatori',
  gru:               'Gru per autocarro',
  escavatori:        'Escavatori e macchine movimento terra',
  badge_patentino:   'Badge Patentino - D.L. 159/2025',
};

router.use(verifySupabaseJwt);

// ── POST /api/v1/workers/:workerId/certificates/upload ────────────────────────

router.post('/workers/:workerId/certificates/upload', upload.single('file'), async (req, res) => {
  const { workerId } = req.params;

  // Verifica worker appartiene all'azienda
  const { data: worker } = await supabase
    .from('workers')
    .select('id, full_name')
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const ext  = req.file.mimetype === 'application/pdf' ? 'pdf' : req.file.mimetype.split('/')[1];
  const path = `certificates/${req.companyId}/${workerId}/${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('documents')
    .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (upErr) {
    console.error('[cert-upload] storage error:', upErr.message);
    return res.status(500).json({ error: 'STORAGE_ERROR', detail: upErr.message });
  }

  const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(path);

  res.json({ url: publicUrl, path, mime: req.file.mimetype, size: req.file.size });
});

// ── POST /api/v1/workers/:workerId/certificates/extract ───────────────────────

router.post('/workers/:workerId/certificates/extract', aiLimiter, validate(extractCertificateSchema), async (req, res) => {
  const { workerId } = req.params;
  const { file_url, file_base64, mime_type } = req.body || {};

  if (!file_url && !file_base64) {
    return res.status(400).json({ error: 'MISSING_FILE', message: 'Fornire file_url o file_base64' });
  }

  // Verifica worker
  const { data: worker } = await supabase
    .from('workers')
    .select('id, full_name, fiscal_code')
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  // Prepara content per Claude
  let imageContent;
  if (file_base64) {
    const media = mime_type || 'image/jpeg';
    imageContent = { type: 'base64', media_type: media, data: file_base64 };
  } else {
    // Scarica il file dall'URL — solo domini Supabase Storage (whitelist SSRF)
    try {
      const parsedUrl = new URL(file_url);
      if (!parsedUrl.hostname.endsWith('.supabase.co')) {
        return res.status(400).json({ error: 'INVALID_FILE_URL', message: 'Il file deve provenire da Supabase Storage.' });
      }
      const resp = await fetch(file_url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const ct  = resp.headers.get('content-type') || mime_type || 'image/jpeg';
      imageContent = { type: 'base64', media_type: ct, data: b64 };
    } catch (e) {
      return res.status(400).json({ error: 'FILE_FETCH_ERROR', message: e.message });
    }
  }

  // Chiama Claude Vision
  let extracted;
  try {
    const ai = getAI();
    const msg = await ai.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: imageContent },
          { type: 'text', text: OCR_PROMPT },
        ],
      }],
    });

    const raw = msg.content[0]?.text?.trim() || '';
    // Estrae il JSON dalla risposta (Claude a volte aggiunge ```json```)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Risposta non JSON');
    extracted = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[cert-ocr] Claude error:', e.message);
    return res.status(500).json({ error: 'OCR_ERROR', message: e.message });
  }

  // Cerca il course_type_id corrispondente
  let course_type_id   = null;
  let course_type_name = null;
  let validity_years   = null;
  let expiry_date      = null;

  const categoryName = CATEGORY_TO_COURSE_NAME[extracted.course_category];
  if (categoryName) {
    const { data: ct } = await supabase
      .from('course_types')
      .select('id, name, validity_years')
      .eq('name', categoryName)
      .maybeSingle();

    if (ct) {
      course_type_id   = ct.id;
      course_type_name = ct.name;
      validity_years   = ct.validity_years;

      if (extracted.issue_date && ct.validity_years) {
        const d = new Date(extracted.issue_date);
        d.setFullYear(d.getFullYear() + ct.validity_years);
        expiry_date = d.toISOString().slice(0, 10);
      }
    }
  }

  // Se il nome lavoratore non corrisponde al contesto, segnalalo
  const nameMatchWarning = extracted.worker_name &&
    !extracted.worker_name.toLowerCase().includes(worker.full_name.split(' ')[0].toLowerCase());

  res.json({
    extracted: {
      worker_name:        extracted.worker_name,
      worker_cf:          extracted.worker_cf,
      course_name:        extracted.course_name,
      course_category:    extracted.course_category,
      course_type_id,
      course_type_name,
      issue_date:         extracted.issue_date,
      expiry_date,
      validity_years,
      issuing_body:       extracted.issuing_body,
      certificate_number: extracted.certificate_number,
      legal_reference:    extracted.legal_reference,
    },
    confidence:         extracted.confidence || {},
    name_match_warning: nameMatchWarning,
    worker: { id: worker.id, full_name: worker.full_name },
  });
});

module.exports = router;
