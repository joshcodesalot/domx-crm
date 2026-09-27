-- Marketing sits between Backend and Team Leader.
-- Only Owner, Manager, Backend, and Marketing keep the Marketing page.

UPDATE roles SET rank = 4 WHERE slug = 'marketing';
UPDATE roles SET rank = 5 WHERE slug = 'team_leader';
UPDATE roles SET rank = 6 WHERE slug = 'chatter';

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp."roleId" = r.id
  AND rp."permissionId" = p.id
  AND r.slug IN ('team_leader', 'chatter')
  AND p.slug = 'marketing.view';
