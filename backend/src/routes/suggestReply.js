const express = require('express');
const { authenticate } = require('../middleware/auth');
const { suggestReply } = require('../services/suggestReply');

const router = express.Router();

const SUGGEST_ALLOWED_ROLES = new Set(['owner', 'manager']);

router.post('/', authenticate, async (req, res) => {
  try {
    if (!SUGGEST_ALLOWED_ROLES.has(req.user?.role)) {
      return res.status(403).json({
        error: 'Suggest reply is only available to managers and above',
      });
    }

    const { messages, fanNotes, fanNickname } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'messages array with at least one message is required',
      });
    }

    const result = await suggestReply({
      messages,
      fanNotes: typeof fanNotes === 'string' ? fanNotes : '',
      fanNickname: typeof fanNickname === 'string' ? fanNickname : '',
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
