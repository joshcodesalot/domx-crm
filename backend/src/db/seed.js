const pool = require('./pool');

const ROLES = [
  { slug: 'owner', name: 'Owner', rank: 1 },
  { slug: 'manager', name: 'Manager', rank: 2 },
  { slug: 'team_leader', name: 'Team Leader', rank: 3 },
  { slug: 'chatter', name: 'Chatter', rank: 4 },
];

const PERMISSIONS = [
  { slug: 'dashboard.view', name: 'View Dashboard', category: 'App', description: 'Access the dashboard overview' },
  { slug: 'analytics.view', name: 'View Analytics', category: 'App', description: 'Access analytics pages' },
  { slug: 'creators.view', name: 'View Creators', category: 'App', description: 'View creator listings' },
  { slug: 'creators.manage', name: 'Manage Creators', category: 'App', description: 'Create and edit creators' },
  { slug: 'staff.view', name: 'View Staff', category: 'Staff', description: 'View staff list' },
  { slug: 'staff.create', name: 'Create Staff', category: 'Staff', description: 'Add new staff members' },
  { slug: 'staff.edit', name: 'Edit Staff', category: 'Staff', description: 'Edit staff details' },
  { slug: 'staff.deactivate', name: 'Deactivate Staff', category: 'Staff', description: 'Deactivate staff accounts' },
  { slug: 'staff.delete', name: 'Delete Staff', category: 'Staff', description: 'Permanently delete staff accounts' },
  { slug: 'staff.assign_role', name: 'Assign Roles', category: 'Staff', description: 'Change staff role assignments' },
  { slug: 'roles.view', name: 'View Roles', category: 'RBAC', description: 'View roles and permission matrix' },
  { slug: 'roles.manage', name: 'Manage Roles', category: 'RBAC', description: 'Edit role permissions' },
];

const DEFAULT_MATRIX = {
  owner: [
    'dashboard.view', 'analytics.view', 'creators.view', 'creators.manage',
    'staff.view', 'staff.create', 'staff.edit', 'staff.deactivate', 'staff.delete', 'staff.assign_role',
    'roles.view', 'roles.manage',
  ],
  manager: [
    'dashboard.view', 'analytics.view', 'creators.view', 'creators.manage',
    'staff.view', 'staff.create', 'staff.edit', 'staff.deactivate', 'staff.delete', 'staff.assign_role',
    'roles.view',
  ],
  team_leader: [
    'dashboard.view', 'analytics.view', 'creators.view',
    'staff.view',
  ],
  chatter: ['dashboard.view', 'creators.view'],
};

async function seedRolesAndPermissions(db = pool) {
  for (const role of ROLES) {
    await db.query(
      `INSERT INTO roles (slug, name, rank)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, rank = EXCLUDED.rank`,
      [role.slug, role.name, role.rank]
    );
  }

  for (const perm of PERMISSIONS) {
    await db.query(
      `INSERT INTO permissions (slug, name, category, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description`,
      [perm.slug, perm.name, perm.category, perm.description]
    );
  }

  for (const [roleSlug, permissionSlugs] of Object.entries(DEFAULT_MATRIX)) {
    const roleResult = await db.query('SELECT id FROM roles WHERE slug = $1', [roleSlug]);
    const roleId = roleResult.rows[0].id;

    await db.query('DELETE FROM role_permissions WHERE "roleId" = $1', [roleId]);

    for (const permSlug of permissionSlugs) {
      const permResult = await db.query('SELECT id FROM permissions WHERE slug = $1', [permSlug]);
      if (permResult.rows.length === 0) continue;

      await db.query(
        `INSERT INTO role_permissions ("roleId", "permissionId")
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [roleId, permResult.rows[0].id]
      );
    }
  }

  console.log('Roles and permissions seeded.');
}

async function seed() {
  try {
    await seedRolesAndPermissions();
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  seed();
}

module.exports = { seedRolesAndPermissions };
