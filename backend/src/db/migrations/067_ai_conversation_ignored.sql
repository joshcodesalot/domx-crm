-- Per-conversation AI ignore (mute). Distinct from pause and takeover.

ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS "aiIgnored" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ignoredAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "ignoredByUserId" UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_creator_ignored
  ON ai_conversations ("creatorId", "aiIgnored");
