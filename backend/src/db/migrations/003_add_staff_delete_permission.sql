-- Add staff.delete permission and grant to owner/manager
INSERT INTO permissions (slug, name, category, description)
VALUES ('staff.delete', 'Delete Staff', 'Staff', 'Permanently delete staff accounts')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager')
  AND p.slug = 'staff.delete'
ON CONFLICT DO NOTHING;
