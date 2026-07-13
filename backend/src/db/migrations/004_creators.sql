CREATE TABLE IF NOT EXISTS creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "displayName" TEXT NOT NULL,
  username TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "connectionStatus" TEXT NOT NULL DEFAULT 'connected'
    CHECK ("connectionStatus" IN ('connected', 'error', 'pending')),
  "postLoginUrl" TEXT,
  "staffCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
