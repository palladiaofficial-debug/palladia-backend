'use strict';
const { z } = require('zod');

// PATCH /feature-flags/:feature
const patchFeatureFlagSchema = z.object({
  enabled:          z.boolean({ required_error: 'enabled deve essere boolean' }),
  company_id:       z.string().uuid().nullable().optional(),
}).strip();

module.exports = { patchFeatureFlagSchema };
