-- Preserve messaging/sales ledger when staff or creators are hard-deleted.
-- Denormalize platform so net take rates still work after creator rows are gone.

ALTER TABLE messaging_dashboard_entries
  ADD COLUMN IF NOT EXISTS platform TEXT;

UPDATE messaging_dashboard_entries m
SET platform = c.platform
FROM creators c
WHERE m."creatorId" = c.id
  AND (m.platform IS NULL OR m.platform = '');

UPDATE messaging_dashboard_entries
SET platform = 'maloum'
WHERE platform IS NULL OR platform = '';

ALTER TABLE messaging_dashboard_entries
  ALTER COLUMN platform SET DEFAULT 'maloum';

ALTER TABLE messaging_dashboard_entries
  ALTER COLUMN platform SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messaging_dashboard_entries_platform_check'
  ) THEN
    ALTER TABLE messaging_dashboard_entries
      ADD CONSTRAINT messaging_dashboard_entries_platform_check
      CHECK (platform IN ('maloum', '4based'));
  END IF;
END $$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'messaging_dashboard_entries'
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE '%creatorId%'
  LOOP
    EXECUTE format(
      'ALTER TABLE messaging_dashboard_entries DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;

  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'messaging_dashboard_entries'
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE '%chatterId%'
  LOOP
    EXECUTE format(
      'ALTER TABLE messaging_dashboard_entries DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;
END $$;

ALTER TABLE messaging_dashboard_entries
  ALTER COLUMN "creatorId" DROP NOT NULL;

ALTER TABLE messaging_dashboard_entries
  ALTER COLUMN "chatterId" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messaging_dashboard_entries_creatorId_fkey'
  ) THEN
    ALTER TABLE messaging_dashboard_entries
      ADD CONSTRAINT messaging_dashboard_entries_creatorId_fkey
      FOREIGN KEY ("creatorId") REFERENCES creators(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messaging_dashboard_entries_chatterId_fkey'
  ) THEN
    ALTER TABLE messaging_dashboard_entries
      ADD CONSTRAINT messaging_dashboard_entries_chatterId_fkey
      FOREIGN KEY ("chatterId") REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'maloum_sent_messages'
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE '%creatorId%'
  LOOP
    EXECUTE format(
      'ALTER TABLE maloum_sent_messages DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;

  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'maloum_sent_messages'
      AND con.contype = 'f'
      AND pg_get_constraintdef(con.oid) LIKE '%sentByUserId%'
  LOOP
    EXECUTE format(
      'ALTER TABLE maloum_sent_messages DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;
END $$;

ALTER TABLE maloum_sent_messages
  ALTER COLUMN "creatorId" DROP NOT NULL;

ALTER TABLE maloum_sent_messages
  ALTER COLUMN "sentByUserId" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'maloum_sent_messages_creatorId_fkey'
  ) THEN
    ALTER TABLE maloum_sent_messages
      ADD CONSTRAINT maloum_sent_messages_creatorId_fkey
      FOREIGN KEY ("creatorId") REFERENCES creators(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'maloum_sent_messages_sentByUserId_fkey'
  ) THEN
    ALTER TABLE maloum_sent_messages
      ADD CONSTRAINT maloum_sent_messages_sentByUserId_fkey
      FOREIGN KEY ("sentByUserId") REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
