-- Backend ops: mass messages + scripts, without creator admin.
-- Split Fan Scraper off mass_messages.send so Backend does not inherit it.

INSERT INTO permissions (slug, name, category, description)
VALUES (
  'fan_scraper.use',
  'Use Fan Scraper',
  'App',
  'Run Maloum and 4based fan scraper jobs (Managers and above)'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager')
  AND p.slug = 'fan_scraper.use'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug = 'backend'
  AND p.slug IN ('mass_messages.send', 'scripts.manage')
ON CONFLICT DO NOTHING;
