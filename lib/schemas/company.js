'use strict';
const { z } = require('zod');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// PATCH /company — aggiorna profilo azienda
const patchCompanySchema = z.object({
  name:           z.string().trim().min(1).max(200).optional(),
  piva:           nullableStr(20),
  address:        nullableStr(300),
  phone:          nullableStr(30),
  contact_email:  z.string().trim().email().nullable().optional(),
  safety_manager: nullableStr(200),
  durc_expiry:    z.string().regex(DATE_RE, 'formato YYYY-MM-DD').nullable().optional(),
}).strip();

// PATCH /team-members/:userId — modifica ruolo membro
const patchTeamMemberSchema = z.object({
  role: z.enum(['admin', 'tech', 'viewer']),
}).strip();

// POST /leave-company — abbandona una company
const leaveCompanySchema = z.object({
  company_id: z.string().uuid('company_id deve essere un UUID valido'),
});

module.exports = { patchCompanySchema, patchTeamMemberSchema, leaveCompanySchema };
