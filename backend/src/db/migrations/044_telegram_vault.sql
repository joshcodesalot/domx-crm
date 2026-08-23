-- DomX-owned Telegram vault (Saved Messages as byte store).
-- migrate.js re-runs every file; drop + add keeps the notes check current.

ALTER TABLE vault_media_notes
  DROP CONSTRAINT IF EXISTS vault_media_notes_platform_check;

ALTER TABLE vault_media_notes
  ADD CONSTRAINT vault_media_notes_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));

CREATE TABLE IF NOT EXISTS telegram_vault_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  "sortOrder" INT NOT NULL DEFAULT 0,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_vault_folders_creator
  ON telegram_vault_folders ("creatorId", "sortOrder", "createdAt");

CREATE TABLE IF NOT EXISTS telegram_vault_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "folderId" UUID REFERENCES telegram_vault_folders(id) ON DELETE SET NULL,
  "savedMessageId" TEXT NOT NULL,
  "fileUniqueId" TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  "fileName" TEXT,
  duration INT,
  width INT,
  height INT,
  "uploadedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", "savedMessageId")
);

CREATE INDEX IF NOT EXISTS idx_telegram_vault_items_creator_folder
  ON telegram_vault_items ("creatorId", "folderId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_vault_items_creator_kind
  ON telegram_vault_items ("creatorId", kind);

CREATE TABLE IF NOT EXISTS telegram_vault_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "fanId" TEXT NOT NULL,
  "itemId" UUID NOT NULL REFERENCES telegram_vault_items(id) ON DELETE CASCADE,
  "sentByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "sentAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", "fanId", "itemId")
);

CREATE INDEX IF NOT EXISTS idx_telegram_vault_sent_creator_fan
  ON telegram_vault_sent ("creatorId", "fanId");
