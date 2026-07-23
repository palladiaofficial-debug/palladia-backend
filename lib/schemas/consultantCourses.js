'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// Schema sessione opzionale inline (usato nel POST courses)
const inlineSessionSchema = z.object({
  start_date:        z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  end_date:          z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).optional().transform(v => (v === '' ? undefined : v)),
  available_spots:   z.number().int().min(1).optional(),
  location_override: nullableStr(300),
  notes:             z.string().trim().max(1000).nullable().optional(),
});

// POST /consultant/courses
const createConsultantCourseSchema = z.object({
  course_type_id:              z.string().uuid('UUID non valido'),
  title:                       z.string().trim().min(2).max(200),
  price_cents:                 z.number().int().min(0),
  duration_hours:              z.number().int().min(1),
  issuing_body_name:           z.string().trim().min(1).max(200),
  description:                 z.string().trim().max(2000).nullable().optional(),
  delivery_mode:               z.string().trim().max(50).optional(),
  location_city:               nullableStr(100),
  location_address:            nullableStr(300),
  max_participants:            z.number().int().min(1).nullable().optional(),
  certificate_issued_days:     z.number().int().min(1).optional(),
  issuing_body_accreditation:  nullableStr(200),
  is_draft:                    z.boolean().optional(),
  sessions:                    z.array(inlineSessionSchema).optional(),
});

// PUT /consultant/courses/:id
const putConsultantCourseSchema = z.object({
  title:                       z.string().trim().min(2).max(200).optional(),
  description:                 z.string().trim().max(2000).nullable().optional(),
  price_cents:                 z.number().int().min(0).optional(),
  delivery_mode:               z.string().trim().max(50).optional(),
  location_city:               nullableStr(100),
  location_address:            nullableStr(300),
  duration_hours:              z.number().int().min(1).optional(),
  max_participants:            z.number().int().min(1).nullable().optional(),
  certificate_issued_days:     z.number().int().min(1).optional(),
  issuing_body_name:           z.string().trim().max(200).optional(),
  issuing_body_accreditation:  nullableStr(200),
  is_draft:                    z.boolean().optional(),
  is_active:                   z.boolean().optional(),
}).strip();

// POST /consultant/courses/:id/sessions
const createConsultantSessionSchema = z.object({
  start_date:        z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  end_date:          z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  available_spots:   z.number().int().min(1),
  location_override: nullableStr(300),
  notes:             z.string().trim().max(1000).nullable().optional(),
});

// PUT /consultant/sessions/:id
const putConsultantSessionSchema = z.object({
  start_date:        z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).optional().transform(v => (v === '' ? undefined : v)),
  end_date:          z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).optional().transform(v => (v === '' ? undefined : v)),
  available_spots:   z.number().int().min(1).optional(),
  location_override: nullableStr(300),
  notes:             z.string().trim().max(1000).nullable().optional(),
}).strip();

// DELETE /consultant/sessions/:id (body opzionale con reason)
const cancelConsultantSessionSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional(),
}).strip();

module.exports = {
  createConsultantCourseSchema,
  putConsultantCourseSchema,
  createConsultantSessionSchema,
  putConsultantSessionSchema,
  cancelConsultantSessionSchema,
};
