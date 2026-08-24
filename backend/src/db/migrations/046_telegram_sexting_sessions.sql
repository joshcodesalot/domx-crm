CREATE TABLE IF NOT EXISTS telegram_sexting_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "fanName" TEXT NOT NULL DEFAULT '',
  "slaveName" TEXT NOT NULL DEFAULT '',
  "groupPeerId" TEXT NOT NULL,
  "creatorIds" UUID[] NOT NULL DEFAULT '{}',
  "numberOfBlocks" INT NOT NULL DEFAULT 20,
  toys TEXT NOT NULL DEFAULT '',
  intensity TEXT NOT NULL DEFAULT 'medium',
  "orgasmRule" TEXT NOT NULL DEFAULT 'denied',
  themes TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT 'training',
  scenario TEXT NOT NULL DEFAULT '',
  "extraInstructions" TEXT NOT NULL DEFAULT '',
  "rawOutput" TEXT NOT NULL DEFAULT '',
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_sexting_sessions_created
  ON telegram_sexting_sessions ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS telegram_sexting_session_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sessionId" UUID NOT NULL REFERENCES telegram_sexting_sessions(id) ON DELETE CASCADE,
  "blockIndex" INT NOT NULL,
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "speakerName" TEXT NOT NULL DEFAULT '',
  "englishText" TEXT NOT NULL DEFAULT '',
  "vaultIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  "sentAt" TIMESTAMPTZ,
  "sentBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "telegramMessageId" TEXT,
  UNIQUE ("sessionId", "blockIndex")
);

CREATE INDEX IF NOT EXISTS idx_telegram_sexting_session_blocks_session
  ON telegram_sexting_session_blocks ("sessionId", "blockIndex");
