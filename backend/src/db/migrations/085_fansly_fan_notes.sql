-- Chatter notes for a Fansly fan. Stored in DomX, not on Fansly.
CREATE TABLE IF NOT EXISTS fansly_fan_notes (
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "fanAccountId" TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("creatorId", "fanAccountId")
);
