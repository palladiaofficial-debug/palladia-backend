'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_TYPES = ['observation', 'request', 'approval', 'warning'];

// POST /api/v1/sites/:siteId/coordinator-invites
const createCoordinatorInviteSchema = z.object({
  coordinator_name:    z.string().trim().min(1).max(200),
  coordinator_email:   z.string().trim().email().max(200).nullable().optional(),
  coordinator_company: z.string().trim().max(200).nullable().optional(),
  ttl_days:            z.number().int().min(1).max(365).optional(),
});

// POST /api/v1/coordinator/:token/notes  (token nel path, nessun JWT)
const createCoordinatorNoteSchema = z.object({
  content:   z.string().trim().min(3).max(2000),
  note_type: z.enum(NOTE_TYPES).optional(),
});

// POST /api/v1/coordinator/request-link
const requestLinkSchema = z.object({
  email: z.string().trim().email().max(200),
});

module.exports = {
  createCoordinatorInviteSchema,
  createCoordinatorNoteSchema,
  requestLinkSchema,
};
