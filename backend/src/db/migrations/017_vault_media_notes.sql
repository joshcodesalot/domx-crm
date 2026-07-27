-- DomX-local notes on vault media (Maloum + 4Based)
CREATE TABLE IF NOT EXISTS vault_media_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "mediaKey" TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", platform, "mediaKey")
);

CREATE INDEX IF NOT EXISTS idx_vault_media_notes_creator_platform
  ON vault_media_notes ("creatorId", platform);

-- Edit permission for team leader and above
INSERT INTO permissions (slug, name, category, description)
VALUES (
  'vault.notes.edit',
  'Edit Vault Media Notes',
  'App',
  'Create and edit notes on vault images and videos (Team Leaders and above)'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager', 'team_leader')
  AND p.slug = 'vault.notes.edit'
ON CONFLICT DO NOTHING;
