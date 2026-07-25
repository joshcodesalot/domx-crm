-- 4based tip/sale activity amounts were stored with ledger sign (negative)
-- and sometimes with EUR currency. Normalize to positive USD.
-- Idempotent: safe to re-run (migrate.js applies all SQL files each time).

UPDATE messaging_dashboard_entries AS m
SET
  "priceNet" = CASE
    WHEN m."priceNet" IS NOT NULL AND m."priceNet" < 0 THEN ABS(m."priceNet")
    ELSE m."priceNet"
  END,
  currency = 'USD',
  "updatedAt" = NOW()
FROM creators c
WHERE m."creatorId" = c.id
  AND (
    c.platform = '4based'
    OR m."maloumMessageId" LIKE '4based%'
    OR m."chatId" LIKE '4based%'
  )
  AND (
    m.currency IS DISTINCT FROM 'USD'
    OR (m."priceNet" IS NOT NULL AND m."priceNet" < 0)
  );
