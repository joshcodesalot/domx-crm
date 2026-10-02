-- Fan-panel audit: renames, note changes, and list membership changes.

CREATE TABLE IF NOT EXISTS fan_crm_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "chatterId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "chatterName" TEXT NOT NULL,
  "creatorId" UUID REFERENCES creators(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('maloum', '4based', 'telegram')),
  "fanId" TEXT NOT NULL DEFAULT '',
  "fanLabel" TEXT NOT NULL DEFAULT '',
  "chatId" TEXT,
  action TEXT NOT NULL CHECK (
    action IN (
      'rename',
      'note_add',
      'note_remove',
      'note_edit',
      'list_add',
      'list_remove',
      'list_bulk_add'
    )
  ),
  "previousValue" TEXT NOT NULL DEFAULT '',
  "nextValue" TEXT NOT NULL DEFAULT '',
  "listId" TEXT,
  "listName" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fan_crm_events_created_at_idx
  ON fan_crm_events ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS fan_crm_events_chatter_created_idx
  ON fan_crm_events ("chatterId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS fan_crm_events_creator_created_idx
  ON fan_crm_events ("creatorId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS fan_crm_events_action_created_idx
  ON fan_crm_events (action, "createdAt" DESC);
