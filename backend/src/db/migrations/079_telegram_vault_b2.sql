-- Telegram vault bytes move from Saved Messages to Backblaze B2.
-- savedMessageId stays on migrated rows as the historical Telegram reference.

ALTER TABLE telegram_vault_items
  ADD COLUMN IF NOT EXISTS "storageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "thumbKey" TEXT,
  ADD COLUMN IF NOT EXISTS "mimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "byteSize" BIGINT,
  ADD COLUMN IF NOT EXISTS "migratedAt" TIMESTAMPTZ;

ALTER TABLE telegram_vault_items
  ALTER COLUMN "savedMessageId" DROP NOT NULL;

DO $$
DECLARE
  cons text;
BEGIN
  SELECT c.conname INTO cons
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'telegram_vault_items'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) ILIKE '%savedMessageId%';
  IF cons IS NOT NULL THEN
    EXECUTE format('ALTER TABLE telegram_vault_items DROP CONSTRAINT %I', cons);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS telegram_vault_items_creator_saved_message_uidx
  ON telegram_vault_items ("creatorId", "savedMessageId")
  WHERE "savedMessageId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_vault_saved_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  "itemId" UUID REFERENCES telegram_vault_items(id) ON DELETE SET NULL,
  "savedMessageId" TEXT NOT NULL,
  "fileUniqueId" TEXT,
  kind TEXT,
  "fileName" TEXT,
  duration INT,
  width INT,
  height INT,
  "storageKey" TEXT,
  "byteSize" BIGINT,
  "migratedAt" TIMESTAMPTZ,
  "savedMessageDeletedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_vault_saved_receipts_creator_message_uidx
  ON telegram_vault_saved_receipts ("creatorId", "savedMessageId");

CREATE INDEX IF NOT EXISTS idx_telegram_vault_saved_receipts_item
  ON telegram_vault_saved_receipts ("itemId");
