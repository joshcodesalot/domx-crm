-- Unlock Telegram on creator chat scripts. migrate.js re-runs every file;
-- drop + add keeps the platform checks current.

ALTER TABLE creator_script_folders
  DROP CONSTRAINT IF EXISTS creator_script_folders_platform_check;

ALTER TABLE creator_script_folders
  ADD CONSTRAINT creator_script_folders_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));

ALTER TABLE creator_scripts
  DROP CONSTRAINT IF EXISTS creator_scripts_platform_check;

ALTER TABLE creator_scripts
  ADD CONSTRAINT creator_scripts_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));

ALTER TABLE creator_script_sends
  DROP CONSTRAINT IF EXISTS creator_script_sends_platform_check;

ALTER TABLE creator_script_sends
  ADD CONSTRAINT creator_script_sends_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram'));
