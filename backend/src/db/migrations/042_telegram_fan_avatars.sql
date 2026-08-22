-- Fan/group avatar cache + Telegram send logs on the messaging dashboard.
-- migrate.js re-runs every file; drop + add keeps the platform check current.

ALTER TABLE telegram_fan_profiles
  ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;

ALTER TABLE messaging_dashboard_entries
  DROP CONSTRAINT IF EXISTS messaging_dashboard_entries_platform_check;

ALTER TABLE messaging_dashboard_entries
  ADD CONSTRAINT messaging_dashboard_entries_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));
