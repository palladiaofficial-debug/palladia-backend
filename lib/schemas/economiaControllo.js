'use strict';
const { z } = require('zod');

const nullableStr = (max = 1000) => z.string().trim().max(max).nullable().optional();

// PATCH /economia-controllo/moltiplicatore
const patchMoltiplicatoreSchema = z.object({
  moltiplicatore_costo_manodopera: z.number().min(1.00, 'minimo 1,00 (nessun sovraccosto)').max(2.50, 'massimo 2,50'),
}).strip();

// POST /sites/:siteId/subcontracts
const createSubcontractSchema = z.object({
  subcontractor_id:   z.string().uuid().nullable().optional(),
  descrizione:        z.string().trim().min(1, 'descrizione obbligatoria').max(500),
  importo_pattuito:   z.number().positive('importo_pattuito deve essere > 0'),
  data_emissione:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato YYYY-MM-DD').optional(),
  stato:              z.enum(['bozza', 'emesso', 'chiuso', 'annullato']).optional(),
  note:               nullableStr(2000),
});

// PATCH /sites/:siteId/subcontracts/:id
const patchSubcontractSchema = z.object({
  subcontractor_id:   z.string().uuid().nullable().optional(),
  descrizione:        z.string().trim().min(1).max(500).optional(),
  importo_pattuito:   z.number().positive('importo_pattuito deve essere > 0').optional(),
  data_emissione:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato YYYY-MM-DD').optional(),
  stato:              z.enum(['bozza', 'emesso', 'chiuso', 'annullato']).optional(),
  note:               nullableStr(2000),
}).strip();

// POST /sites/:siteId/subcontracts/:id/sal
const createSubcontractSalSchema = z.object({
  importo: z.number().positive('importo deve essere > 0'),
  data:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato YYYY-MM-DD').optional(),
  note:    nullableStr(2000),
});

// PATCH /sites/:siteId/economia-controllo/budget-manuale
// Ogni categoria è opzionale e indipendente: null/omessa = "non impostata"
// (rimuove la riga se esisteva), non 0 forzato — un cantiere può avere solo
// manodopera+materiali stimati e le altre due ancora da definire.
const CATEGORIE_BUDGET = ['manodopera', 'materiali', 'subappalti', 'noleggi'];
const budgetManualeSchema = z.object(
  Object.fromEntries(CATEGORIE_BUDGET.map(c => [c, z.number().min(0).nullable().optional()]))
).strip();

// PATCH /economia-controllo/spese-generali
const patchSpeseGeneraliSchema = z.object({
  percentuale_spese_generali: z.number().min(0, 'minimo 0').max(100, 'massimo 100'),
}).strip();

// POST /economia-controllo/validazione-mensile
const createValidazioneMensileSchema = z.object({
  site_id:       z.string().uuid(),
  mese:          z.string().regex(/^\d{4}-\d{2}(-01)?$/, 'formato YYYY-MM o YYYY-MM-01'),
  margine_reale: z.number(),
  note:          nullableStr(2000),
});

module.exports = {
  patchMoltiplicatoreSchema,
  createSubcontractSchema,
  patchSubcontractSchema,
  createSubcontractSalSchema,
  budgetManualeSchema,
  CATEGORIE_BUDGET,
  patchSpeseGeneraliSchema,
  createValidazioneMensileSchema,
};
