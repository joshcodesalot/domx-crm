-- Local chat archive for review and AI export. History is captured as DomX
-- loads or sends messages. This backfill copies outbound rows already stored
-- on the sales ledger. It does not pull fan replies from the platforms.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION fan_archive_search_text(a text, b text, c text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(string_agg(part, E'\n' ORDER BY ord), '')
  FROM (
    SELECT DISTINCT ON (norm) norm AS part, ord
    FROM (
      SELECT lower(btrim(val)) AS norm, ord
      FROM unnest(ARRAY[a, b, c]) WITH ORDINALITY AS t(val, ord)
    ) raw
    WHERE norm <> ''
    ORDER BY norm, ord
  ) deduped;
$$;

CREATE TABLE IF NOT EXISTS fan_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creatorId" UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based', 'telegram', 'fansly')),
  "platformChatId" TEXT NOT NULL,
  "platformFanId" TEXT NOT NULL DEFAULT '',
  "fanUsername" TEXT,
  "fanLabel" TEXT NOT NULL DEFAULT '',
  "lastMessageAt" TIMESTAMPTZ,
  "lastMessagePreview" TEXT NOT NULL DEFAULT '',
  "messageCount" INT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("creatorId", platform, "platformChatId")
);

CREATE INDEX IF NOT EXISTS fan_conversations_creator_last
  ON fan_conversations ("creatorId", "lastMessageAt" DESC);

CREATE TABLE IF NOT EXISTS fan_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL REFERENCES fan_conversations(id) ON DELETE CASCADE,
  "platformMessageId" TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  "senderRole" TEXT NOT NULL CHECK ("senderRole" IN ('fan', 'creator', 'system')),
  "chatterId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "chatterName" TEXT,
  kind TEXT NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm', 'ppv', 'mass', 'system')),
  "textSent" TEXT NOT NULL DEFAULT '',
  "textEn" TEXT,
  "textDe" TEXT,
  "searchText" TEXT NOT NULL DEFAULT '',
  "hasMedia" BOOLEAN NOT NULL DEFAULT FALSE,
  "isPpv" BOOLEAN NOT NULL DEFAULT FALSE,
  "priceNet" NUMERIC,
  currency TEXT,
  "mediaJson" JSONB,
  "sentAt" TIMESTAMPTZ,
  "capturedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ,
  "translationStatus" TEXT NOT NULL DEFAULT 'skipped'
    CHECK ("translationStatus" IN ('pending', 'done', 'skipped')),
  UNIQUE ("conversationId", "platformMessageId")
);

CREATE INDEX IF NOT EXISTS fan_messages_conversation_sent
  ON fan_messages ("conversationId", "sentAt" DESC, id DESC);

CREATE INDEX IF NOT EXISTS fan_messages_sent_at
  ON fan_messages ("sentAt" DESC);

