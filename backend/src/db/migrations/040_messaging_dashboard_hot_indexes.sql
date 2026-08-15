CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_creator_fan_sent
  ON messaging_dashboard_entries ("creatorId", "fanId", "sentAt" DESC);

CREATE INDEX IF NOT EXISTS idx_messaging_dashboard_creator_purchased_payout
  ON messaging_dashboard_entries ("creatorId", "contentType", purchased, "payoutVerified")
  WHERE purchased = true;
