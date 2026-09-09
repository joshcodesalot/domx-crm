-- Fan display username (never the platform id) and one-shot history backfill marker.

ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS "fanUsername" TEXT,
  ADD COLUMN IF NOT EXISTS "historyBackfilledAt" TIMESTAMPTZ;
