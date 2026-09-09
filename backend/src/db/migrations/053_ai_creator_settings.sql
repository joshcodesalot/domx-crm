-- Per-creator AI chatter mode. All creators implicitly off until a row is written.
-- Global kill switches live in app_settings (all default false).

CREATE TABLE IF NOT EXISTS ai_creator_settings (
  "creatorId" UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off'
    CHECK (mode IN (
      'off', 'shadow', 'suggest_only',
      'auto_low_risk', 'auto', 'human_takeover'
    )),
  paused BOOLEAN NOT NULL DEFAULT false,
  "takeoverByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "takeoverAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key, value)
VALUES
  ('ai.enabled', 'false'::jsonb),
  ('ai.shadow_allowed', 'false'::jsonb),
  ('ai.suggest_allowed', 'false'::jsonb),
  ('ai.auto_send_allowed', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (slug, name, category, description)
VALUES
  (
    'ai.settings.manage',
    'Manage AI Settings',
    'AI',
    'View and change per-creator AI chatter mode and pause'
  ),
  (
    'ai.suggest.use',
    'Use AI Suggestions',
    'AI',
    'Request and view AI draft replies'
  ),
  (
    'ai.moderate',
    'Moderate AI Chatter',
    'AI',
    'Watch the AI review queue and take over conversations'
  ),
  (
    'ai.rules.manage',
    'Manage AI Rules',
    'AI',
    'Create and approve global or per-creator AI rules'
  ),
  (
    'ai.autosend.enable',
    'Enable AI Auto-Send',
    'AI',
    'Allow auto-send modes for creators (Managers and above)'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.slug IN ('owner', 'manager')
  AND p.slug IN (
    'ai.settings.manage',
    'ai.suggest.use',
    'ai.moderate',
    'ai.rules.manage',
    'ai.autosend.enable'
  )
ON CONFLICT DO NOTHING;
