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
const {
  loadSchedulesByUserId,
  parseScheduleDaysPayload,
  formatTimeShort,
  isOvernight,
} = require('../services/workSchedule');

const router = express.Router();

const VALID_STATUSES = ['active', 'inactive'];

const CREATOR_ASSIGNABLE_ROLES = ['chatter', 'team_leader'];

function staffSelectQuery() {
  return `
    SELECT u.id, u.name, u.email, u.role, u.status,
           u."mustChangePassword",
           u.timezone,
           r.name AS "roleName",
           u."lastLoginAt", u."createdAt", u."updatedAt", u."ipAddressLast",
           COALESCE(a."creatorCount", 0)::int AS "creatorCount"
    FROM users u
    LEFT JOIN roles r ON r.slug = u.role
    LEFT JOIN (
      SELECT "userId", COUNT(*)::int AS "creatorCount"
      FROM creator_staff_assignments
      GROUP BY "userId"
    ) a ON a."userId" = u.id
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

router.get(
  '/:id/schedule',
  authenticate,
  requirePermission('staff.view'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const staffMember = await getUserById(id);
      if (!staffMember) {
        return res.status(404).json({ error: 'User not found' });
      }

      const byUser = await loadSchedulesByUserId([id]);
      const week = byUser.get(id);
      const days = week
        ? [...week.values()]
            .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
            .map((d) => ({
              dayOfWeek: d.dayOfWeek,
              startTime: formatTimeShort(d.startTime),
              endTime: formatTimeShort(d.endTime),
              overnight: isOvernight(d.startTime, d.endTime),
            }))
        : [];

      res.json({
        userId: id,
        timeZone: 'Europe/Berlin',
        days,
      });
    } catch (err) {
      console.error('Get staff schedule error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/:id/schedule',
  authenticate,
  requirePermission('staff.edit'),
  async (req, res) => {
    const { id } = req.params;
    const parsed = parseScheduleDaysPayload(req.body?.days);

    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const actor = await getUserById(req.user.id);
      const check = await canManageUser(actor, id);
      if (!check.allowed) {
        return res.status(403).json({ error: check.reason });
      }

      const staffMember = await getUserById(id);
      if (!staffMember) {
        return res.status(404).json({ error: 'User not found' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM user_work_schedules WHERE "userId" = $1`, [id]);

        for (const day of parsed.days) {
          await client.query(
            `INSERT INTO user_work_schedules ("userId", "dayOfWeek", "startTime", "endTime")
             VALUES ($1, $2, $3::time, $4::time)`,
            [id, day.dayOfWeek, day.startTime, day.endTime]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const days = parsed.days.map((d) => ({
        dayOfWeek: d.dayOfWeek,
        startTime: formatTimeShort(d.startTime),
        endTime: formatTimeShort(d.endTime),
        overnight: isOvernight(d.startTime, d.endTime),
      }));

      res.json({
        userId: id,
        timeZone: 'Europe/Berlin',
        days,
      });
    } catch (err) {
      console.error('Update staff schedule error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/creators',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const staffMember = await getUserById(id);
      if (!staffMember) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (!CREATOR_ASSIGNABLE_ROLES.includes(staffMember.role)) {
        return res.status(400).json({
          error: 'Creators can only be assigned to chatters and team leaders',
        });
      }

      const result = await pool.query(
        `SELECT c.id, c."displayName", c.username, c.platform, c."connectionStatus",
                c."avatarUrl", c."avatarSource", a."assignedAt"
         FROM creator_staff_assignments a
         INNER JOIN creators c ON c.id = a."creatorId"
         WHERE a."userId" = $1
         ORDER BY c."displayName" ASC`,
        [id]
      );

      res.json({ creators: result.rows });
    } catch (err) {
      console.error('List staff creators error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/:id/creators',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    const { creatorIds } = req.body;

    if (!Array.isArray(creatorIds)) {
      return res.status(400).json({ error: 'creatorIds must be an array' });
    }

    const uniqueCreatorIds = [...new Set(creatorIds.filter((value) => typeof value === 'string'))];

    try {
      const staffMember = await getUserById(id);
      if (!staffMember) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (!CREATOR_ASSIGNABLE_ROLES.includes(staffMember.role)) {
        return res.status(400).json({
          error: 'Creators can only be assigned to chatters and team leaders',
        });
      }

      if (uniqueCreatorIds.length > 0) {
        const creatorsResult = await pool.query(
          'SELECT id FROM creators WHERE id = ANY($1::uuid[])',
          [uniqueCreatorIds]
        );
        if (creatorsResult.rows.length !== uniqueCreatorIds.length) {
          return res.status(400).json({ error: 'One or more creator IDs are invalid' });
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await client.query(
          `SELECT "creatorId" FROM creator_staff_assignments WHERE "userId" = $1`,
          [id]
        );
        const existingIds = new Set(existing.rows.map((row) => row.creatorId));
        const desiredIds = new Set(uniqueCreatorIds);

        const toAdd = uniqueCreatorIds.filter((creatorId) => !existingIds.has(creatorId));
        const toRemove = [...existingIds].filter((creatorId) => !desiredIds.has(creatorId));

        for (const creatorId of toAdd) {
          await client.query(
            `INSERT INTO creator_staff_assignments ("creatorId", "userId", "assignedBy")
             VALUES ($1, $2, $3)`,
            [creatorId, id, req.user.id]
          );
          await client.query(
            `UPDATE creators
             SET "staffCount" = "staffCount" + 1, "updatedAt" = NOW()
             WHERE id = $1`,
            [creatorId]
          );
        }

        for (const creatorId of toRemove) {
          const deleted = await client.query(
            `DELETE FROM creator_staff_assignments
             WHERE "creatorId" = $1 AND "userId" = $2
             RETURNING id`,
            [creatorId, id]
          );
          if (deleted.rows.length > 0) {
            await client.query(
              `UPDATE creators
               SET "staffCount" = GREATEST("staffCount" - 1, 0), "updatedAt" = NOW()
               WHERE id = $1`,
              [creatorId]
            );
          }
        }

        await client.query('COMMIT');

        const changedIds = [...new Set([...toAdd, ...toRemove])];
        let creatorMetaById = new Map();
        if (changedIds.length > 0) {
          const metaResult = await pool.query(
            `SELECT id, "displayName", "accountId" FROM creators WHERE id = ANY($1::uuid[])`,
            [changedIds]
          );
          creatorMetaById = new Map(metaResult.rows.map((row) => [row.id, row]));
        }

        for (const creatorId of toAdd) {
          const creator = creatorMetaById.get(creatorId);
          if (!creator) continue;
          emitToUser(id, {
            type: 'creator:access-granted',
            creatorId: creator.id,
            accountId: creator.accountId || null,
            displayName: creator.displayName,
          });
        }

        for (const creatorId of toRemove) {
          const creator = creatorMetaById.get(creatorId);
          if (!creator) continue;
          emitToUser(id, {
            type: 'creator:access-revoked',
            creatorId: creator.id,
            accountId: creator.accountId || null,
            displayName: creator.displayName,
          });
        }

        const result = await pool.query(
          `SELECT c.id, c."displayName", c.username, c.platform, c."connectionStatus",
                  c."avatarUrl", c."avatarSource", a."assignedAt"
           FROM creator_staff_assignments a
           INNER JOIN creators c ON c.id = a."creatorId"
           WHERE a."userId" = $1
           ORDER BY c."displayName" ASC`,
          [id]
        );

        res.json({ creators: result.rows });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Set staff creators error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

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
