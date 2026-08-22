-- Allow Telegram outgoing unsends on the shared audit table.
-- migrate.js re-runs every file; drop + add keeps the platform check current.

ALTER TABLE message_unsends
  DROP CONSTRAINT IF EXISTS message_unsends_platform_check;

ALTER TABLE message_unsends
  ADD CONSTRAINT message_unsends_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));
