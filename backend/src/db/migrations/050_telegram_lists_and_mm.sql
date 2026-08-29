-- DomX-owned Telegram lists, mass-message campaigns, and schedule platform.

ALTER TABLE telegram_fan_profiles
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dm';

ALTER TABLE telegram_fan_profiles
  DROP CONSTRAINT IF EXISTS telegram_fan_profiles_kind_check;

ALTER TABLE telegram_fan_profiles
  ADD CONSTRAINT telegram_fan_profiles_kind_check
  CHECK (kind IN ('dm', 'group'));

CREATE TABLE IF NOT EXISTS telegram_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_lists_creator
  ON telegram_lists ("creatorId", lower(name));

CREATE TABLE IF NOT EXISTS telegram_list_members (
  "listId" UUID NOT NULL REFERENCES telegram_lists(id) ON DELETE CASCADE,
  "telegramUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("listId", "telegramUserId")
);

CREATE INDEX IF NOT EXISTS idx_telegram_list_members_user
  ON telegram_list_members ("telegramUserId");

CREATE TABLE IF NOT EXISTS telegram_mm_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "bodyText" TEXT NOT NULL DEFAULT '',
  "vaultIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "includeListIds" UUID[] NOT NULL DEFAULT '{}',
  "excludeListIds" UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'running', 'paused', 'done', 'failed',
      'unsending', 'unsent'
    )),
  total INT NOT NULL DEFAULT 0,
  sent INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  unsent INT NOT NULL DEFAULT 0,
  "unsendFailed" INT NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "startedAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_telegram_mm_campaigns_creator
  ON telegram_mm_campaigns ("creatorId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS telegram_mm_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaignId" UUID NOT NULL REFERENCES telegram_mm_campaigns(id) ON DELETE CASCADE,
  "peerId" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'sent', 'failed', 'skipped', 'unsent', 'unsend_failed'
    )),
  "telegramMessageIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  "sentAt" TIMESTAMPTZ,
  UNIQUE ("campaignId", "peerId")
);

CREATE INDEX IF NOT EXISTS idx_telegram_mm_recipients_campaign
  ON telegram_mm_recipients ("campaignId", status);

ALTER TABLE scheduled_content_jobs
  DROP CONSTRAINT IF EXISTS scheduled_content_jobs_platform_check;

ALTER TABLE scheduled_content_jobs
  ADD CONSTRAINT scheduled_content_jobs_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));
