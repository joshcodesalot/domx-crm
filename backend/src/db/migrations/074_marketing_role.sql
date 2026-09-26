-- Marketing rank: only the Marketing page, and every other rank can open that page too.

INSERT INTO roles (slug, name, rank)
VALUES ('marketing', 'Marketing', 6)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, rank = EXCLUDED.rank;

INSERT INTO permissions (slug, name, category, description)
VALUES (
  'marketing.view',
  'View Marketing',
  'App',
  'Open creator browsers from the Marketing page'
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager', 'backend', 'team_leader', 'chatter', 'marketing')
  AND p.slug = 'marketing.view'
ON CONFLICT DO NOTHING;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'manager', 'backend', 'team_leader', 'chatter', 'marketing'));
