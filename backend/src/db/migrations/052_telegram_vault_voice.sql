ALTER TABLE telegram_vault_items
  DROP CONSTRAINT IF EXISTS telegram_vault_items_kind_check;

ALTER TABLE telegram_vault_items
  ADD CONSTRAINT telegram_vault_items_kind_check
  CHECK (kind IN ('photo', 'video', 'voice'));
