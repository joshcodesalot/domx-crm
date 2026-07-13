const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  getRolesWithPermissions,
  getAllPermissions,
  updateRolePermissions,
  getPermissionsForRole,
} = require('../services/rbac');

const router = express.Router();

router.get('/', authenticate, requirePermission('roles.view'), async (_req, res) => {
  try {
    const roles = await getRolesWithPermissions();
    res.json({ roles });
  } catch (err) {
    console.error('List roles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/permissions', authenticate, requirePermission('roles.view'), async (_req, res) => {
  try {
    const permissions = await getAllPermissions();
    res.json({ permissions });
  } catch (err) {
    console.error('List permissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:slug/permissions', authenticate, requirePermission('roles.manage'), async (req, res) => {
  const { slug } = req.params;
  const { permissionSlugs } = req.body;

  if (!Array.isArray(permissionSlugs)) {
    return res.status(400).json({ error: 'permissionSlugs must be an array' });
  }

  try {
    const result = await updateRolePermissions(slug, permissionSlugs);
    if (!result.success) {
      return res.status(400).json({ error: result.reason });
    }

    const permissions = await getPermissionsForRole(slug);
    res.json({ slug, permissions });
  } catch (err) {
    console.error('Update role permissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
