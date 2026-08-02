-- 4based fan scraper jobs + deduped messaged fans (mother-account scoped)

CREATE TABLE IF NOT EXISTS fourbased_fan_scrape_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "motherCreatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'paused', 'completed', 'failed')),
  "messageText" TEXT NOT NULL DEFAULT '',
  "vaultIds" TEXT[] NOT NULL DEFAULT '{}',
  "priceCoins" INTEGER NOT NULL DEFAULT 0,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  "startedAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE ("motherCreatorId")
);

CREATE INDEX IF NOT EXISTS idx_fourbased_fan_scrape_jobs_status
  ON fourbased_fan_scrape_jobs (status);

CREATE TABLE IF NOT EXISTS fourbased_fan_scrape_fans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "motherCreatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "fanId" TEXT NOT NULL,
  "chatId" TEXT,
  username TEXT,
  "sourcePostId" TEXT,
  "messageId" TEXT,
  "scrapedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("motherCreatorId", "fanId")
);

CREATE INDEX IF NOT EXISTS idx_fourbased_fan_scrape_fans_mother
  ON fourbased_fan_scrape_fans ("motherCreatorId", "scrapedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_fourbased_fan_scrape_fans_fan
  ON fourbased_fan_scrape_fans ("fanId");
