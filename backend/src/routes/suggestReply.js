const express = require('express');
const { authenticate } = require('../middleware/auth');
const { suggestReply } = require('../services/suggestReply');

const router = express.Router();

router.post('/', authenticate, async (req, res) => {
  try {
    const { messages, fanNotes, fanName } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'messages array with at least one message is required',
      });
    }

    const result = await suggestReply({
      messages,
      fanNotes: typeof fanNotes === 'string' ? fanNotes : '',
      fanName: typeof fanName === 'string' ? fanName : '',
    });

    return res.json(result);
  } catch (error) {
    console.error('Suggest reply failed:', error);

    return res.status(500).json({
      error: error?.message || 'Suggest reply failed',
    });
  }
});

module.exports = router;
