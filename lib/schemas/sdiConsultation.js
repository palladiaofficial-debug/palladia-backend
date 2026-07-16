'use strict';
const { z } = require('zod');

const connectSdiConsultationSchema = z.object({
  fiscal_id:            z.string().trim().min(11).max(16), // P.IVA (11) o Codice Fiscale (16)
  fisconline_username:  z.string().trim().min(11).max(16), // codice fiscale del titolare/delegato Fisconline
  fisconline_password:  z.string().min(1),
  fisconline_pin:       z.string().min(1),
});

module.exports = { connectSdiConsultationSchema };
