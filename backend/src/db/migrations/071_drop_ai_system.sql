-- Drop AI chatter tables, settings, and permissions.

DROP TABLE IF EXISTS ai_sop_import_drafts CASCADE;
DROP TABLE IF EXISTS ai_sops CASCADE;
DROP TABLE IF EXISTS ai_rule_suggestions CASCADE;
DROP TABLE IF EXISTS ai_rules CASCADE;
DROP TABLE IF EXISTS ai_usage CASCADE;
DROP TABLE IF EXISTS ai_fan_memories CASCADE;
DROP TABLE IF EXISTS ai_conversation_summaries CASCADE;
DROP TABLE IF EXISTS ai_conversation_state_history CASCADE;
DROP TABLE IF EXISTS ai_suggestions CASCADE;
DROP TABLE IF EXISTS ai_runs CASCADE;
DROP TABLE IF EXISTS ai_messages CASCADE;
DROP TABLE IF EXISTS ai_conversations CASCADE;
DROP TABLE IF EXISTS ai_creator_profiles CASCADE;
DROP TABLE IF EXISTS ai_creator_settings CASCADE;

DELETE FROM app_settings
WHERE key IN (
  'ai.enabled',
  'ai.shadow_allowed',
  'ai.suggest_allowed',
  'ai.auto_send_allowed'
);

DELETE FROM role_permissions
WHERE "permissionId" IN (
  SELECT id FROM permissions
  WHERE slug IN (
    'ai.settings.manage',
    'ai.suggest.use',
    'ai.moderate',
    'ai.rules.manage',
    'ai.autosend.enable'
  )
);

DELETE FROM permissions
WHERE slug IN (
  'ai.settings.manage',
  'ai.suggest.use',
  'ai.moderate',
  'ai.rules.manage',
  'ai.autosend.enable'
);
