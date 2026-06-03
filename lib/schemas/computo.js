'use strict';
const { z } = require('zod');

const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// Schema per una singola voce del computo (categoria o voce di lavoro)
const voceSchema = z.object({
  tipo:            z.enum(['categoria', 'voce']),
  parent_codice:   z.string().max(50).nullable().optional(),
  codice:          z.string().max(50).nullable().optional(),
  descrizione:     z.string().trim().min(1).max(500),
  unita_misura:    nullableStr(20),
  quantita:        z.number().nullable().optional(),
  prezzo_unitario: z.number().nonnegative().nullable().optional(),
  importo:         z.number().nullable().optional(),
  sort_order:      z.number().int().optional(),
});

// POST /sites/:siteId/computo — salva computo confermato dall'utente
const createComputoSchema = z.object({
  nome:  z.string().trim().max(200).optional(),
  fonte: z.string().trim().max(50).optional(),
  voci:  z.array(voceSchema).min(1, 'voci obbligatorie'),
});

// PATCH /computo/voci/:voceId/sal
const patchVoceSalSchema = z.object({
  sal_percentuale: z.number().min(0, 'sal_percentuale deve essere 0-100').max(100, 'sal_percentuale deve essere 0-100'),
  sal_note:        z.string().trim().max(500).nullable().optional(),
}).strip();

module.exports = {
  createComputoSchema,
  patchVoceSalSchema,
};
