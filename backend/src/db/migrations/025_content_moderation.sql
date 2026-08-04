-- Rule-based keyword content moderation (1:1 chat sends)

CREATE TABLE IF NOT EXISTS keyword_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT '',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  "matchMode" TEXT NOT NULL DEFAULT 'whole_word'
    CHECK ("matchMode" IN ('contains', 'whole_word')),
  "caseSensitive" BOOLEAN NOT NULL DEFAULT FALSE,
  actions TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT keyword_rules_actions_nonempty CHECK (cardinality(actions) > 0),
  CONSTRAINT keyword_rules_keywords_nonempty CHECK (cardinality(keywords) > 0)
);

CREATE INDEX IF NOT EXISTS idx_keyword_rules_enabled
  ON keyword_rules (enabled)
  WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS moderation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ruleId" UUID REFERENCES keyword_rules(id) ON DELETE SET NULL,
  "matchedKeyword" TEXT NOT NULL DEFAULT '',
  "actionsTaken" TEXT[] NOT NULL DEFAULT '{}',
  "userId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "creatorId" UUID REFERENCES creators(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based')),
  "chatId" TEXT,
  "fanId" TEXT,
  "fanUsername" TEXT,
  "messageText" TEXT NOT NULL DEFAULT '',
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'reviewed', 'dismissed')),
  "reviewedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "reviewedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_events_status_created
  ON moderation_events (status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_moderation_events_platform
  ON moderation_events (platform);

CREATE INDEX IF NOT EXISTS idx_moderation_events_creator
  ON moderation_events ("creatorId");

INSERT INTO permissions (slug, name, category, description)
VALUES
  (
    'moderation.manage',
    'Manage Keyword Rules',
    'App',
    'Create, edit, and remove keyword moderation rules (Managers and above)'
  ),
  (
    'moderation.review',
    'Review Moderation Events',
    'App',
    'View and resolve keyword moderation review queue (Managers and above)'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager')
  AND p.slug IN ('moderation.manage', 'moderation.review')
ON CONFLICT DO NOTHING;
