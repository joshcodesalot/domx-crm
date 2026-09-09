-- Backend-owned funnel state. Model recommendedState is applied only via the transition table.

ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'NEW';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_conversations_state_check'
  ) THEN
    ALTER TABLE ai_conversations
      ADD CONSTRAINT ai_conversations_state_check
      CHECK (state IN (
        'NEW',
        'DISCOVERY',
        'KINK_DISCOVERY',
        'WARMUP',
        'INTENSE_WARMUP',
        'SALES_READY',
        'OFFERED',
        'PURCHASED',
        'FULFILLMENT',
        'RETENTION'
      ));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_conversation_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  "fromState" TEXT,
  "toState" TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model', 'system', 'human')),
  "runId" UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
  "recommendedState" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversation_state_history_convo
  ON ai_conversation_state_history ("conversationId", "createdAt" DESC);
