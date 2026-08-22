'use strict';
/**
 * routes/v1/invoiceChannels.js
 * Vista unica sui tre canali fatture fornitore — vedi services/invoiceChannels.js.
 *
 * GET /api/v1/expenses/invoice-channels — stato dei tre canali (JWT)
 */

const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { getInvoiceChannelsStatus } = require('../../services/invoiceChannels');

router.get('/expenses/invoice-channels', verifySupabaseJwt, async (req, res) => {
  try {
    const result = await getInvoiceChannelsStatus(req.companyId);
    res.json(result);
  } catch (err) {
    console.error('[invoice-channels] status error:', err.message);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
