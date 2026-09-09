-- Structured per-fan memories for AI context. No embeddings.

CREATE TABLE IF NOT EXISTS ai_fan_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based', 'telegram')),
  "platformFanId" TEXT NOT NULL,
  nickname TEXT,
  facts JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sourceNotes" TEXT,
  "sourceNotesAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", platform, "platformFanId")
);

CREATE INDEX IF NOT EXISTS idx_ai_fan_memories_creator_platform
  ON ai_fan_memories ("creatorId", platform);
