-- Fansly chat sends, tips, and purchase logs write platform = 'fansly'
-- onto messaging_dashboard_entries. The Telegram-era check still rejected it.

ALTER TABLE messaging_dashboard_entries
  DROP CONSTRAINT IF EXISTS messaging_dashboard_entries_platform_check;

ALTER TABLE messaging_dashboard_entries
  ADD CONSTRAINT messaging_dashboard_entries_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram', 'fansly'));
