const express = require('express');
const { authenticate } = require('../middleware/auth');
const { subscribe, unsubscribe } = require('../services/userEventBus');

const router = express.Router();

router.get('/stream', authenticate, (req, res) => {
  const userId = req.user.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  subscribe(userId, res);

  req.on('close', () => {
    unsubscribe(userId, res);
  });
});

module.exports = router;
