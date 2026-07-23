'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_CATEGORIES = ['sicurezza', 'documentale', 'operativa', 'igiene'];
const VALID_SEVERITIES = ['bassa', 'media', 'alta', 'critica'];

// POST /coordinator/:token/nonconformities
// POST /coordinator/pro/:token/site/:siteId/nonconformities
const createNonconformitySchema = z.object({
  title:       z.string().trim().min(3).max(300),
  description: z.string().trim().min(3).max(3000),
  category:    z.enum(VALID_CATEGORIES).optional(),
  severity:    z.enum(VALID_SEVERITIES).optional(),
  due_date:    z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v)),
});

// PATCH /coordinator/:token/nonconformities/:id/close
// PATCH /coordinator/pro/:token/nonconformities/:id/close
const closeNonconformitySchema = z.object({
  action: z.enum(['close', 'reopen']).optional(),
}).strip();

// PATCH /nonconformities/:id — impresa aggiorna stato/risposta
const patchNonconformitySchema = z.object({
  status:           z.enum(['in_lavorazione', 'risolta']).optional(),
  resolution_notes: z.string().trim().max(3000).nullable().optional(),
}).strip();

module.exports = { createNonconformitySchema, closeNonconformitySchema, patchNonconformitySchema };
