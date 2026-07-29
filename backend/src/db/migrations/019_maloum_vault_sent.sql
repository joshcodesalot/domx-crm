-- DomX-local record of vault media already sent to a Maloum fan
CREATE TABLE IF NOT EXISTS maloum_vault_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "fanId" TEXT NOT NULL,
  "chatId" TEXT,
  "uploadId" TEXT NOT NULL,
  "sentByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "sentAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", "fanId", "uploadId")
);

CREATE INDEX IF NOT EXISTS idx_maloum_vault_sent_creator_fan
  ON maloum_vault_sent ("creatorId", "fanId");
