-- Allow validation failures to mark a run rejected (no pending suggestion).

ALTER TABLE ai_runs DROP CONSTRAINT IF EXISTS ai_runs_status_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_status_check
  CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped', 'rejected'));
