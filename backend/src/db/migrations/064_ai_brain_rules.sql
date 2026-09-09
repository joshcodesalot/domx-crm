-- Hive-mind rules. Suggestions are never auto-promoted into ai_rules.

CREATE TABLE IF NOT EXISTS ai_rule_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "suggestionId" UUID UNIQUE REFERENCES ai_suggestions(id) ON DELETE SET NULL,
  "conversationId" UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  "platformFanId" TEXT,
  "beforeText" TEXT NOT NULL,
  "afterText" TEXT NOT NULL,
  "proposedRule" TEXT NOT NULL,
  "proposedScope" TEXT NOT NULL DEFAULT 'CREATOR'
    CHECK ("proposedScope" IN ('GLOBAL', 'PLATFORM', 'CREATOR', 'FAN')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "reviewedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "reviewedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_rule_suggestions_status
  ON ai_rule_suggestions (status, "createdAt" DESC);

CREATE TABLE IF NOT EXISTS ai_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'PLATFORM', 'CREATOR', 'FAN')),
  "creatorId" UUID REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT,
  "platformFanId" TEXT,
  text TEXT NOT NULL,
  "sourceSuggestionId" UUID REFERENCES ai_rule_suggestions(id) ON DELETE SET NULL,
  "approvedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "approvedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_rules_active_scope
  ON ai_rules (active, scope, platform, "creatorId");
