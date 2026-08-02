-- Maloum fan scraper jobs + deduped scraped fans (mother-account scoped)

CREATE TABLE IF NOT EXISTS maloum_fan_scrape_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "motherCreatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "targetListId" TEXT,
  "targetListName" TEXT,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'paused', 'completed', 'failed')),
  "sourceMode" TEXT NOT NULL DEFAULT 'top_creators'
    CHECK ("sourceMode" IN ('top_creators', 'custom_usernames')),
  "topCreatorsLimit" INTEGER NOT NULL DEFAULT 50,
  "postsPerCreator" INTEGER NOT NULL DEFAULT 50,
  "customUsernames" TEXT[] NOT NULL DEFAULT '{}',
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  "startedAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE ("motherCreatorId")
);

CREATE INDEX IF NOT EXISTS idx_maloum_fan_scrape_jobs_status
  ON maloum_fan_scrape_jobs (status);

CREATE TABLE IF NOT EXISTS maloum_fan_scrape_fans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "motherCreatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "fanId" TEXT NOT NULL,
  "chatId" TEXT,
  username TEXT,
  "sourceCreatorUsername" TEXT,
  "sourcePostId" TEXT,
  "listId" TEXT,
  "scrapedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("motherCreatorId", "fanId")
);

CREATE INDEX IF NOT EXISTS idx_maloum_fan_scrape_fans_mother
  ON maloum_fan_scrape_fans ("motherCreatorId", "scrapedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_maloum_fan_scrape_fans_fan
  ON maloum_fan_scrape_fans ("fanId");
