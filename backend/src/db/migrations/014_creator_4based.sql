ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS "providerUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "encryptedProxy" BYTEA;

ALTER TABLE creator_connect_pending
  ADD COLUMN IF NOT EXISTS "providerUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "encryptedProxy" BYTEA;

CREATE INDEX IF NOT EXISTS idx_creators_provider_user_id
  ON creators ("providerUserId")
  WHERE "providerUserId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creators_platform_4based
  ON creators (platform)
  WHERE platform = '4based';
