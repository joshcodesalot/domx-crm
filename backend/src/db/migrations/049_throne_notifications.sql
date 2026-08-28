CREATE TABLE IF NOT EXISTS throne_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" TEXT NOT NULL UNIQUE,
  "eventType" TEXT NOT NULL,
  "throneCreatorId" TEXT,
  "throneCreatorUsername" TEXT,
  "gifterUsername" TEXT,
  message TEXT,
  "itemName" TEXT,
  "itemThumbnailUrl" TEXT,
  amount NUMERIC,
  currency TEXT,
  "isSurpriseGift" BOOLEAN,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "claimedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "claimedByUserName" TEXT,
  "claimedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_throne_notifications_created
  ON throne_notifications ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_throne_notifications_unread
  ON throne_notifications ("isRead")
  WHERE "isRead" = false;
