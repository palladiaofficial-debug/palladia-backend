'use strict';
const { z } = require('zod');

// POST /coordinator/:token/verifications
// POST /coordinator/pro/:token/site/:siteId/verifications
const createVerificationSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

module.exports = { createVerificationSchema };
