'use strict';
const { z } = require('zod');

const upsertAllowedSenderSchema = z.object({
  email_address: z.string().trim().toLowerCase().email().max(320),
  action:        z.enum(['allow', 'block']),
});

module.exports = { upsertAllowedSenderSchema };
