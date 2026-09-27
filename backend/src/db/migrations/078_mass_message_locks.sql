CREATE TABLE IF NOT EXISTS mass_message_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based', 'telegram')),
  "platformMessageId" TEXT NOT NULL,
  "bodyText" TEXT NOT NULL DEFAULT '',
  "mediaIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "lockedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", platform, "platformMessageId")
);

CREATE INDEX IF NOT EXISTS idx_mass_message_locks_creator
  ON mass_message_locks ("creatorId", platform);
