'use strict';
const { z } = require('zod');

const nullableStr = (max = 200) => z.string().trim().max(max).nullable().optional();

// POST /marketplace/providers/register — candidatura ente formatore (pubblico)
const registerProviderSchema = z.object({
  name:                  z.string().trim().min(1).max(200),
  email:                 z.string().trim().email('email non valida').max(200),
  phone:                 nullableStr(30),
  location_city:         z.string().trim().min(1).max(100),
  location_province:     z.string().trim().min(1).max(100),
  address:               nullableStr(300),
  website:               z.string().trim().url('URL non valido').nullable().optional(),
  description:           z.string().trim().max(2000).nullable().optional(),
  accreditation_code:    nullableStr(100),
  accreditation_region:  nullableStr(100),
  notes:                 z.string().trim().max(2000).nullable().optional(),
}).strip();

module.exports = { registerProviderSchema };
