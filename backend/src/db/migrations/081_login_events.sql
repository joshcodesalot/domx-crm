-- Successful staff logins, including device and IP changes versus the previous login.

CREATE TABLE IF NOT EXISTS login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "userName" TEXT NOT NULL,
  "userEmail" TEXT NOT NULL,
  "ipAddress" VARCHAR(45),
  "previousIp" VARCHAR(45),
  "ipChanged" BOOLEAN NOT NULL DEFAULT FALSE,
  "deviceId" TEXT,
  "previousDeviceId" TEXT,
  "deviceChanged" BOOLEAN NOT NULL DEFAULT FALSE,
  "userAgent" TEXT NOT NULL DEFAULT '',
  "deviceLabel" TEXT NOT NULL DEFAULT '',
  "previousDeviceLabel" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS login_events_created_at_idx
  ON login_events ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS login_events_user_created_idx
  ON login_events ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS login_events_ip_changed_idx
  ON login_events ("createdAt" DESC)
  WHERE "ipChanged";

CREATE INDEX IF NOT EXISTS login_events_device_changed_idx
  ON login_events ("createdAt" DESC)
  WHERE "deviceChanged";
