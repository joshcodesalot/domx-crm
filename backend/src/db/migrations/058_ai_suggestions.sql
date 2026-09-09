-- Pending AI drafts for human review. Phase 8 writes pending + superseded only.

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  "runId" UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  "platformChatId" TEXT NOT NULL,
  revision INTEGER,
  "anchorInboundMessageId" TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'stale', 'superseded', 'approved',
      'edited', 'rejected', 'sent', 'failed'
    )),
  reply TEXT NOT NULL DEFAULT '',
  "replyEnglish" TEXT NOT NULL DEFAULT '',
  intent TEXT,
  action TEXT,
  route TEXT,
  output JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_conversation_status
  ON ai_suggestions ("conversationId", status, "createdAt" DESC);
