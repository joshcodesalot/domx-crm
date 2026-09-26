-- One Clearcote profile per creator. The archive lives on the data disk.

CREATE TABLE IF NOT EXISTS browser_profiles (
  "creatorId" UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  "fingerprintSeed" TEXT NOT NULL,
  "fingerprintPlatform" TEXT NOT NULL DEFAULT 'windows',
  "encryptedProfileKey" BYTEA NOT NULL,
  "encryptedProxy" BYTEA,
  timezone TEXT,
  "acceptLanguage" TEXT,
  "archivePath" TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  "lockedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "lockedAt" TIMESTAMPTZ,
  "heartbeatAt" TIMESTAMPTZ,
  "viewTokenHash" TEXT,
  "encryptedViewToken" BYTEA,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
