-- Creator chat scripts (Maloum + 4Based): folders, scripts, per-fan sent tracking

CREATE TABLE IF NOT EXISTS creator_script_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  name TEXT NOT NULL DEFAULT '',
  "sortOrder" INT NOT NULL DEFAULT 0,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creator_script_folders_creator_platform
  ON creator_script_folders ("creatorId", platform);

CREATE TABLE IF NOT EXISTS creator_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "folderId" UUID REFERENCES creator_script_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  "shortcutCode" TEXT,
  "messageText" TEXT NOT NULL DEFAULT '',
  price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sortOrder" INT NOT NULL DEFAULT 0,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creator_scripts_creator_platform
  ON creator_scripts ("creatorId", platform);

CREATE INDEX IF NOT EXISTS idx_creator_scripts_folder
  ON creator_scripts ("folderId");

-- Unique shortcut when set (NULL shortcuts allowed multiple times)
CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_scripts_shortcut_unique
  ON creator_scripts ("creatorId", platform, "shortcutCode")
  WHERE "shortcutCode" IS NOT NULL AND "shortcutCode" <> '';

CREATE TABLE IF NOT EXISTS creator_script_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "scriptId" UUID NOT NULL REFERENCES creator_scripts(id) ON DELETE CASCADE,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "fanId" TEXT NOT NULL,
  "chatId" TEXT,
  "sentBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "sentAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("scriptId", "fanId")
);

CREATE INDEX IF NOT EXISTS idx_creator_script_sends_creator_fan
  ON creator_script_sends ("creatorId", platform, "fanId");

INSERT INTO permissions (slug, name, category, description)
VALUES (
  'scripts.manage',
  'Manage Chat Scripts',
  'App',
  'Create, edit, and remove chat scripts and folders (Managers and above)'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager')
  AND p.slug = 'scripts.manage'
ON CONFLICT DO NOTHING;
