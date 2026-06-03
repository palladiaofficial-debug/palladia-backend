'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// Schema singolo certificato per il POST /consultant/bookings/:id/certificates
const certificateItemSchema = z.object({
  worker_id:          z.string().uuid('UUID non valido'),
  issue_date:         z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  issuing_body:       z.string().trim().min(1).max(200),
  certificate_number: nullableStr(100),
  pdf_url:            nullableStr(500),
});

// POST /consultant/bookings/:id/certificates
const uploadCertificatesSchema = z.object({
  certificates: z.array(certificateItemSchema).min(1),
});

module.exports = {
  uploadCertificatesSchema,
};
