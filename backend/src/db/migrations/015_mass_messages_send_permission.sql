-- Add mass_messages.send permission and grant to owner/manager
INSERT INTO permissions (slug, name, category, description)
VALUES (
  'mass_messages.send',
  'Send Mass Messages',
  'App',
  'Send and manage Maloum mass messages (Managers and above)'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager')
  AND p.slug = 'mass_messages.send'
ON CONFLICT DO NOTHING;
