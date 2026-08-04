-- Chatter / staff presence for Overview dashboard (online / idle / away)

CREATE TABLE IF NOT EXISTS user_activity_presence (
  "userId" UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  "lastInputAt" TIMESTAMPTZ,
  "lastHeartbeatAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "activeSecondsToday" INT NOT NULL DEFAULT 0,
  "activeSecondsDate" DATE,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_activity_presence_heartbeat
  ON user_activity_presence ("lastHeartbeatAt" DESC);
