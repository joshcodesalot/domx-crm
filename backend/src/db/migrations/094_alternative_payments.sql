-- Off-platform sales (PayPal, Revolut, Amazon, Bitcoin) and a ledger platform
-- so those amounts can count at 100% without using a creator platform cut.

ALTER TABLE messaging_dashboard_entries
  DROP CONSTRAINT IF EXISTS messaging_dashboard_entries_platform_check;

ALTER TABLE messaging_dashboard_entries
  ADD CONSTRAINT messaging_dashboard_entries_platform_check
  CHECK (platform IN ('maloum', '4based', 'telegram', 'fansly', 'alternative'));

CREATE SEQUENCE IF NOT EXISTS alternative_payment_sale_seq START 1;

CREATE TABLE IF NOT EXISTS alternative_payments (
  id UUID PRIMARY KEY,
  "saleCode" TEXT NOT NULL UNIQUE,
  "saleDate" DATE NOT NULL,
  "fanName" TEXT,
  "creatorId" UUID REFERENCES creators(id) ON DELETE SET NULL,
  "creatorName" TEXT,
  "chatterId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "chatterName" TEXT,
  "paymentMethod" TEXT NOT NULL
    CHECK ("paymentMethod" IN ('revolut', 'amazon', 'paypal', 'bitcoin')),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR', 'USD')),
  notes TEXT,
  "messagingEntryId" UUID REFERENCES messaging_dashboard_entries(id) ON DELETE SET NULL,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "updatedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alternative_payments_sale_date
  ON alternative_payments ("saleDate" DESC);

CREATE INDEX IF NOT EXISTS idx_alternative_payments_chatter
  ON alternative_payments ("chatterId");

CREATE INDEX IF NOT EXISTS idx_alternative_payments_creator
  ON alternative_payments ("creatorId");

CREATE INDEX IF NOT EXISTS idx_alternative_payments_method
  ON alternative_payments ("paymentMethod");
