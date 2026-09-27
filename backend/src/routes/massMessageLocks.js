const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator } = require('../services/creatorAccess');
const {
  listLocks,
  lockMessage,
  unlockMessage,
} = require('../services/massMessageLocks');

const router = express.Router();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

async function requireCreator(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid creator ID' });
    return null;
  }
  const allowed = await userCanAccessCreator(req.user, id);
  if (!allowed) {
    res.status(403).json({ error: 'You do not have access to this creator' });
    return null;
  }
  return id;
}

router.get('/:id/mass-message-locks', authenticate, async (req, res) => {
  try {
    const creatorId = await requireCreator(req, res);
    if (!creatorId) return undefined;
    const platform = req.query.platform ? String(req.query.platform) : null;
    const locks = await listLocks(creatorId, platform);
    return res.json({ locks });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('List mass message locks error:', err);
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
});

router.put(
  '/:id/mass-message-locks',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creatorId = await requireCreator(req, res);
      if (!creatorId) return undefined;
      const body = req.body || {};
      const lock = await lockMessage({
        creatorId,
        platform: body.platform,
        platformMessageId: body.platformMessageId,
        bodyText: body.bodyText,
        mediaIds: body.mediaIds,
        userId: req.user.id,
      });
      return res.json({ lock });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('Lock mass message error:', err);
      return res.status(status).json({ error: err.message || 'Internal server error' });
    }
  }
);

router.delete(
  '/:id/mass-message-locks',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creatorId = await requireCreator(req, res);
      if (!creatorId) return undefined;
      const body = req.body || {};
      const platformMessageId = body.platformMessageId || req.query.platformMessageId;
      const platform = body.platform || req.query.platform;
      await unlockMessage(creatorId, platform, platformMessageId);
      return res.json({ ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('Unlock mass message error:', err);
      return res.status(status).json({ error: err.message || 'Internal server error' });
    }
  }
);

module.exports = router;
