const fs = require('fs');
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  BrowserProfileError,
  isUuid,
  hostSecretOk,
  openBrowserProfile,
  heartbeatBrowserProfile,
  releaseBrowserProfile,
  closeBrowserProfile,
  getArchiveForDownload,
  saveArchive,
  sessionStatus,
  listBrowserProfiles,
  getBrowserProxy,
  updateBrowserProxy,
} = require('../services/browserProfiles');

const router = express.Router();
const canViewBrowser = requirePermission('creators.view', 'marketing.view');

function sendError(res, err) {
  if (!(err instanceof BrowserProfileError)) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
  return res.status(err.status || 400).json({
    error: err.message,
    code: err.code,
    lockedByName: err.lockedByName,
  });
}

function viewTokenFrom(req) {
  const header = req.get('x-domx-view-token');
  if (header) return header;
  return typeof req.body?.viewToken === 'string' ? req.body.viewToken : '';
}

router.get('/', authenticate, canViewBrowser, async (req, res) => {
  try {
    const profiles = await listBrowserProfiles(req.user);
    return res.json({ profiles });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get(
  '/:creatorId/proxy',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    try {
      const proxy = await getBrowserProxy(req.user, req.params.creatorId);
      return res.json(proxy);
    } catch (err) {
      return sendError(res, err);
    }
  }
);

router.put(
  '/:creatorId/proxy',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    try {
      const result = await updateBrowserProxy(req.user, req.params.creatorId, req.body);
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  }
);

router.post(
  '/:creatorId/open',
  authenticate,
  canViewBrowser,
  async (req, res) => {
    try {
      const opened = await openBrowserProfile(
        req.user,
        req.params.creatorId,
        req.body?.platform,
        req
      );
      return res.json(opened);
    } catch (err) {
      return sendError(res, err);
    }
  }
);

router.post(
  '/:creatorId/heartbeat',
  authenticate,
  canViewBrowser,
  async (req, res) => {
    try {
      const result = await heartbeatBrowserProfile(
        req.user,
        req.params.creatorId,
        viewTokenFrom(req)
      );
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  }
);

router.post(
  '/:creatorId/close',
  authenticate,
  canViewBrowser,
  async (req, res) => {
    try {
      const token = viewTokenFrom(req);
      const result = req.body?.releaseOnly
        ? await releaseBrowserProfile(req.user, req.params.creatorId, token)
        : await closeBrowserProfile(req.user, req.params.creatorId, token);
      return res.json(result);
    } catch (err) {
      return sendError(res, err);
    }
  }
);

router.get('/:creatorId/session', async (req, res) => {
  try {
    if (!hostSecretOk(req.get('x-domx-host-secret'))) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const status = await sessionStatus(
      req.params.creatorId,
      viewTokenFrom(req),
      req.get('x-domx-profile-generation')
    );
    return res.json(status);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get(
  '/:creatorId/archive',
  async (req, res, next) => {
    const host = hostSecretOk(req.get('x-domx-host-secret'));
    if (!host) {
      return authenticate(req, res, () =>
        canViewBrowser(req, res, () => next())
      );
    }
    return next();
  },
  async (req, res) => {
    try {
      const host = hostSecretOk(req.get('x-domx-host-secret'));
      const file = await getArchiveForDownload(req.params.creatorId, {
        host,
        user: req.user,
        viewToken: viewTokenFrom(req),
      });
      if (!file) return res.status(204).end();
      res.setHeader('Content-Type', 'application/zip');
      const stream = fs.createReadStream(file);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        } else {
          res.destroy();
        }
      });
      return stream.pipe(res);
    } catch (err) {
      return sendError(res, err);
    }
  }
);

function ensureViewer(req, res) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      finish(false);
      return sendJson(body);
    };
    authenticate(req, res, () => {
      canViewBrowser(req, res, () => finish(true));
    });
  });
}

async function uploadBrowserProfileArchive(req, res) {
  try {
    const host = hostSecretOk(req.get('x-domx-host-secret'));
    if (!host) {
      const allowed = await ensureViewer(req, res);
      if (!allowed) return;
    }
    if (!isUuid(req.params.creatorId)) {
      return res.status(404).json({ error: 'Creator not found' });
    }
    const result = await saveArchive(req.params.creatorId, {
      viewToken: viewTokenFrom(req),
      generation: req.get('x-domx-profile-generation'),
      bytes: req.body,
      user: req.user,
      host,
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}

module.exports = router;
module.exports.uploadBrowserProfileArchive = uploadBrowserProfileArchive;
