const pool = require('../db/pool');

const OWNER_ROLE_SLUG = 'owner';
const PROTECTED_OWNER_PERMISSION = 'roles.manage';

async function getRoleBySlug(slug) {
  const result = await pool.query(
    'SELECT id, slug, name, rank FROM roles WHERE slug = $1',
    [slug]
  );
  return result.rows[0] || null;
}

async function getAllRoles() {
  const result = await pool.query(
    'SELECT id, slug, name, rank FROM roles ORDER BY rank ASC'
  );
  return result.rows;
}

async function getRoleRank(slug) {
  const role = await getRoleBySlug(slug);
  return role ? role.rank : null;
}

async function getPermissionsForRole(slug) {
  const result = await pool.query(
    `SELECT p.slug
     FROM permissions p
     INNER JOIN role_permissions rp ON rp."permissionId" = p.id
     INNER JOIN roles r ON r.id = rp."roleId"
     WHERE r.slug = $1
     ORDER BY p.category, p.slug`,
    [slug]
  );
  return result.rows.map((row) => row.slug);
}

async function getUserPermissions(userId) {
  const result = await pool.query(
    `SELECT p.slug
     FROM users u
     INNER JOIN roles r ON r.slug = u.role
     INNER JOIN role_permissions rp ON rp."roleId" = r.id
     INNER JOIN permissions p ON p.id = rp."permissionId"
     WHERE u.id = $1
     ORDER BY p.category, p.slug`,
    [userId]
  );
  return result.rows.map((row) => row.slug);
}

async function getUserById(userId) {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.status,
            u."mustChangePassword",
            r.name AS "roleName", r.rank AS "roleRank"
     FROM users u
     LEFT JOIN roles r ON r.slug = u.role
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getAllPermissions() {
  const result = await pool.query(
    `SELECT id, slug, name, category, description
     FROM permissions
     ORDER BY category, slug`
  );
  return result.rows;
}

async function getRolesWithPermissions() {
  const roles = await getAllRoles();
  const rolesWithPerms = await Promise.all(
    roles.map(async (role) => ({
      ...role,
      permissions: await getPermissionsForRole(role.slug),
    }))
  );
  return rolesWithPerms;
}

async function countActiveOwners(excludeUserId = null) {
  let query = `SELECT COUNT(*)::int AS count
               FROM users
               WHERE role = $1 AND status = 'active'`;
  const params = [OWNER_ROLE_SLUG];

  if (excludeUserId) {
    query += ' AND id != $2';
    params.push(excludeUserId);
  }

  const result = await pool.query(query, params);
  return result.rows[0].count;
}

async function canManageUser(actor, targetUserId, newRoleSlug = null) {
  const target = await getUserById(targetUserId);
  if (!target) {
    return { allowed: false, reason: 'User not found' };
  }

  const actorRank = actor.roleRank ?? (await getRoleRank(actor.role));
  const targetRank = target.roleRank ?? (await getRoleRank(target.role));

  if (targetRank < actorRank) {
    return { allowed: false, reason: 'Cannot manage users with higher privilege' };
  }

  if (newRoleSlug) {
    const newRoleRank = await getRoleRank(newRoleSlug);
    if (newRoleRank === null) {
      return { allowed: false, reason: 'Invalid role' };
    }
    if (newRoleRank < actorRank) {
      return { allowed: false, reason: 'Cannot assign a role above your own privilege' };
    }
    if (target.role === OWNER_ROLE_SLUG && newRoleSlug !== OWNER_ROLE_SLUG) {
      const otherOwners = await countActiveOwners(targetUserId);
      if (otherOwners === 0) {
        return { allowed: false, reason: 'Cannot demote the last active Owner' };
      }
    }
  }

  return { allowed: true };
}

async function canDeactivateUser(actor, targetUserId) {
  const target = await getUserById(targetUserId);
  if (!target) {
    return { allowed: false, reason: 'User not found' };
  }

  if (actor.id === targetUserId) {
    return { allowed: false, reason: 'Cannot deactivate your own account' };
  }

  const check = await canManageUser(actor, targetUserId);
  if (!check.allowed) return check;

  if (target.role === OWNER_ROLE_SLUG) {
    const otherOwners = await countActiveOwners(targetUserId);
    if (otherOwners === 0) {
      return { allowed: false, reason: 'Cannot deactivate the last active Owner' };
    }
  }

  return { allowed: true };
}

async function canDeleteUser(actor, targetUserId) {
  const target = await getUserById(targetUserId);
  if (!target) {
    return { allowed: false, reason: 'User not found' };
  }

  if (actor.id === targetUserId) {
    return { allowed: false, reason: 'Cannot delete your own account' };
  }

  const check = await canManageUser(actor, targetUserId);
  if (!check.allowed) return check;

  if (target.role === OWNER_ROLE_SLUG) {
    const otherOwners = await countActiveOwners(targetUserId);
    if (otherOwners === 0) {
      return { allowed: false, reason: 'Cannot delete the last active Owner' };
    }
  }

  return { allowed: true };
}

async function updateRolePermissions(roleSlug, permissionSlugs) {
  const role = await getRoleBySlug(roleSlug);
  if (!role) {
    return { success: false, reason: 'Role not found' };
  }

  if (roleSlug === OWNER_ROLE_SLUG && !permissionSlugs.includes(PROTECTED_OWNER_PERMISSION)) {
    return { success: false, reason: 'Owner role must retain roles.manage permission' };
  }

  const permResult = await pool.query(
    'SELECT id, slug FROM permissions WHERE slug = ANY($1)',
    [permissionSlugs]
  );

  if (permResult.rows.length !== permissionSlugs.length) {
    return { success: false, reason: 'One or more invalid permission slugs' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM role_permissions WHERE "roleId" = $1', [role.id]);

    for (const perm of permResult.rows) {
      await client.query(
        `INSERT INTO role_permissions ("roleId", "permissionId")
         VALUES ($1, $2)`,
        [role.id, perm.id]
      );
    }

    await client.query('COMMIT');
    return { success: true, permissions: permissionSlugs };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function toSafeUser(row, permissions) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleName: row.roleName || row.role,
    status: row.status,
    permissions,
    mustChangePassword: row.mustChangePassword ?? false,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ipAddressLast: row.ipAddressLast,
  };
}

module.exports = {
  OWNER_ROLE_SLUG,
  PROTECTED_OWNER_PERMISSION,
  getRoleBySlug,
  getAllRoles,
  getRoleRank,
  getPermissionsForRole,
  getUserPermissions,
  getUserById,
  getAllPermissions,
  getRolesWithPermissions,
  canManageUser,
  canDeactivateUser,
  canDeleteUser,
  updateRolePermissions,
  toSafeUser,
};
