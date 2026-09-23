-- Per-creator Maloum comment guard and block log.

CREATE TABLE IF NOT EXISTS maloum_comment_guard_settings (
  "creatorId" UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  "lastScanAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maloum_comment_guard_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "postId" TEXT,
  "commentId" TEXT,
  "memberId" TEXT NOT NULL,
  username TEXT,
  "commentText" TEXT,
  "matchedTerm" TEXT,
  status TEXT NOT NULL CHECK (status IN ('blocked', 'failed')),
  error TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS maloum_comment_guard_events_blocked_member
  ON maloum_comment_guard_events ("creatorId", "memberId")
  WHERE status = 'blocked';

CREATE INDEX IF NOT EXISTS maloum_comment_guard_events_creator_created
  ON maloum_comment_guard_events ("creatorId", "createdAt" DESC);
