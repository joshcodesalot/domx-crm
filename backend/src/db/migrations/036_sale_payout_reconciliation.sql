-- Payout verification fields on messaging ledger + false-sales audit/review queue.

ALTER TABLE messaging_dashboard_entries
  ADD COLUMN IF NOT EXISTS "unlockedAt" TIMESTAMPTZ;

ALTER TABLE messaging_dashboard_entries
  ADD COLUMN IF NOT EXISTS "payoutVerified" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE messaging_dashboard_entries
  ADD COLUMN IF NOT EXISTS "payoutVerifiedAt" TIMESTAMPTZ;

ALTER TABLE messaging_dashboard_entries
  ADD COLUMN IF NOT EXISTS "payoutTxnId" TEXT;

ALTER TABLE messaging_dashboard_entries
  ADD COLUMN IF NOT EXISTS "attributionSource" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messaging_dashboard_entries_attribution_source_check'
  ) THEN
    ALTER TABLE messaging_dashboard_entries
      ADD CONSTRAINT messaging_dashboard_entries_attribution_source_check
      CHECK (
        "attributionSource" IS NULL
        OR "attributionSource" IN ('send_log', 'deleted_import', 'orphan_sale')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_payout_unverified
  ON messaging_dashboard_entries ("creatorId", purchased, "payoutVerified")
  WHERE purchased = TRUE AND "payoutVerified" = FALSE;

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_unlocked_at
  ON messaging_dashboard_entries ("unlockedAt" DESC)
  WHERE "unlockedAt" IS NOT NULL;

CREATE TABLE IF NOT EXISTS sale_reconciliation_events (
  id UUID PRIMARY KEY,
  "creatorId" UUID REFERENCES creators(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "eventType" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review',
  "messagingEntryId" UUID REFERENCES messaging_dashboard_entries(id) ON DELETE SET NULL,
  "maloumMessageId" TEXT,
  "payoutTxnId" TEXT,
  "fanId" TEXT,
  "fanUsername" TEXT,
  "chatId" TEXT,
  amount NUMERIC,
  currency TEXT,
  "unlockedAt" TIMESTAMPTZ,
  reason TEXT,
  "detailJson" JSONB,
  "recoveredMessageText" TEXT,
  "recoveredMediaJson" JSONB,
  "resolvedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "resolvedAt" TIMESTAMPTZ,
  resolution TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_reconciliation_status_created
  ON sale_reconciliation_events (status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_sale_reconciliation_creator_created
  ON sale_reconciliation_events ("creatorId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_sale_reconciliation_event_type
  ON sale_reconciliation_events ("eventType", status);
