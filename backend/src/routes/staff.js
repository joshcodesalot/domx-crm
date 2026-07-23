const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  getAllRoles,
  getRoleRank,
  getUserById,
  canManageUser,
  canDeactivateUser,
  canDeleteUser,
  toSafeUser,
  getUserPermissions,
} = require('../services/rbac');
const { emitToUser } = require('../services/userEventBus');
const { generateTempPassword } = require('../services/passwordUtils');

const router = express.Router();

const VALID_STATUSES = ['active', 'inactive'];

function staffSelectQuery() {
  return `
    SELECT u.id, u.name, u.email, u.role, u.status,
           u."mustChangePassword",
           r.name AS "roleName",
           u."lastLoginAt", u."createdAt", u."updatedAt", u."ipAddressLast"
    FROM users u
    LEFT JOIN roles r ON r.slug = u.role
  `;
}

router.get('/', authenticate, requirePermission('staff.view'), async (_req, res) => {
  try {
    const result = await pool.query(
      `${staffSelectQuery()} ORDER BY u."createdAt" ASC`
    );

    const staff = await Promise.all(
      result.rows.map(async (row) => {
        const permissions = await getUserPermissions(row.id);
        return toSafeUser(row, permissions);
      })
    );

    res.json({ staff });
  } catch (err) {
    console.error('List staff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticate, requirePermission('staff.create'), async (req, res) => {
  const { name, email, role } = req.body;

  if (!name || !email || !role) {
    return res.status(400).json({ error: 'Name, email, and role are required' });
  }

  const roleRank = await getRoleRank(role);
  if (roleRank === null) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const actorRank = req.user.roleRank ?? (await getRoleRank(req.user.role));
  if (roleRank < actorRank) {
    return res.status(403).json({ error: 'Cannot assign a role above your own privilege' });
  }

  try {
    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, "passwordHash", role, status, "mustChangePassword")
       VALUES ($1, $2, $3, $4, 'active', true)
       RETURNING id, name, email, role, status, "mustChangePassword",
                 "lastLoginAt", "createdAt", "updatedAt", "ipAddressLast"`,
      [name, email, passwordHash, role]
    );

    const row = result.rows[0];
    const roleInfo = await getUserById(row.id);
    const permissions = await getUserPermissions(row.id);

    res.status(201).json({
      user: toSafeUser({ ...row, roleName: roleInfo?.roleName }, permissions),
      tempPassword,
    });
  } catch (err) {
    console.error('Create staff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/reset-password', authenticate, requirePermission('staff.edit'), async (req, res) => {
  const { id } = req.params;

  if (req.user.id === id) {
    return res.status(403).json({ error: 'Cannot reset your own password' });
  }

  try {
    const actor = await getUserById(req.user.id);
    const check = await canManageUser(actor, id);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    await pool.query(
      `UPDATE users
       SET "passwordHash" = $1,
           "mustChangePassword" = true,
           "updatedAt" = NOW()
       WHERE id = $2`,
      [passwordHash, id]
    );

    const updated = await pool.query(`${staffSelectQuery()} WHERE u.id = $1`, [id]);
    const permissions = await getUserPermissions(id);

    res.json({
      user: toSafeUser(updated.rows[0], permissions),
      tempPassword,
    });
  } catch (err) {
    console.error('Reset staff password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', authenticate, requirePermission('staff.edit'), async (req, res) => {
  const { id } = req.params;
  const { name, status } = req.body;

  if (!name && !status) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const actor = await getUserById(req.user.id);
    const check = await canManageUser(actor, id);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    updates.push(`"updatedAt" = NOW()`);
    values.push(id);

    const existing = await pool.query('SELECT id, status FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const previousStatus = existing.rows[0].status;

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    const updated = await pool.query(`${staffSelectQuery()} WHERE u.id = $1`, [id]);
    const permissions = await getUserPermissions(id);

    if (status === 'inactive' && previousStatus !== 'inactive') {
      emitToUser(id, { type: 'account:deactivated' });
    }

    res.json({ user: toSafeUser(updated.rows[0], permissions) });
  } catch (err) {
    console.error('Update staff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/role', authenticate, requirePermission('staff.assign_role'), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).json({ error: 'Role is required' });
  }

  try {
    const actor = await getUserById(req.user.id);
    const check = await canManageUser(actor, id, role);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const result = await pool.query(
      `UPDATE users SET role = $1, "updatedAt" = NOW() WHERE id = $2
       RETURNING id`,
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updated = await pool.query(`${staffSelectQuery()} WHERE u.id = $1`, [id]);
    const permissions = await getUserPermissions(id);

    res.json({ user: toSafeUser(updated.rows[0], permissions) });
  } catch (err) {
    console.error('Assign role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/deactivate', authenticate, requirePermission('staff.deactivate'), async (req, res) => {
  const { id } = req.params;

  try {
    const actor = await getUserById(req.user.id);
    const check = await canDeactivateUser(actor, id);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const result = await pool.query(
      `UPDATE users SET status = 'inactive', "updatedAt" = NOW() WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updated = await pool.query(`${staffSelectQuery()} WHERE u.id = $1`, [id]);
    const permissions = await getUserPermissions(id);

    emitToUser(id, { type: 'account:deactivated' });

    res.json({ user: toSafeUser(updated.rows[0], permissions) });
  } catch (err) {
    console.error('Deactivate staff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/activate', authenticate, requirePermission('staff.deactivate'), async (req, res) => {
  const { id } = req.params;

  try {
    const actor = await getUserById(req.user.id);
    const check = await canManageUser(actor, id);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const result = await pool.query(
      `UPDATE users SET status = 'active', "updatedAt" = NOW() WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updated = await pool.query(`${staffSelectQuery()} WHERE u.id = $1`, [id]);
    const permissions = await getUserPermissions(id);

    res.json({ user: toSafeUser(updated.rows[0], permissions) });
  } catch (err) {
    console.error('Activate staff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticate, requirePermission('staff.delete'), async (req, res) => {
  const { id } = req.params;

  try {
    const actor = await getUserById(req.user.id);
    const check = await canDeleteUser(actor, id);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    emitToUser(id, { type: 'account:deleted' });

    res.json({ message: 'Staff member deleted successfully' });
  } catch (err) {
    console.error('Delete staff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/roles', authenticate, requirePermission('staff.view'), async (req, res) => {
  try {
    const actorRank = req.user.roleRank ?? (await getRoleRank(req.user.role));
    const roles = await getAllRoles();
    const assignableRoles = roles.filter((role) => role.rank >= actorRank);

    res.json({ roles: assignableRoles });
  } catch (err) {
    console.error('List assignable roles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
