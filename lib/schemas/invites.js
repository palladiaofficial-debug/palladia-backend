'use strict';
const { z } = require('zod');

// POST /invites
const createInviteSchema = z.object({
  email: z.string().trim().email('email non valida').max(200),
  role:  z.enum(['admin', 'tech', 'viewer']),
});

module.exports = { createInviteSchema };
