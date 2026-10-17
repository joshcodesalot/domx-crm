const express = require('express');
const { authenticate } = require('../middleware/auth');
const { translateTextForPlatform } = require('../services/googleTranslate');

const router = express.Router();

router.post('/', authenticate, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) {
      return res.status(400).json({ error: 'Missing text' });
    }

    const translatedText = await translateTextForPlatform(text, req.body?.platform);
    if (!translatedText) {
      return res.status(500).json({ error: 'Translation returned empty text' });
    }

    return res.json({ translatedText });
  } catch (error) {
    console.error('Google English translation failed:', error);
    return res.status(500).json({ error: 'Translation failed' });
  }
});

module.exports = router;
