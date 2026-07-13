CREATE TABLE IF NOT EXISTS messaging_dashboard_entries (
  id UUID PRIMARY KEY,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "creatorName" TEXT NOT NULL,
  "creatorUsername" TEXT,
  "creatorAvatarUrl" TEXT,

  "chatterId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "chatterName" TEXT NOT NULL,
  "chatterEmail" TEXT,

  "chatId" TEXT NOT NULL,
  "fanId" TEXT,
  "fanUsername" TEXT,

  "maloumMessageId" TEXT NOT NULL UNIQUE,
  "optimisticMessageId" TEXT,

  "contentType" TEXT NOT NULL,
  "englishMessage" TEXT,
  "germanTranslatedMessage" TEXT,
  "actualSentText" TEXT,

  "priceNet" NUMERIC,
  currency TEXT NOT NULL DEFAULT 'EUR',
  purchased BOOLEAN NOT NULL DEFAULT FALSE,

  "mediaCount" INT NOT NULL DEFAULT 0,
  "pictureCount" INT NOT NULL DEFAULT 0,
  "videoCount" INT NOT NULL DEFAULT 0,
  "mediaJson" JSONB,

  "previousFanMessageAt" TIMESTAMPTZ,
  "responseTimeSeconds" INT,

  "sentAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_creator
  ON messaging_dashboard_entries ("creatorId");

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_chatter
  ON messaging_dashboard_entries ("chatterId");

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_chat
  ON messaging_dashboard_entries ("chatId");

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_sent_at
  ON messaging_dashboard_entries ("sentAt" DESC);

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_purchased
  ON messaging_dashboard_entries (purchased);
