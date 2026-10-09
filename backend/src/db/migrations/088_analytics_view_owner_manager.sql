-- Messaging Analytics, Sales Logs, CRM Activity, and Login Activity
-- are owner/manager only. Drop analytics.view from every other role.

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp."roleId" = r.id
  AND rp."permissionId" = p.id
  AND r.slug NOT IN ('owner', 'manager')
  AND p.slug = 'analytics.view';
