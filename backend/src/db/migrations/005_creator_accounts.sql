CREATE TABLE IF NOT EXISTS creator_connect_pending (
  "accountId" UUID PRIMARY KEY,
  "accountTokenHash" TEXT NOT NULL,
  "partitionId" TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "displayName" TEXT,
  username TEXT,
  "postLoginUrl" TEXT,
  "encryptedSession" BYTEA NOT NULL,
  "loginEmail" TEXT,
  "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creator_connect_pending_expires
  ON creator_connect_pending ("expiresAt");

CREATE INDEX IF NOT EXISTS idx_creator_connect_pending_created_by
  ON creator_connect_pending ("createdBy");

ALTER TABLE creators ADD COLUMN IF NOT EXISTS "accountId" UUID UNIQUE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS "accountTokenHash" TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS "partitionId" TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS "encryptedSession" BYTEA;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS "loginEmail" TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS "lastValidatedAt" TIMESTAMPTZ;
