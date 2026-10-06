const express = require('express');
const { authenticate } = require('../middleware/auth');
const { translateToGermanFemdom } = require('../services/germanTranslator');
const { skipsGermanTranslation } = require('../services/germanTranslationPolicy');

const router = express.Router();

router.post('/', authenticate, async (req, res) => {
  try {
    const { text, history } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: 'Missing text',
      });
    }

    if (skipsGermanTranslation(req.body.platform)) {
      return res.json({
        translatedText: String(text).trim(),
      });
    }

    const translatedText = await translateToGermanFemdom(text, history);

    if (!translatedText) {
      return res.status(500).json({
        error: 'Translation returned empty text',
      });
    }

    return res.json({
      translatedText,
    });
  } catch (error) {
    console.error('xAI Grok German femdom translation failed:', error);

    return res.status(500).json({
      error: 'Translation failed',
    });
  }
});

module.exports = router;
