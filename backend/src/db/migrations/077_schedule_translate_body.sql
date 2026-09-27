ALTER TABLE scheduled_content_jobs
  ADD COLUMN IF NOT EXISTS "translateBody" BOOLEAN NOT NULL DEFAULT true;
