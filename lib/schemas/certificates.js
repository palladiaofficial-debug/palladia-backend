'use strict';
const { z } = require('zod');

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional();
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /workers/:workerId/certificates
const createCertificateSchema = z.object({
  course_type_id:     z.string().uuid('course_type_id deve essere UUID'),
  site_id:            z.string().uuid().nullable().optional(),
  issue_date:         z.string().regex(DATE_RE, 'issue_date deve essere YYYY-MM-DD'),
  issuing_body:       z.string().trim().min(1, 'issuing_body obbligatorio').max(200),
  certificate_number: nullableStr(100),
  pdf_url:            z.string().url().max(1000).nullable().optional(),
});

// PUT /certificates/:id  — PUT non PATCH, ma trattato come aggiornamento parziale
const updateCertificateSchema = z.object({
  course_type_id:     z.string().uuid().optional(),
  issue_date:         z.string().regex(DATE_RE, 'issue_date deve essere YYYY-MM-DD').optional(),
  issuing_body:       z.string().trim().min(1).max(200).optional(),
  certificate_number: nullableStr(100),
  pdf_url:            z.string().url().max(1000).nullable().optional(),
  site_id:            z.string().uuid().nullable().optional(),
}).strip();

// PATCH /formazione/notifications/:id/read
const patchNotificationReadSchema = z.object({
  action_taken: z.string().trim().max(200).nullable().optional(),
}).strip();

module.exports = {
  createCertificateSchema,
  updateCertificateSchema,
  patchNotificationReadSchema,
};
