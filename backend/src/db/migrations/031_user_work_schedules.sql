-- Per-staff weekly work schedules (Asia/Manila wall clock).
-- Overnight shifts: endTime <= startTime (e.g. 23:00 → 08:00).

CREATE TABLE IF NOT EXISTS user_work_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "dayOfWeek" SMALLINT NOT NULL CHECK ("dayOfWeek" >= 0 AND "dayOfWeek" <= 6),
  "startTime" TIME NOT NULL,
  "endTime" TIME NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("userId", "dayOfWeek")
);

CREATE INDEX IF NOT EXISTS idx_user_work_schedules_user
  ON user_work_schedules ("userId");
