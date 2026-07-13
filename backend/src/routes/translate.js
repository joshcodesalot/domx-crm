const express = require('express');
const { translateToGermanFemdom } = require('../services/germanTranslator');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { text, history } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: 'Missing text',
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
