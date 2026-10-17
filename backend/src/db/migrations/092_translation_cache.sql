-- Reuse German-to-English results so the chat overlay and the archive
-- worker do not pay Google twice for the same text.

CREATE TABLE IF NOT EXISTS translation_cache (
  "sourceHash" TEXT PRIMARY KEY,
  "sourceLang" TEXT NOT NULL,
  "targetLang" TEXT NOT NULL,
  "sourceText" TEXT NOT NULL,
  "translatedText" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
