-- CRM-side audit tombstones for unsent/deleted 1:1 chat messages.

CREATE TABLE IF NOT EXISTS message_unsends (
  id UUID PRIMARY KEY,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "chatId" TEXT NOT NULL,
  "platformMessageId" TEXT NOT NULL,
  "originalText" TEXT NOT NULL DEFAULT '',
  "unsentByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "unsentByUserName" TEXT NOT NULL,
  "messageSentAt" TIMESTAMPTZ,
  "unsentAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", platform, "platformMessageId")
);

CREATE INDEX IF NOT EXISTS message_unsends_creator_chat_platform_idx
  ON message_unsends ("creatorId", "chatId", platform);
