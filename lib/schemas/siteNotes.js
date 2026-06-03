'use strict';
const { z } = require('zod');

const VALID_CATEGORIES = ['nota', 'foto', 'non_conformita', 'verbale', 'presenza', 'incidente', 'documento', 'altro'];
const VALID_URGENCIES  = ['normale', 'alta', 'critica'];

// ── POST /api/v1/site-notes/:id/reminder ─────────────────────────────────────
// La POST principale /site-notes usa multer (multipart) — viene skippata.
const createReminderSchema = z.object({
  minutes: z.number().int().min(1).max(1440),
}).strip();

// ── PATCH /api/v1/site-notes/:id ─────────────────────────────────────────────
const patchNoteSchema = z.object({
  content:  z.string().trim().max(10000).optional(),
  category: z.enum(VALID_CATEGORIES).optional(),
  urgency:  z.enum(VALID_URGENCIES).optional(),
}).strip();

module.exports = { createReminderSchema, patchNoteSchema };
