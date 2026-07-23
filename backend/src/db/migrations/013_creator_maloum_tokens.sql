ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS "encryptedAccessToken" BYTEA,
  ADD COLUMN IF NOT EXISTS "encryptedRefreshToken" BYTEA,
  ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "authRefreshState" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "lastTokenRefreshedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "tokenRefreshFailureCount" INT NOT NULL DEFAULT 0;

ALTER TABLE creator_connect_pending
  ADD COLUMN IF NOT EXISTS "encryptedAccessToken" BYTEA,
  ADD COLUMN IF NOT EXISTS "encryptedRefreshToken" BYTEA,
  ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_creators_token_refresh
  ON creators ("authRefreshState", "accessTokenExpiresAt")
  WHERE "encryptedRefreshToken" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'creators_auth_refresh_state_check'
  ) THEN
    ALTER TABLE creators
      ADD CONSTRAINT creators_auth_refresh_state_check
      CHECK ("authRefreshState" IN ('active', 'needs_reauth', 'disabled'));
  END IF;
END $$;
