const pool = require('./pool');

const ROLES = [
  { slug: 'owner', name: 'Owner', rank: 1 },
  { slug: 'manager', name: 'Manager', rank: 2 },
  { slug: 'backend', name: 'Backend', rank: 3 },
  { slug: 'team_leader', name: 'Team Leader', rank: 4 },
  { slug: 'chatter', name: 'Chatter', rank: 5 },
];

const PERMISSIONS = [
  { slug: 'dashboard.view', name: 'View Dashboard', category: 'App', description: 'Access the dashboard overview' },
  { slug: 'analytics.view', name: 'View Analytics', category: 'App', description: 'Access team analytics pages (Managers and above)' },
  { slug: 'analytics.self', name: 'View Own Analytics', category: 'App', description: 'Access personal performance charts and metrics' },
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
  { slug: 'mass_messages.send', name: 'Send Mass Messages', category: 'App', description: 'Send and manage Maloum mass messages (Managers and above)' },
  { slug: 'fan_scraper.use', name: 'Use Fan Scraper', category: 'App', description: 'Run Maloum and 4based fan scraper jobs (Managers and above)' },
  { slug: 'vault.notes.edit', name: 'Edit Vault Media Notes', category: 'App', description: 'Create and edit notes on vault images and videos (Team Leaders and above)' },
  { slug: 'scripts.manage', name: 'Manage Chat Scripts', category: 'App', description: 'Create, edit, and remove chat scripts and folders (Managers and above)' },
  { slug: 'moderation.manage', name: 'Manage Keyword Rules', category: 'App', description: 'Create, edit, and remove keyword moderation rules (Managers and above)' },
  { slug: 'moderation.review', name: 'Review Moderation Events', category: 'App', description: 'View and resolve keyword moderation review queue (Managers and above)' },
  { slug: 'ai.settings.manage', name: 'Manage AI Settings', category: 'AI', description: 'View and change per-creator AI chatter mode and pause' },
  { slug: 'ai.suggest.use', name: 'Use AI Suggestions', category: 'AI', description: 'Request and view AI draft replies' },
  { slug: 'ai.moderate', name: 'Moderate AI Chatter', category: 'AI', description: 'Watch the AI review queue and take over conversations' },
  { slug: 'ai.rules.manage', name: 'Manage AI Rules', category: 'AI', description: 'Create and approve global or per-creator AI rules' },
  { slug: 'ai.autosend.enable', name: 'Enable AI Auto-Send', category: 'AI', description: 'Allow auto-send modes for creators (Managers and above)' },
];

const DEFAULT_MATRIX = {
  owner: [
    'dashboard.view', 'analytics.view', 'analytics.self', 'creators.view', 'creators.manage',
    'staff.view', 'staff.create', 'staff.edit', 'staff.deactivate', 'staff.delete', 'staff.assign_role',
    'roles.view', 'roles.manage',
    'mass_messages.send',
    'fan_scraper.use',
    'vault.notes.edit',
    'scripts.manage',
    'moderation.manage',
    'moderation.review',
    'ai.settings.manage',
    'ai.suggest.use',
    'ai.moderate',
    'ai.rules.manage',
    'ai.autosend.enable',
  ],
  manager: [
    'dashboard.view', 'analytics.view', 'analytics.self', 'creators.view', 'creators.manage',
    'staff.view', 'staff.create', 'staff.edit', 'staff.deactivate', 'staff.delete', 'staff.assign_role',
    'roles.view', 'roles.manage',
    'mass_messages.send',
    'fan_scraper.use',
    'vault.notes.edit',
    'scripts.manage',
    'moderation.manage',
    'moderation.review',
    'ai.settings.manage',
    'ai.suggest.use',
    'ai.moderate',
    'ai.rules.manage',
    'ai.autosend.enable',
  ],
  backend: [
    'dashboard.view', 'analytics.view', 'analytics.self', 'creators.view',
    'staff.view',
    'mass_messages.send',
    'vault.notes.edit',
    'scripts.manage',
  ],
  team_leader: [
    'dashboard.view', 'analytics.view', 'analytics.self', 'creators.view',
    'staff.view',
    'vault.notes.edit',
  ],
  chatter: ['dashboard.view', 'analytics.self', 'creators.view'],
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

    await db.query(
      `DELETE FROM role_permissions
       WHERE "roleId" = $1
         AND "permissionId" IN (
           SELECT id FROM permissions WHERE slug = ANY($2::text[])
         )`,
      [roleId, permissionSlugs]
    );

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
