'use strict';
const { z } = require('zod');

const DATE_RE    = /^\d{4}-\d{2}-\d{2}$/;
const dateField  = z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v));
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

const SAFETY_ROLES    = ['rspp', 'mc', 'rls', 'preposto', 'aspp', 'addetto_ps', 'addetto_antincendio'];
const DOC_TYPES       = ['durc', 'visura', 'dvr', 'polizza', 'certificato', 'idoneita', 'verbale', 'contratto', 'altro'];
const TEAM_ROLES      = ['admin', 'collaborator'];
const REVIEW_STATUSES = ['reviewed', 'rejected'];

// POST /studio/onboard
const onboardSchema = z.object({
  studio_name:          z.string().trim().min(1).max(200),
  vat_number:           nullableStr(30),
  registration_number:  nullableStr(100),
  operative_regions:    z.array(z.string().trim().max(100)).optional(),
  bio:                  nullableStr(2000),
  logo_url:             z.string().url().nullable().optional(),
  edil_connect_code:    nullableStr(100),
});

// PUT /studio/me
const putStudioMeSchema = z.object({
  studio_name:          z.string().trim().min(1).max(200).optional(),
  vat_number:           nullableStr(30),
  registration_number:  nullableStr(100),
  operative_regions:    z.array(z.string().trim().max(100)).optional(),
  bio:                  nullableStr(2000),
  logo_url:             z.string().url().nullable().optional(),
  edil_connect_code:    nullableStr(100),
}).strip();

// POST /studio/clients/invite
const inviteClientSchema = z.object({
  company_id:    z.string().uuid().optional(),
  vat_number:    nullableStr(30),
  contact_email: z.string().trim().email().max(200).optional(),
  contact_name:  nullableStr(200),
  company_name:  nullableStr(200),
});

// POST /studio/clients/create-direct
const createDirectClientSchema = z.object({
  company_name:   z.string().trim().min(1).max(200),
  piva:           nullableStr(30),
  address:        nullableStr(300),
  phone:          nullableStr(50),
  contact_email:  z.string().trim().email().max(200).nullable().optional(),
  safety_manager: nullableStr(200),
});

// PUT /studio/clients/:companyId/profile
const putClientProfileSchema = z.object({
  name:           z.string().trim().min(1).max(200).optional(),
  piva:           nullableStr(30),
  address:        nullableStr(300),
  phone:          nullableStr(50),
  contact_email:  z.string().trim().email().max(200).nullable().optional(),
  safety_manager: nullableStr(200),
}).strip();

// POST /studio/clients/:companyId/workers
const createWorkerSchema = z.object({
  full_name:   z.string().trim().min(1).max(200),
  fiscal_code: z.string().trim().min(1).max(16),
});

// PUT /studio/clients/:companyId/workers/:workerId
const putWorkerSchema = z.object({
  full_name:   z.string().trim().min(1).max(200).optional(),
  fiscal_code: z.string().trim().min(1).max(16).optional(),
  is_active:   z.boolean().optional(),
}).strip();

// PUT /studio/clients/:companyId/workers/:workerId/sorveglianza
const putSorveglianzaSchema = z.object({
  health_fitness_expiry:  dateField,
  safety_training_expiry: dateField,
}).strip();

// PUT /studio/clients/:companyId/compliance
const putComplianceSchema = z.object({
  durc_expiry_date:       dateField,
  last_safety_meeting_at: z.string().nullable().optional(),
}).strip();

// POST /studio/clients/:companyId/certificates
const createCertificateSchema = z.object({
  worker_id:         z.string().uuid(),
  course_type_name:  z.string().trim().min(1).max(200),
  expiry_date:       z.string().regex(DATE_RE, 'formato YYYY-MM-DD'),
  issue_date:        z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).optional().transform(v => (v === '' ? undefined : v)),
  issuing_body:      z.string().trim().max(200).optional(),
  certificate_number: nullableStr(100),
});

// PUT /studio/clients/:companyId/certificates/:certId
const putCertificateSchema = z.object({
  course_type_name:   z.string().trim().min(1).max(200).optional(),
  issue_date:         z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).optional().transform(v => (v === '' ? undefined : v)),
  expiry_date:        z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).optional().transform(v => (v === '' ? undefined : v)),
  issuing_body:       z.string().trim().max(200).optional(),
  certificate_number: nullableStr(100),
}).strip();

// POST /studio/clients/:companyId/import-csv
const importCsvSchema = z.object({
  csv_text: z.string().trim().min(1),
});

// POST /studio/clients/:companyId/safety-roles
const createSafetyRoleSchema = z.object({
  role_type:        z.enum(SAFETY_ROLES),
  full_name:        z.string().trim().min(1).max(200),
  appointment_date: dateField,
  expiry_date:      dateField,
  qualification:    nullableStr(200),
  notes:            nullableStr(500),
});

// POST /studio/clients/:companyId/document-requests
const createDocumentRequestSchema = z.object({
  title:         z.string().trim().min(3).max(200),
  description:   z.string().trim().max(1000).nullable().optional(),
  document_type: z.enum(DOC_TYPES).optional(),
  due_date:      dateField,
});

// PATCH /studio/clients/:companyId/document-requests/:reqId/review
const reviewDocumentRequestSchema = z.object({
  status:         z.enum(REVIEW_STATUSES),
  reviewer_notes: z.string().trim().max(1000).nullable().optional(),
}).strip();

// POST /studio/upload/:token  (endpoint pubblico — cliente carica URL documento)
const uploadDocumentSchema = z.object({
  response_url:      z.string().url().max(2000).optional(),
  response_filename: z.string().trim().max(300).optional(),
  response_notes:    z.string().trim().max(500).nullable().optional(),
});

// POST /studio/claim-company
const claimCompanySchema = z.object({
  vat_number: z.string().trim().min(1).max(30),
});

// POST /studio/team/invite
const inviteTeamMemberSchema = z.object({
  email: z.string().trim().email().max(200),
  role:  z.enum(TEAM_ROLES).optional(),
});

// PATCH /studio/team/:memberId/role
const patchTeamRoleSchema = z.object({
  role: z.enum(TEAM_ROLES),
}).strip();

module.exports = {
  onboardSchema,
  putStudioMeSchema,
  inviteClientSchema,
  createDirectClientSchema,
  putClientProfileSchema,
  createWorkerSchema,
  putWorkerSchema,
  putSorveglianzaSchema,
  putComplianceSchema,
  createCertificateSchema,
  putCertificateSchema,
  importCsvSchema,
  createSafetyRoleSchema,
  createDocumentRequestSchema,
  reviewDocumentRequestSchema,
  uploadDocumentSchema,
  claimCompanySchema,
  inviteTeamMemberSchema,
  patchTeamRoleSchema,
};
