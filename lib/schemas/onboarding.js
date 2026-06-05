'use strict';
const { z } = require('zod');

// POST /onboarding/setup
const setupCompanySchema = z.object({
  company_name: z.string().trim().min(2, 'min 2 caratteri').max(200, 'max 200 caratteri'),
  full_name:    z.string().trim().max(200).nullable().optional(),
  account_type: z.enum(['impresa', 'studio_cdl', 'provider', 'consulente']).optional().default('impresa'),
});

module.exports = { setupCompanySchema };
