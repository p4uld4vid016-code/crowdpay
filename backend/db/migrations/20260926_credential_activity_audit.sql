BEGIN;

-- Ensure audit_logs has the necessary index for credential activity queries
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS audit_logs_actor_resource_idx ON audit_logs (actor_id, resource_type, created_at DESC);

COMMIT;
