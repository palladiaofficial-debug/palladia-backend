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

module.exports = {
  patchMoltiplicatoreSchema,
  createSubcontractSchema,
  patchSubcontractSchema,
  createSubcontractSalSchema,
};
