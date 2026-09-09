-- Per-run token/cost ledger. Phase 11 fills ai_runs columns and upserts here.

CREATE TABLE IF NOT EXISTS ai_usage (
  "runId" UUID PRIMARY KEY REFERENCES ai_runs(id) ON DELETE CASCADE,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT,
  mode TEXT,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" NUMERIC NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_creator_created
  ON ai_usage ("creatorId", "createdAt" DESC);
