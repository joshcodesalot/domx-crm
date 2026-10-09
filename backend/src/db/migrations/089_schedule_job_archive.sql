-- Hide sent and cancelled mass messages from Content Schedule without deleting them.

ALTER TABLE scheduled_content_jobs
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scheduled_content_jobs_archived
  ON scheduled_content_jobs ("archivedAt")
  WHERE "archivedAt" IS NOT NULL;
