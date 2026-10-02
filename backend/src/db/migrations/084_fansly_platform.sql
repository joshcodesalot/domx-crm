-- Fansly as a fourth creator platform. migrate.js re-runs every file; drop + add
-- keeps the platform checks current. Other feature tables stay unchanged until
-- a Fansly feature writes into them.

ALTER TABLE creators
  DROP CONSTRAINT IF EXISTS creators_platform_check;

ALTER TABLE creators
  ADD CONSTRAINT creators_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram', 'fansly'));

ALTER TABLE creator_connect_pending
  DROP CONSTRAINT IF EXISTS creator_connect_pending_platform_check;

ALTER TABLE creator_connect_pending
  ADD CONSTRAINT creator_connect_pending_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram', 'fansly'));

CREATE INDEX IF NOT EXISTS idx_creators_platform_fansly
  ON creators (platform)
  WHERE platform = 'fansly';
