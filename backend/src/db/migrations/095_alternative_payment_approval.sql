-- Chatter-filed alternative payments stay pending until a manager approves them.
-- Existing rows default to approved so current sales totals do not change.

ALTER TABLE alternative_payments
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';

ALTER TABLE alternative_payments
  DROP CONSTRAINT IF EXISTS alternative_payments_status_check;

ALTER TABLE alternative_payments
  ADD CONSTRAINT alternative_payments_status_check
  CHECK (status IN ('pending', 'approved'));

ALTER TABLE alternative_payments
  ADD COLUMN IF NOT EXISTS "approvedBy" UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE alternative_payments
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alternative_payments_status
  ON alternative_payments (status);
