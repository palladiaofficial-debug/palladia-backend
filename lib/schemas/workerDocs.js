'use strict';
const { z } = require('zod');

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v));

const ALLOWED_TYPES = [
  'idoneita_medica',
  'formazione_sicurezza',
  'primo_soccorso',
  'antincendio',
  'lavori_quota',
  'ponteggi',
  'gruista',
  'pes_pav_pei',
  'rspp',
  'patente_guida',
  'altro',
];

// POST /workers/:workerId/documents
// (multer popola req.body con i campi form-data — il file viene skippato dal validate)
const createWorkerDocSchema = z.object({
  doc_type:    z.enum(ALLOWED_TYPES).default('altro'),
  name:        z.string().trim().min(1, 'name obbligatorio').max(500),
  issued_date: dateField,
  expiry_date: dateField,
  notes:       z.string().trim().max(2000).nullable().optional(),
});

// PATCH /workers/:workerId/documents/:docId
const patchWorkerDocSchema = z.object({
  doc_type:    z.enum(ALLOWED_TYPES).optional(),
  name:        z.string().trim().min(1).max(500).optional(),
  issued_date: dateField,
  expiry_date: dateField,
  notes:       z.string().trim().max(2000).nullable().optional(),
}).strip();

module.exports = { createWorkerDocSchema, patchWorkerDocSchema };
