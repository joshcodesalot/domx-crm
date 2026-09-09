-- AI generation runs. Tokens/cost stay null until usage tracking (Phase 11).

CREATE TABLE IF NOT EXISTS ai_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID REFERENCES ai_conversations(id) ON DELETE CASCADE,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  "platformChatId" TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('inbound', 'manual')),
  "inboundPlatformMessageId" TEXT,
  revision INTEGER,
  "anchorInboundMessageId" TEXT,
  mode TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped')),
  "skipReason" TEXT,
  route TEXT,
  "suggestedRoute" TEXT,
  output JSONB,
  error TEXT,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "costUsd" NUMERIC,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_runs_inbound_unique
  ON ai_runs ("conversationId", "inboundPlatformMessageId")
  WHERE trigger = 'inbound' AND "inboundPlatformMessageId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_runs_conversation
  ON ai_runs ("conversationId", "createdAt" DESC);
