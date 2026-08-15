-- Allow recovered 4based send rows (chat lookup after a payout match).
-- migrate.js re-runs every file; drop + add keeps the check current.

ALTER TABLE messaging_dashboard_entries
  ALTER COLUMN "chatterName" DROP NOT NULL;

ALTER TABLE messaging_dashboard_entries
  DROP CONSTRAINT IF EXISTS messaging_dashboard_entries_attribution_source_check;

ALTER TABLE messaging_dashboard_entries
  ADD CONSTRAINT messaging_dashboard_entries_attribution_source_check
  CHECK (
    "attributionSource" IS NULL
    OR "attributionSource" IN (
      'send_log',
      'deleted_import',
      'orphan_sale',
      'chat_recovered'
    )
  );
