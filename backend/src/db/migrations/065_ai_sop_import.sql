-- Long-form SOP library plus human-approved import drafts. Never auto-promoted.

CREATE TABLE IF NOT EXISTS ai_sop_import_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "rawText" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  "proposedJson" JSONB NOT NULL,
  "creatorId" UUID REFERENCES creators(id) ON DELETE SET NULL,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "reviewedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "reviewedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_sop_import_drafts_status
  ON ai_sop_import_drafts (status, "createdAt" DESC);

CREATE TABLE IF NOT EXISTS ai_sops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'CREATOR')),
  "creatorId" UUID REFERENCES creators(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  "sourceDraftId" UUID REFERENCES ai_sop_import_drafts(id) ON DELETE SET NULL,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'GLOBAL' AND "creatorId" IS NULL)
    OR (scope = 'CREATOR' AND "creatorId" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_sops_active_scope
  ON ai_sops (active, scope, "creatorId");
