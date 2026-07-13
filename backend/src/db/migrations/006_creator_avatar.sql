ALTER TABLE creators ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE creator_connect_pending ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
