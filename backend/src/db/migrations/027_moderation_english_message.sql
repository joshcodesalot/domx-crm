-- Store pre-translation English draft alongside final German/outbound message

ALTER TABLE moderation_events
  ADD COLUMN IF NOT EXISTS "englishMessageText" TEXT NOT NULL DEFAULT '';
