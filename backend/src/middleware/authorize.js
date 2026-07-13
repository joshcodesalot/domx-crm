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

module.exports = { requirePermission };
