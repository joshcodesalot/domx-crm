-- Scheduled jobs can target Fansly the same way as the other platforms.
-- Captions stay as typed; German translation already skips Fansly.

ALTER TABLE scheduled_content_jobs
  DROP CONSTRAINT IF EXISTS scheduled_content_jobs_platform_check;

ALTER TABLE scheduled_content_jobs
  ADD CONSTRAINT scheduled_content_jobs_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram', 'fansly'));
