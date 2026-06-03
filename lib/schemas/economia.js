'use strict';
const { z } = require('zod');

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional();
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// PATCH /sites/:siteId/economia/settings
const patchEconomiaSettingsSchema = z.object({
  budget_totale:   z.number().nonnegative('budget_totale deve essere >= 0').optional(),
  sal_percentuale: z.number().min(0).max(100, 'sal_percentuale deve essere 0-100').optional(),
}).strip();

// POST /sites/:siteId/economia/voci
const createVoceSchema = z.object({
  tipo:            z.enum(['costo', 'ricavo'], { message: 'tipo deve essere costo o ricavo' }),
  categoria:       z.string().trim().min(1, 'categoria obbligatoria').max(200),
  voce:            z.string().trim().min(1, 'voce obbligatoria').max(300),
  importo:         z.number().positive('importo deve essere > 0'),
  data_competenza: dateField,
  note:            nullableStr(1000),
});

// PATCH /sites/:siteId/economia/voci/:id
const patchVoceSchema = z.object({
  tipo:            z.enum(['costo', 'ricavo']).optional(),
  categoria:       z.string().trim().min(1).max(200).optional(),
  voce:            z.string().trim().min(1).max(300).optional(),
  importo:         z.number().positive('importo deve essere > 0').optional(),
  data_competenza: dateField,
  note:            nullableStr(1000),
}).strip();

// POST /sites/:siteId/economia/sal-history
const createSalHistorySchema = z.object({
  note: nullableStr(1000),
});

// PATCH /sites/:siteId/economia/sal-history/:id
const patchSalHistorySchema = z.object({
  pagato_il: z.string().regex(DATE_RE, 'pagato_il deve essere YYYY-MM-DD').nullable().optional(),
}).strip();

module.exports = {
  patchEconomiaSettingsSchema,
  createVoceSchema,
  patchVoceSchema,
  createSalHistorySchema,
  patchSalHistorySchema,
};