CREATE INDEX IF NOT EXISTS fan_messages_search_trgm
  ON fan_messages USING gin ("searchText" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS fan_messages_translation_pending
  ON fan_messages ("capturedAt")
  WHERE "translationStatus" = 'pending';

INSERT INTO fan_conversations (
  "creatorId",
  platform,
  "platformChatId",
  "platformFanId",
  "fanUsername",
  "fanLabel",
  "lastMessageAt",
  "lastMessagePreview",
  "messageCount"
)
SELECT
  grouped."creatorId",
  grouped.platform,
  grouped."chatId",
  COALESCE(grouped."fanId", ''),
  grouped."fanUsername",
  COALESCE(grouped."fanUsername", ''),
  grouped."lastMessageAt",
  left(COALESCE(grouped.preview, ''), 180),
  grouped.cnt
FROM (
  SELECT
    m."creatorId",
    m.platform,
    m."chatId",
    (
      array_agg(NULLIF(m."fanId", '') ORDER BY m."sentAt" DESC)
      FILTER (WHERE NULLIF(m."fanId", '') IS NOT NULL)
    )[1] AS "fanId",
    (
      array_agg(NULLIF(m."fanUsername", '') ORDER BY m."sentAt" DESC)
      FILTER (WHERE NULLIF(m."fanUsername", '') IS NOT NULL)
    )[1] AS "fanUsername",
    MAX(m."sentAt") AS "lastMessageAt",
    (
      array_agg(
        COALESCE(
          NULLIF(btrim(m."actualSentText"), ''),
          NULLIF(btrim(m."englishMessage"), ''),
          ''
        )
        ORDER BY m."sentAt" DESC
      )
    )[1] AS preview,
    COUNT(*)::int AS cnt
  FROM messaging_dashboard_entries m
  WHERE m."creatorId" IS NOT NULL
    AND COALESCE(m."chatId", '') <> ''
    AND m.platform IN ('maloum', '4based', 'telegram', 'fansly')
    AND COALESCE(m."maloumMessageId", '') <> ''
  GROUP BY m."creatorId", m.platform, m."chatId"
) grouped
ON CONFLICT ("creatorId", platform, "platformChatId") DO NOTHING;

INSERT INTO fan_messages (
  "conversationId",
  "platformMessageId",
  direction,
  "senderRole",
  "chatterId",
  "chatterName",
  kind,
  "textSent",
  "textEn",
  "textDe",
  "searchText",
  "hasMedia",
  "isPpv",
  "priceNet",
  currency,
  "mediaJson",
  "sentAt",
  "translationStatus"
)
SELECT
  c.id,
  src."platformMessageId",
  'outbound',
  'creator',
  src."chatterId",
  NULLIF(btrim(src."chatterName"), ''),
  src.kind,
  src."textSent",
  src."textEn",
  src."textDe",
  fan_archive_search_text(src."textEn", src."textDe", src."textSent"),
  src."hasMedia",
  src."isPpv",
  src."priceNet",
  src.currency,
  src."mediaJson",
  src."sentAt",
  CASE WHEN src."textDe" IS NOT NULL THEN 'done' ELSE 'skipped' END
FROM (
  SELECT
    m."creatorId",
    m.platform,
    m."chatId",
    CASE
      WHEN m.platform = '4based' AND m."maloumMessageId" LIKE '4based:%'
        THEN substring(m."maloumMessageId" FROM 8)
      WHEN m.platform = 'telegram' AND m."maloumMessageId" LIKE 'telegram:%'
        THEN substring(m."maloumMessageId" FROM 10)
      ELSE m."maloumMessageId"
    END AS "platformMessageId",
    m."chatterId",
    m."chatterName",
    CASE
      WHEN m."contentType" = 'chat_product' OR COALESCE(m."priceNet", 0) > 0 THEN 'ppv'
      ELSE 'dm'
    END AS kind,
    COALESCE(
      NULLIF(btrim(m."actualSentText"), ''),
      NULLIF(btrim(m."germanTranslatedMessage"), ''),
      NULLIF(btrim(m."englishMessage"), ''),
      ''
    ) AS "textSent",
    COALESCE(
      NULLIF(btrim(m."englishMessage"), ''),
      NULLIF(btrim(m."actualSentText"), ''),
      NULLIF(btrim(m."germanTranslatedMessage"), ''),
      ''
    ) AS "textEn",
    CASE
      WHEN NULLIF(btrim(m."germanTranslatedMessage"), '') IS NOT NULL
        AND lower(btrim(m."germanTranslatedMessage"))
          IS DISTINCT FROM lower(btrim(COALESCE(m."englishMessage", '')))
        THEN btrim(m."germanTranslatedMessage")
      ELSE NULL
    END AS "textDe",
    COALESCE(m."mediaCount", 0) > 0 AS "hasMedia",
    (m."contentType" = 'chat_product' OR COALESCE(m."priceNet", 0) > 0) AS "isPpv",
    m."priceNet",
    NULLIF(btrim(m.currency), '') AS currency,
    m."mediaJson",
    m."sentAt"
  FROM messaging_dashboard_entries m
  WHERE m."creatorId" IS NOT NULL
    AND COALESCE(m."chatId", '') <> ''
    AND m.platform IN ('maloum', '4based', 'telegram', 'fansly')
    AND COALESCE(m."maloumMessageId", '') <> ''
) src
JOIN fan_conversations c
  ON c."creatorId" = src."creatorId"
 AND c.platform = src.platform
 AND c."platformChatId" = src."chatId"
WHERE src."platformMessageId" <> ''
ON CONFLICT ("conversationId", "platformMessageId") DO NOTHING;

UPDATE fan_conversations c
SET
  "messageCount" = counts.cnt,
  "lastMessageAt" = counts.last_at,
  "updatedAt" = NOW()
FROM (
  SELECT
    "conversationId",
    COUNT(*)::int AS cnt,
    MAX("sentAt") AS last_at
  FROM fan_messages
  GROUP BY "conversationId"
) counts
WHERE c.id = counts."conversationId";
