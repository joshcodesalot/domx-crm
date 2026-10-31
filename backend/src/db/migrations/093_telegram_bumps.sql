-- Personal Telegram bumps store a mode on the run and the sent line per fan.

ALTER TABLE telegram_mm_campaigns
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'broadcast';

ALTER TABLE telegram_mm_campaigns
  DROP CONSTRAINT IF EXISTS telegram_mm_campaigns_mode_check;

ALTER TABLE telegram_mm_campaigns
  ADD CONSTRAINT telegram_mm_campaigns_mode_check
  CHECK (mode IN ('broadcast', 'bump'));

ALTER TABLE telegram_mm_recipients
  ADD COLUMN IF NOT EXISTS "bodyText" TEXT NOT NULL DEFAULT '';
