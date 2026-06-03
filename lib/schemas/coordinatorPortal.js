'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_TYPES = ['observation', 'request', 'approval', 'warning'];
const NC_CATEGORIES = ['sicurezza', 'documentale', 'operativa', 'igiene'];
const NC_SEVERITIES  = ['bassa', 'media', 'alta', 'critica'];

// POST /coordinator/portal/:token/site/:siteId/notes
const createPortalNoteSchema = z.object({
  content:   z.string().trim().min(3).max(2000),
  note_type: z.enum(NOTE_TYPES).optional(),
});

// POST /coordinator/portal/:token/site/:siteId/nonconformities
const createNonconformitySchema = z.object({
  title:       z.string().trim().min(3).max(300),
  description: z.string().trim().min(3).max(3000),
  category:    z.enum(NC_CATEGORIES).optional(),
  severity:    z.enum(NC_SEVERITIES).optional(),
  due_date:    z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional(),
});

// POST /coordinator/portal/:token/site/:siteId/verifications
const createVerificationSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

module.exports = {
  createPortalNoteSchema,
  createNonconformitySchema,
  createVerificationSchema,
};
