'use strict';
const { z } = require('zod');

const NOTE_TYPES = ['observation', 'request', 'approval', 'warning'];

// POST /api/v1/sites/:siteId/coordinator-invites
const createCoordinatorInviteSchema = z.object({
  coordinator_name:    z.string().trim().min(1).max(200),
  coordinator_email:   z.string().trim().email().max(200).nullable().optional(),
  coordinator_company: z.string().trim().max(200).nullable().optional(),
  ttl_days:            z.number().int().min(1).max(365).optional(),
});

// POST /api/v1/coordinator/:token/notes  (token nel path, nessun JWT)
// photo_path arriva SOLO dalla risposta di .../notes/photo (mai un path
// arbitrario del client) — il coordinatore carica la foto, riceve il path,
// poi lo passa qui insieme alla nota. gps_lat/gps_lng opzionali: mai
// obbligatorie, il dispositivo potrebbe non fornirle o l'utente rifiutarle.
const createCoordinatorNoteSchema = z.object({
  content:    z.string().trim().min(3).max(2000),
  note_type:  z.enum(NOTE_TYPES).optional(),
  photo_path: z.string().trim().min(1).max(500).nullable().optional(),
  gps_lat:    z.number().min(-90).max(90).nullable().optional(),
  gps_lng:    z.number().min(-180).max(180).nullable().optional(),
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
