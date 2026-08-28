const express = require('express');
const { ingestThroneWebhook } = require('../services/throneWebhook');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const timestamp = req.get('X-Signature-Timestamp');
    const signature = req.get('X-Signature-Ed25519');
    const result = await ingestThroneWebhook(req.body, timestamp, signature);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[throne] Webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
