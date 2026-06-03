'use strict';
const { z } = require('zod');

const NOTE_TYPES  = ['observation', 'request', 'approval', 'warning'];
const QUALIFICHE  = ['CSE', 'CSP', 'Direttore Lavori', 'RUP', 'RSPP', 'Altro'];

// PATCH /coordinator/pro/:token/me
const patchProMeSchema = z.object({
  full_name: z.string().trim().min(2).max(200).optional(),
  qualifica: z.enum(QUALIFICHE).optional(),
  azienda:   z.string().trim().max(200).nullable().optional(),
  piva:      z.string().trim().max(50).nullable().optional(),
  phone:     z.string().trim().max(50).nullable().optional(),
}).strip();

// POST /coordinator/pro/register
const registerProSchema = z.object({
  email:     z.string().trim().email().max(320),
  full_name: z.string().trim().min(2).max(200),
  qualifica: z.enum(QUALIFICHE).optional(),
  azienda:   z.string().trim().max(200).nullable().optional(),
  piva:      z.string().trim().max(50).nullable().optional(),
});

// POST /coordinator/pro/request
const requestProSchema = z.object({
  email: z.string().trim().email().max(320),
});

// POST /coordinator/pro/:token/site/:siteId/notes
const createProNoteSchema = z.object({
  content:   z.string().trim().min(3).max(2000),
  note_type: z.enum(NOTE_TYPES).optional(),
});

module.exports = {
  patchProMeSchema,
  registerProSchema,
  requestProSchema,
  createProNoteSchema,
};
