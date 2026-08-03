-- Fix sourceMode CHECKs: 022 dropped unquoted (lowercase) names and left the
-- mixed-case constraints from CREATE TABLE / ADD COLUMN still rejecting import_ids.

ALTER TABLE maloum_fan_scrape_jobs
  DROP CONSTRAINT IF EXISTS "maloum_fan_scrape_jobs_sourceMode_check";

ALTER TABLE maloum_fan_scrape_jobs
  DROP CONSTRAINT IF EXISTS maloum_fan_scrape_jobs_sourcemode_check;

ALTER TABLE maloum_fan_scrape_jobs
  ADD CONSTRAINT maloum_fan_scrape_jobs_sourcemode_check
  CHECK ("sourceMode" IN ('top_creators', 'custom_usernames', 'import_ids'));

ALTER TABLE fourbased_fan_scrape_jobs
  DROP CONSTRAINT IF EXISTS "fourbased_fan_scrape_jobs_sourceMode_check";

ALTER TABLE fourbased_fan_scrape_jobs
  DROP CONSTRAINT IF EXISTS fourbased_fan_scrape_jobs_sourcemode_check;

ALTER TABLE fourbased_fan_scrape_jobs
  ADD CONSTRAINT fourbased_fan_scrape_jobs_sourcemode_check
  CHECK ("sourceMode" IN ('trending', 'import_ids'));
