'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v));
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

const VALID_TIPI        = ['fattura', 'ddt', 'acconto', 'ritenuta', 'altro'];
const VALID_CATEGORIE   = ['Materiali', 'Subappalto', 'Nolo', 'Manodopera extra', 'Trasporti', 'Forniture', 'Oneri sicurezza', 'Altro'];

// ── POST /api/v1/sites/:siteId/costs ──────────────────────────────────────────
// (la route usa multer per file opzionale — il body è form-data o JSON)
// validate() interviene sul body dopo che multer l'ha parsato (req.body è già disponibile)
const createCostSchema = z.object({
  descrizione:        z.string().trim().min(1, 'descrizione richiesta').max(500),
  importo:            z.union([z.number(), z.string().regex(/^\d+([.,]\d+)?$/, 'importo non valido')]),
  phase_id:           z.string().uuid().nullable().optional(),
  capitolato_voce_id: z.string().uuid().nullable().optional(),
  fornitore:          nullableStr(200),
  quantita:           z.number().nullable().optional(),
  unita_misura:       nullableStr(50),
  prezzo_unitario:    z.number().nullable().optional(),
  data_documento:     dateField,
  tipo:               z.enum(VALID_TIPI).optional(),
  numero_documento:   nullableStr(100),
  categoria:          z.enum(VALID_CATEGORIE).nullable().optional(),
  note:               nullableStr(2000),
});

// ── PATCH /api/v1/sites/:siteId/costs/:costId ────────────────────────────────
const patchCostSchema = z.object({
  descrizione:        z.string().trim().max(500).optional(),
  fornitore:          nullableStr(200),
  quantita:           z.number().nullable().optional(),
  unita_misura:       nullableStr(50),
  prezzo_unitario:    z.number().nullable().optional(),
  importo:            z.number().optional(),
  data_documento:     dateField,
  tipo:               z.enum(VALID_TIPI).optional(),
  numero_documento:   nullableStr(100),
  phase_id:           z.string().uuid().nullable().optional(),
  capitolato_voce_id: z.string().uuid().nullable().optional(),
  categoria:          z.enum(VALID_CATEGORIE).nullable().optional(),
  note:               nullableStr(2000),
  pagato_il:          dateField,
}).strip();

module.exports = { createCostSchema, patchCostSchema };
