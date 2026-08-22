-- Telegram as a third creator platform. migrate.js re-runs every file; drop + add
-- keeps the platform checks current.

ALTER TABLE creators
  DROP CONSTRAINT IF EXISTS creators_platform_check;

ALTER TABLE creators
  ADD CONSTRAINT creators_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));

ALTER TABLE creator_connect_pending
  DROP CONSTRAINT IF EXISTS creator_connect_pending_platform_check;

ALTER TABLE creator_connect_pending
  ADD CONSTRAINT creator_connect_pending_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));

-- applyModeration records events on send; allow telegram so blocks still persist.
ALTER TABLE moderation_events
  DROP CONSTRAINT IF EXISTS moderation_events_platform_check;

ALTER TABLE moderation_events
  ADD CONSTRAINT moderation_events_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));

CREATE TABLE IF NOT EXISTS telegram_fan_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "telegramUserId" TEXT NOT NULL,
  username TEXT,
  "displayName" TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", "telegramUserId")
);

CREATE INDEX IF NOT EXISTS idx_telegram_fan_profiles_creator
  ON telegram_fan_profiles ("creatorId");

CREATE INDEX IF NOT EXISTS idx_telegram_fan_profiles_username
  ON telegram_fan_profiles ("creatorId", lower(username))
  WHERE username IS NOT NULL;
