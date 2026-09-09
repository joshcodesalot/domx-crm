-- SOP/infosheet document types plus overlap reports on import drafts.

ALTER TABLE ai_sop_import_drafts
  ADD COLUMN IF NOT EXISTS "documentType" TEXT NOT NULL DEFAULT 'sop'
    CHECK ("documentType" IN ('sop', 'infosheet'));

ALTER TABLE ai_sop_import_drafts
  ADD COLUMN IF NOT EXISTS "overlapJson" JSONB NOT NULL DEFAULT '{"overlaps":[]}'::jsonb;

ALTER TABLE ai_sops
  ADD COLUMN IF NOT EXISTS "documentType" TEXT NOT NULL DEFAULT 'sop'
    CHECK ("documentType" IN ('sop', 'infosheet'));

ALTER TABLE ai_sops
  ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ai_sops
  ADD COLUMN IF NOT EXISTS "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL;
