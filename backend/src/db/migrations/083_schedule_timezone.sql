-- Timezone of the person who last saved this user's work schedule.
-- Clock times in user_work_schedules are wall times in this zone.
-- Existing rows stay Europe/Berlin, which is how those hours were entered.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "scheduleTimeZone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
