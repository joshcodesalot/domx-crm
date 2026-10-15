-- Short-lived API and worker signals for the owner ops view.
-- Rows older than 14 days are deleted by the API process.

CREATE TABLE IF NOT EXISTS ops_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "time" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind TEXT NOT NULL CHECK (kind IN ('error', 'slow_request', 'heartbeat')),
  process TEXT NOT NULL DEFAULT 'api',
  source TEXT NOT NULL DEFAULT '',
  method TEXT,
  path TEXT,
  status INT,
  "durationMs" INT,
  message TEXT,
  details JSONB
);

CREATE INDEX IF NOT EXISTS ops_events_time_idx
  ON ops_events ("time" DESC);

CREATE INDEX IF NOT EXISTS ops_events_kind_idx
  ON ops_events (kind);
