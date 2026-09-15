CREATE TABLE IF NOT EXISTS maloum_proxy_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "encryptedUrl" BYTEA NOT NULL,
  "hostPort" TEXT NOT NULL UNIQUE,
  "bannedUntil" TIMESTAMPTZ,
  "assignedCreatorId" UUID UNIQUE REFERENCES creators(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS maloum_proxy_pool_free_idx
  ON maloum_proxy_pool ("assignedCreatorId", "bannedUntil");
