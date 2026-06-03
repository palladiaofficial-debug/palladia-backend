'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /company-prezzi — crea voce prezzo aziendale
const createCompanyPrezzoSchema = z.object({
  descrizione: z.string().trim().min(1).max(500),
  um:          z.string().trim().min(1).max(20),
  prezzo:      z.number({ invalid_type_error: 'prezzo deve essere un numero' }).nonnegative('prezzo non può essere negativo'),
  fornitore:   nullableStr(200),
  categoria:   nullableStr(100),
  valid_from:  z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional(),
  valid_to:    z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional(),
  note:        z.string().trim().max(1000).nullable().optional(),
});

// PATCH /company-prezzi/:id — aggiorna voce prezzo
const patchCompanyPrezzoSchema = z.object({
  descrizione: z.string().trim().min(1).max(500).optional(),
  um:          z.string().trim().min(1).max(20).optional(),
  prezzo:      z.number({ invalid_type_error: 'prezzo deve essere un numero' }).nonnegative().optional(),
  fornitore:   nullableStr(200),
  categoria:   nullableStr(100),
  valid_from:  z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional(),
  valid_to:    z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional(),
  note:        z.string().trim().max(1000).nullable().optional(),
}).strip();

module.exports = { createCompanyPrezzoSchema, patchCompanyPrezzoSchema };
