-- Maloum: distribute-to-all + import cold DM fields; relax sourceMode check
ALTER TABLE maloum_fan_scrape_jobs
  DROP CONSTRAINT IF EXISTS maloum_fan_scrape_jobs_sourceMode_check;

ALTER TABLE maloum_fan_scrape_jobs
  ADD CONSTRAINT maloum_fan_scrape_jobs_sourceMode_check
  CHECK ("sourceMode" IN ('top_creators', 'custom_usernames', 'import_ids'));

ALTER TABLE maloum_fan_scrape_jobs
  ADD COLUMN IF NOT EXISTS "distributeToAllCreators" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "distributeListName" TEXT NOT NULL DEFAULT 'Fan Scrape',
  ADD COLUMN IF NOT EXISTS "importFanIds" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "messageText" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "targetCreatorIds" UUID[] NOT NULL DEFAULT '{}';

-- 4based: import cold DM source mode
ALTER TABLE fourbased_fan_scrape_jobs
  ADD COLUMN IF NOT EXISTS "sourceMode" TEXT NOT NULL DEFAULT 'trending',
  ADD COLUMN IF NOT EXISTS "importFans" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "targetCreatorIds" UUID[] NOT NULL DEFAULT '{}';

ALTER TABLE fourbased_fan_scrape_jobs
  DROP CONSTRAINT IF EXISTS fourbased_fan_scrape_jobs_sourceMode_check;

ALTER TABLE fourbased_fan_scrape_jobs
  ADD CONSTRAINT fourbased_fan_scrape_jobs_sourceMode_check
  CHECK ("sourceMode" IN ('trending', 'import_ids'));
