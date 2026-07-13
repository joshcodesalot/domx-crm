CREATE TABLE IF NOT EXISTS creator_staff_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "assignedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_creator_staff_user ON creator_staff_assignments("userId");
CREATE INDEX IF NOT EXISTS idx_creator_staff_creator ON creator_staff_assignments("creatorId");
