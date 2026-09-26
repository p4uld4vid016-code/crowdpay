-- Refund workflow enhancements
ALTER TABLE creator_refunds
  ADD COLUMN IF NOT EXISTS admin_note TEXT,
  ADD COLUMN IF NOT EXISTS is_force_refund BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS tx_hash TEXT;

ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(20, 7) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_status TEXT DEFAULT 'none' CHECK (refund_status IN ('none','partial','full'));

CREATE INDEX IF NOT EXISTS idx_creator_refunds_campaign ON creator_refunds (campaign_id);
CREATE INDEX IF NOT EXISTS idx_creator_refunds_contribution ON creator_refunds (contribution_id);
CREATE INDEX IF NOT EXISTS idx_creator_refunds_status ON creator_refunds (status);
CREATE INDEX IF NOT EXISTS idx_contributions_refund_status ON contributions (refund_status);
