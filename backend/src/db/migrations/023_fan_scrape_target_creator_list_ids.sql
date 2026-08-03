-- Per-creator Maloum chat list IDs for Import IDs distribution
ALTER TABLE maloum_fan_scrape_jobs
  ADD COLUMN IF NOT EXISTS "targetCreatorListIds" JSONB NOT NULL DEFAULT '{}'::jsonb;
