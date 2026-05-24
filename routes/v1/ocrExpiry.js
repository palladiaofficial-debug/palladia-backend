'use strict';
/**
 * routes/v1/ocrExpiry.js
 * OCR data di scadenza su documenti (DURC, idoneità medica, assicurazioni, SOA).
 *
 * POST /api/v1/ocr/expiry
 *   Body (multipart/form-data): file  — PDF o immagine, max 10 MB
 *   Query: doc_type (durc|idoneita|assicurazione|soa|altro) — opzionale, guida il prompt
 *   Response: { expiry_date: "YYYY-MM-DD", issue_date: "YYYY-MM-DD"|null,
 *               doc_type_detected: string, holder: string|null, confidence: number }
 */

const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const multer    = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _ai;
}

const DOC_LABELS = {
  durc:         'DURC (Documento Unico di Regolarità Contributiva)',
  idoneita:     'Idoneità medica lavorativa',
  assicurazione:'Polizza assicurativa cantiere/responsabilità civile',
  soa:          'Attestazione SOA (qualificazione imprese)',
  altro:        'documento amministrativo/normativo italiano',
};

function buildPrompt(docType) {
  const label = DOC_LABELS[docType] || DOC_LABELS.altro;
  return `Sei un sistema OCR specializzato in documenti amministrativi italiani.
Stai analizzando un ${label}.

Estrai le seguenti informazioni e restituisci SOLO un oggetto JSON (nessun testo extra):

{
  "expiry_date": "YYYY-MM-DD o null se non trovata",
  "issue_date": "YYYY-MM-DD o null se non trovata",
  "doc_type_detected": "durc|idoneita|assicurazione|soa|altro",
  "holder": "nome azienda o persona intestataria del documento, null se non leggibile",
  "confidence": 0.0
}

Regole:
- expiry_date è il campo più importante: cerca "scade il", "valida fino al", "data di scadenza", "validità fino al".
- confidence: 0.9 se trovi una data di scadenza chiara, 0.5 se deduci, 0.0 se non trovi nulla.
- Non inventare date. Se non trovi la scadenza, metti null.
- Per il DURC la validità è 120 giorni dalla data di emissione — se trovi solo issue_date, calcola expiry_date come issue_date + 120 giorni.`;
}

// ── POST /api/v1/ocr/expiry ───────────────────────────────────────────────────

router.post('/ocr/expiry', verifySupabaseJwt, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

  const docType = (req.query.doc_type || req.body?.doc_type || 'altro').toLowerCase();
  const mime    = req.file.mimetype;
  const b64     = req.file.buffer.toString('base64');

  // PDF → passa come documento (Claude supporta PDF via base64)
  const sourceType = mime === 'application/pdf' ? 'base64' : 'base64';
  const mediaType  = mime === 'application/pdf' ? 'application/pdf' : mime;

  let result;
  try {
    const ai  = getAI();
    const msg = await ai.messages.create({
      model:      'claude-haiku-4-5-20251001', // haiku: economico, veloce, ottimo per OCR strutturato
      max_tokens: 512,
      messages: [{
        role:    'user',
        content: [
          {
            type:   'image',
            source: { type: sourceType, media_type: mediaType, data: b64 },
          },
          { type: 'text', text: buildPrompt(docType) },
        ],
      }],
    });

    const raw = msg.content[0]?.text?.trim() || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Risposta non JSON');
    result = JSON.parse(match[0]);
  } catch (e) {
    console.error('[ocr-expiry] AI error:', e.message);
    return res.status(500).json({ error: 'OCR_ERROR', message: e.message });
  }

  // Calcola expiry da issue_date per DURC se manca scadenza
  if (!result.expiry_date && result.issue_date && (docType === 'durc' || result.doc_type_detected === 'durc')) {
    const d = new Date(result.issue_date);
    d.setDate(d.getDate() + 120);
    result.expiry_date = d.toISOString().slice(0, 10);
    result.confidence  = Math.min(result.confidence || 0, 0.7);
  }

  res.json({
    expiry_date:       result.expiry_date || null,
    issue_date:        result.issue_date  || null,
    doc_type_detected: result.doc_type_detected || docType,
    holder:            result.holder || null,
    confidence:        typeof result.confidence === 'number' ? result.confidence : 0,
  });
});

module.exports = router;
