-- Split keyword rules into English (pre-translation) and German (post-translation)

ALTER TABLE keyword_rules
  ADD COLUMN IF NOT EXISTS "englishKeywords" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "germanKeywords" TEXT[] NOT NULL DEFAULT '{}';

UPDATE keyword_rules
SET
  "englishKeywords" = CASE
    WHEN cardinality("englishKeywords") = 0 AND cardinality(keywords) > 0 THEN keywords
    ELSE "englishKeywords"
  END,
  "germanKeywords" = CASE
    WHEN cardinality("germanKeywords") = 0 AND cardinality(keywords) > 0 THEN keywords
    ELSE "germanKeywords"
  END
WHERE cardinality(keywords) > 0;

ALTER TABLE keyword_rules
  DROP CONSTRAINT IF EXISTS keyword_rules_keywords_nonempty;

ALTER TABLE keyword_rules
  DROP CONSTRAINT IF EXISTS keyword_rules_en_de_nonempty;

ALTER TABLE keyword_rules
  ADD CONSTRAINT keyword_rules_en_de_nonempty
  CHECK (
    cardinality("englishKeywords") > 0
    OR cardinality("germanKeywords") > 0
  );

ALTER TABLE moderation_events
  ADD COLUMN IF NOT EXISTS "matchedStage" TEXT
    CHECK ("matchedStage" IS NULL OR "matchedStage" IN ('english', 'german'));
