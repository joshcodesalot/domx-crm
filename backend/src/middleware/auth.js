const jwt = require('jsonwebtoken');
const { getUserPermissions, getUserById } = require('../services/rbac');

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
]);

function isPasswordChangeAllowed(req) {
  const fullPath = `${req.baseUrl}${req.path}`;
  return PASSWORD_CHANGE_ALLOWED_PATHS.has(fullPath);
}

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await getUserById(payload.id);

    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (user.mustChangePassword && !isPasswordChangeAllowed(req)) {
      return res.status(403).json({
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }

    const permissions = await getUserPermissions(payload.id);

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      roleName: user.roleName,
      roleRank: user.roleRank,
      mustChangePassword: user.mustChangePassword,
      permissions,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticate };
