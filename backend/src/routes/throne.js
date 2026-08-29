const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  listNotifications,
  unreadCount,
  markAllRead,
  claimNotification,
} = require('../services/throneWebhook');

const router = express.Router();

function canSeeWebhookUrl(user) {
  const role = user?.role;
  return role === 'owner' || role === 'manager';
}

function withoutWebhookUnlessManager(user, result) {
  if (!result || result.error || canSeeWebhookUrl(user)) return result;
  const { webhookUrl: _webhookUrl, ...rest } = result;
  return rest;
}

router.use(authenticate, requirePermission('creators.view'));

router.get('/notifications/unread-count', async (req, res) => {
  try {
    const result = await unreadCount();
    return res.json(withoutWebhookUnlessManager(req.user, result));
  } catch (err) {
    console.error('[throne] Unread count error:', err);
    return res.status(500).json({ error: 'Failed to load unread count' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const result = await listNotifications({
      limit: req.query.limit,
      before: req.query.before,
    });
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    return res.json(withoutWebhookUnlessManager(req.user, result));
  } catch (err) {
    console.error('[throne] List notifications error:', err);
    return res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.post('/notifications/read-all', async (_req, res) => {
  try {
    const result = await markAllRead();
    return res.json(result);
  } catch (err) {
    console.error('[throne] Mark read error:', err);
    return res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

router.post('/notifications/:id/claim', async (req, res) => {
  try {
    const result = await claimNotification(req.params.id, req.user);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[throne] Claim error:', err);
    return res.status(500).json({ error: 'Failed to take sale' });
  }
});

module.exports = router;
