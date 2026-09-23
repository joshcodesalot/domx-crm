const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator } = require('../services/creatorAccess');
const { loadMaloumCreator } = require('../services/platformCreatorSession');
const commentGuard = require('../services/maloumCommentGuard');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

async function ensureAccess(req, res, creatorId) {
  if (!isValidUuid(creatorId)) {
    res.status(400).json({ error: 'Invalid creator ID' });
    return null;
  }
  const allowed = await userCanAccessCreator(req.user, creatorId);
  if (!allowed) {
    res.status(403).json({ error: 'You do not have access to this creator' });
    return null;
  }
  const loaded = await loadMaloumCreator(creatorId);
  if (loaded.error) {
    res.status(loaded.error.status).json({ error: loaded.error.message });
    return null;
  }
  return loaded;
}

router.get(
  '/:id/maloum/comment-guard',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const loaded = await ensureAccess(req, res, req.params.id);
      if (!loaded) return;
      const settings = await commentGuard.getSettings(loaded.creator.id);
      return res.json({ settings });
    } catch (err) {
      console.error('Get comment guard settings error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/:id/maloum/comment-guard',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const loaded = await ensureAccess(req, res, req.params.id);
      if (!loaded) return;
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const settings = await commentGuard.setEnabled(
        loaded.creator.id,
        req.body.enabled
      );
      return res.json({ settings });
    } catch (err) {
      console.error('Update comment guard settings error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/maloum/comment-guard/events',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const loaded = await ensureAccess(req, res, req.params.id);
      if (!loaded) return;
      const events = await commentGuard.listEvents(
        loaded.creator.id,
        req.query.limit
      );
      return res.json({ events });
    } catch (err) {
      console.error('List comment guard events error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/comment-guard/run',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const loaded = await ensureAccess(req, res, req.params.id);
      if (!loaded) return;
      const summary = await commentGuard.scanCreator(loaded.creator.id);
      const settings = await commentGuard.getSettings(loaded.creator.id);
      return res.json({ settings, summary });
    } catch (err) {
      if (err?.status === 409) {
        return res.status(409).json({ error: err.message });
      }
      console.error('Run comment guard error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/comment-guard/block',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const loaded = await ensureAccess(req, res, req.params.id);
      if (!loaded) return;
      const memberId = String(req.body?.memberId || '').trim();
      if (!memberId) {
        return res.status(400).json({ error: 'memberId is required' });
      }
      const result = await commentGuard.blockAndRecord(loaded.creator, {
        memberId,
        postId: req.body?.postId,
        commentId: req.body?.commentId,
        username: req.body?.username,
        commentText: req.body?.commentText,
        matchedTerm: req.body?.matchedTerm,
      });
      return res.json({
        ok: true,
        alreadyBlocked: result.alreadyBlocked,
        event: result.event,
      });
    } catch (err) {
      if (err?.status === 400) {
        return res.status(400).json({ error: err.message });
      }
      const status = err?.status >= 400 && err.status < 600 ? err.status : 502;
      return res.status(status === 401 ? 502 : status).json({
        error: err?.message || 'Block failed',
        event: err?.event || null,
      });
    }
  }
);

module.exports = router;
