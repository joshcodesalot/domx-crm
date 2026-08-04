-- Per-day active seconds for Overview activity history charts

CREATE TABLE IF NOT EXISTS user_activity_daily (
  "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  "activeSeconds" INT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("userId", day)
);

CREATE INDEX IF NOT EXISTS idx_user_activity_daily_day
  ON user_activity_daily (day DESC);
