-- Idle seconds and keystroke counts for activity analytics

ALTER TABLE user_activity_presence
  ADD COLUMN IF NOT EXISTS "idleSecondsToday" INT NOT NULL DEFAULT 0;

ALTER TABLE user_activity_presence
  ADD COLUMN IF NOT EXISTS "keystrokesToday" INT NOT NULL DEFAULT 0;

ALTER TABLE user_activity_daily
  ADD COLUMN IF NOT EXISTS "idleSeconds" INT NOT NULL DEFAULT 0;

ALTER TABLE user_activity_daily
  ADD COLUMN IF NOT EXISTS "keystrokes" INT NOT NULL DEFAULT 0;
