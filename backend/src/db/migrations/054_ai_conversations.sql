-- AI conversation + message store. Latest-page ingest only; no vault blobs.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based', 'telegram')),
  "platformChatId" TEXT NOT NULL,
  "platformFanId" TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  "lastInboundPlatformMessageId" TEXT,
  "lastOutboundPlatformMessageId" TEXT,
  "lastInboundAt" TIMESTAMPTZ,
  "lastMessageAt" TIMESTAMPTZ,
  "humanTakeover" BOOLEAN NOT NULL DEFAULT false,
  "aiPaused" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", platform, "platformChatId")
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_creator
  ON ai_conversations ("creatorId", "lastMessageAt" DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  "platformMessageId" TEXT,
  "senderRole" TEXT NOT NULL CHECK ("senderRole" IN ('fan', 'creator', 'system')),
  text TEXT NOT NULL DEFAULT '',
  "hasMedia" BOOLEAN NOT NULL DEFAULT false,
  "isPpv" BOOLEAN NOT NULL DEFAULT false,
  "priceNet" NUMERIC,
  "sentAt" TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'poll',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_messages_conversation_platform_id
  ON ai_messages ("conversationId", "platformMessageId")
  WHERE "platformMessageId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_sent
  ON ai_messages ("conversationId", "sentAt" DESC);
