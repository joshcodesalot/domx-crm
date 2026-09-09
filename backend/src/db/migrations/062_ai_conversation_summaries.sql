-- Extractive last-session summaries. One row per previous-session end.

CREATE TABLE IF NOT EXISTS ai_conversation_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  "uptoPlatformMessageId" TEXT,
  "uptoSentAt" TIMESTAMPTZ,
  "gapHours" NUMERIC,
  summary TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_conversation_summaries_convo_upto
  ON ai_conversation_summaries ("conversationId", "uptoPlatformMessageId")
  WHERE "uptoPlatformMessageId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_conversation_summaries_convo_created
  ON ai_conversation_summaries ("conversationId", "createdAt" DESC);
