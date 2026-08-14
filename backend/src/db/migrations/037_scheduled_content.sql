-- Scheduled mass messages / feed posts and per-creator targeting defaults.

CREATE TABLE IF NOT EXISTS creator_schedule_settings (
  "creatorId" UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  "audienceFilters" JSONB NOT NULL DEFAULT '["users_with_purchases","users_without_purchases","users_with_subscription","users_without_subscription"]'::jsonb,
  "includeListIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "excludeListIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "categoryIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_content_jobs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('mass_message', 'feed_post')),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "runAt" TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'sent', 'failed', 'cancelled')),
  "bodyText" TEXT NOT NULL DEFAULT '',
  "imageFileName" TEXT,
  "storedPath" TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  "lastError" TEXT,
  "createdByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_content_jobs_due
  ON scheduled_content_jobs (status, "runAt")
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_scheduled_content_jobs_range
  ON scheduled_content_jobs ("runAt");

CREATE INDEX IF NOT EXISTS idx_scheduled_content_jobs_creator
  ON scheduled_content_jobs ("creatorId", "runAt" DESC);

CREATE TABLE IF NOT EXISTS scheduled_content_assets (
  id UUID PRIMARY KEY,
  "originalFileName" TEXT NOT NULL,
  "storedPath" TEXT NOT NULL,
  "mimeType" TEXT,
  "createdByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_content_assets_name
  ON scheduled_content_assets (lower("originalFileName"), "createdAt" DESC);
