-- Add Backend rank between Manager and Team Leader; allow Managers to edit the permission matrix.

-- Re-rank existing roles so Backend can sit at rank 3
UPDATE roles SET rank = 4 WHERE slug = 'team_leader';
UPDATE roles SET rank = 5 WHERE slug = 'chatter';
UPDATE roles SET rank = 2 WHERE slug = 'manager';
UPDATE roles SET rank = 1 WHERE slug = 'owner';

INSERT INTO roles (slug, name, rank)
VALUES ('backend', 'Backend', 3)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, rank = EXCLUDED.rank;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'manager', 'backend', 'team_leader', 'chatter'));

-- Grant Managers permission to edit the role permission matrix
INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug = 'manager'
  AND p.slug = 'roles.manage'
ON CONFLICT DO NOTHING;

-- Seed Backend with the same permissions as Team Leader currently has
INSERT INTO role_permissions ("roleId", "permissionId")
SELECT backend.id, rp."permissionId"
FROM roles backend
CROSS JOIN roles team_leader
INNER JOIN role_permissions rp ON rp."roleId" = team_leader.id
WHERE backend.slug = 'backend'
  AND team_leader.slug = 'team_leader'
ON CONFLICT DO NOTHING;
