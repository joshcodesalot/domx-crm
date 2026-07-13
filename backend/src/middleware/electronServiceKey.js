function requireElectronServiceKey(req, res, next) {
  const expected = process.env.DOMX_ELECTRON_SERVICE_KEY;

  if (!expected) {
    return res.status(503).json({ error: 'Electron service key is not configured' });
  }

  const provided = req.headers['x-domx-service-key'];

  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = { requireElectronServiceKey };
