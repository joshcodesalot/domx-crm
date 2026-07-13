CREATE TABLE IF NOT EXISTS maloum_sent_messages (
  id UUID PRIMARY KEY,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "chatId" TEXT NOT NULL,
  "maloumMessageId" TEXT,
  "optimisticMessageId" TEXT,
  "contentText" TEXT NOT NULL DEFAULT '',
  "sentByUserId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "sentByUserName" TEXT NOT NULL,
  "sentAt" TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  "domMarked" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maloum_sent_messages_creator
  ON maloum_sent_messages ("creatorId", "sentAt" DESC);

CREATE INDEX IF NOT EXISTS idx_maloum_sent_messages_maloum_id
  ON maloum_sent_messages ("maloumMessageId");
