function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    const userPermissions = req.user?.permissions || [];

    const hasPermission = requiredPermissions.some((perm) =>
      userPermissions.includes(perm)
    );

    if (!hasPermission) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

function requireOwnerOrManager(req, res, next) {
  const role = req.user?.role;
  if (role === 'owner' || role === 'manager') return next();
  return res.status(403).json({ error: 'Owner or manager access required' });
}

module.exports = { requirePermission, requireOwnerOrManager };
