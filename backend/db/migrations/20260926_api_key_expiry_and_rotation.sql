BEGIN;

-- Add expiry and rotation fields to api_keys (#822, #823)
ALTER TABLE api_keys
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN predecessor_id UUID REFERENCES api_keys(id),
  ADD COLUMN successor_id UUID REFERENCES api_keys(id),
  ADD COLUMN rotation_state TEXT CHECK (rotation_state IN ('active', 'rotating', 'expired', 'revoked')) DEFAULT 'active';

-- Set default expiry for existing keys (90 days from now)
UPDATE api_keys SET expires_at = NOW() + INTERVAL '90 days' WHERE expires_at IS NULL;

-- Index for efficient expiry checks during authentication
CREATE INDEX IF NOT EXISTS api_keys_expires_idx ON api_keys (expires_at) WHERE expires_at IS NOT NULL;

-- Index for rotation state lookups
CREATE INDEX IF NOT EXISTS api_keys_rotation_idx ON api_keys (rotation_state) WHERE rotation_state = 'rotating';

COMMIT;
