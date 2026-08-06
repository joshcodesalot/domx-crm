-- Per-user preferred IANA timezone for analytics day boundaries.
-- Org business calendar (schedules, activity writes) remains Europe/Berlin.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
