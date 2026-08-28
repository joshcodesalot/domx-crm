-- Org-wide flag: unsend the last 30 mass messages before a scheduled send.

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO app_settings (key, value)
VALUES ('schedule.unsend_before_mass', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
