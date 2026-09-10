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
  contact_email:  z.union([z.string().trim().email(), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v)),
  safety_manager: nullableStr(200),
  durc_expiry:    z.union([z.string().regex(DATE_RE, 'formato YYYY-MM-DD'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v)),
  // Pausa pranzo (F-152, AUDIT.md, migrations/195): default azienda, override possibile per cantiere.
  lunch_break_minutes:         z.number().int().min(0).max(240).optional(),
  lunch_break_threshold_hours: z.number().min(0.5).max(24).optional(),
  // Ritardo ingresso (migrations/199): default azienda, override possibile per
  // cantiere. shift_start_time null = regola disattivata (nessuna detrazione).
  shift_start_time:             z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato HH:MM'), z.literal('')]).nullable().optional().transform(v => (v === '' ? null : v)),
  late_entry_threshold_minutes: z.number().int().min(0).max(120).optional(),
  late_entry_deduction_minutes: z.number().int().min(0).max(480).optional(),
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
