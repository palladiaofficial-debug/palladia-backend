'use strict';
const { z } = require('zod');

const upsertAllowedSenderSchema = z.object({
  email_address: z.string().trim().toLowerCase().email().max(320),
  action:        z.enum(['allow', 'block']),
});

const delegateInstructionsSchema = z.object({
  delegate_email: z.string().trim().toLowerCase().email().max(320),
  provider_key:   z.enum(['aruba', 'legalmail', 'namirial', 'gmail', 'outlook']),
});

module.exports = { upsertAllowedSenderSchema, delegateInstructionsSchema };
