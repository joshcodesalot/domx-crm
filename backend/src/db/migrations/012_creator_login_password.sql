ALTER TABLE creators ADD COLUMN IF NOT EXISTS "encryptedLoginPassword" BYTEA;
ALTER TABLE creator_connect_pending ADD COLUMN IF NOT EXISTS "encryptedLoginPassword" BYTEA;
