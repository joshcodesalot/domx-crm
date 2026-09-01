-- Shared Telegram fan notes keyed by Telegram user/group id (not per creator).

CREATE TABLE IF NOT EXISTS telegram_fan_notes (
  "telegramUserId" TEXT PRIMARY KEY,
  notes TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO telegram_fan_notes ("telegramUserId", notes, "updatedAt")
SELECT DISTINCT ON ("telegramUserId")
  "telegramUserId",
  notes,
  "updatedAt"
FROM telegram_fan_profiles
WHERE BTRIM(notes) <> ''
ORDER BY "telegramUserId", "updatedAt" DESC, length(notes) DESC
ON CONFLICT ("telegramUserId") DO NOTHING;

ALTER TABLE telegram_fan_profiles
  DROP COLUMN IF EXISTS notes;
